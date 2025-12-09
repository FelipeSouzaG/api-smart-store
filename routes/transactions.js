
import express from 'express';
import mongoose from 'mongoose'; // Import mongoose for validation
const router = express.Router();
import CashTransaction from '../models/CashTransaction.js';
import CreditCardTransaction from '../models/CreditCardTransaction.js';
import FinancialAccount from '../models/FinancialAccount.js';
import { protect, authorize } from '../middleware/authMiddleware.js';
import { TransactionType, TransactionCategory, TransactionStatus } from '../types.js';
import { syncInvoiceRecord, updateOriginStatus } from '../utils/financeHelpers.js';

// GET all transactions (Scoped by Tenant)
router.get('/', protect, authorize('owner', 'manager'), async (req, res) => {
  try {
    const transactions = await CashTransaction.find({
      tenantId: req.tenantId,
    }).sort({ timestamp: -1 });
    res.json(transactions);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST a new transaction (for manual costs)
router.post('/', protect, authorize('owner', 'manager'), async (req, res) => {
  const { description, amount, category, paymentMethodId, installments, financialAccountId, timestamp, dueDate, paymentDate, status } = req.body;
  
  if (!description || !amount || !category) {
    return res.status(400).json({ message: 'Descrição, valor e categoria são obrigatórios.' });
  }

  // Base date used for calculation (Purchase Date/Competence)
  const competenceDate = timestamp ? new Date(timestamp) : new Date();

  try {
    // 1. Credit Card Logic
    if (financialAccountId && financialAccountId !== 'cash-box' && financialAccountId !== 'boleto' && paymentMethodId) {
        const account = await FinancialAccount.findOne({ _id: financialAccountId, tenantId: req.tenantId });
        const methodRule = account?.paymentMethods.find(m => m.id === paymentMethodId || (m._id && m._id.toString() === paymentMethodId));

        if (methodRule && methodRule.type === 'Credit') {
            const numInstallments = installments && installments > 0 ? parseInt(installments) : 1;
            const installmentValue = amount / numInstallments;
            const referenceId = `COST-${Date.now()}-${Math.floor(Math.random() * 10000)}`; 

            const closingDay = methodRule.closingDay || 1;
            const dueDay = methodRule.dueDay || 10;

            const refDate = paymentDate ? new Date(paymentDate) : competenceDate;
            const pDay = refDate.getUTCDate();
            let targetMonth = refDate.getUTCMonth();
            let targetYear = refDate.getUTCFullYear();

            if (pDay >= closingDay) {
                targetMonth += 1;
                if (targetMonth > 11) { targetMonth = 0; targetYear += 1; }
            }

            const ccTransactions = [];
            const affectedDueDates = new Set();

            for (let i = 0; i < numInstallments; i++) {
                let currentInstMonth = targetMonth + i;
                let currentInstYear = targetYear;
                while (currentInstMonth > 11) { currentInstMonth -= 12; currentInstYear += 1; }
                
                const autoDueDate = new Date(Date.UTC(currentInstYear, currentInstMonth, dueDay, 12, 0, 0));
                affectedDueDates.add(autoDueDate.toISOString());

                const instDesc = numInstallments > 1 ? `${description} (${i + 1}/${numInstallments})` : description;

                ccTransactions.push({
                    tenantId: req.tenantId,
                    description: instDesc,
                    amount: installmentValue,
                    category,
                    timestamp: refDate,
                    dueDate: autoDueDate,
                    financialAccountId,
                    paymentMethodId,
                    installmentNumber: i + 1,
                    totalInstallments: numInstallments,
                    source: 'manual',
                    referenceId
                });
            }

            await CreditCardTransaction.insertMany(ccTransactions);

            for (const dateStr of affectedDueDates) {
                await syncInvoiceRecord(req.tenantId, financialAccountId, paymentMethodId, new Date(dateStr));
            }

            return res.status(201).json({ message: "Lançado no cartão e faturas atualizadas." });
        }
    }

    // 2. Split Payment Logic (Boleto or Manual Installments) -> Single Parent Record with Installments Array
    const numInstallments = installments && installments > 0 ? parseInt(installments) : 1;
    const isSplit = numInstallments > 1;

    if (isSplit) {
        const installmentValue = amount / numInstallments;
        const baseDueDate = dueDate ? new Date(dueDate) : new Date();
        const installmentsArray = [];

        for (let i = 0; i < numInstallments; i++) {
            const instDate = new Date(baseDueDate);
            instDate.setMonth(baseDueDate.getMonth() + i);
            
            installmentsArray.push({
                number: i + 1,
                amount: installmentValue,
                dueDate: instDate,
                status: TransactionStatus.PENDING,
                paymentDate: null
            });
        }
        
        const transaction = new CashTransaction({
            tenantId: req.tenantId,
            description, 
            amount, 
            type: TransactionType.EXPENSE,
            category,
            status: TransactionStatus.PENDING, 
            timestamp: competenceDate,
            dueDate: baseDueDate,
            financialAccountId: financialAccountId === 'boleto' ? 'boleto' : (financialAccountId || 'cash-box'),
            paymentMethodId: (financialAccountId === 'cash-box' || financialAccountId === 'boleto') ? undefined : paymentMethodId,
            installments: installmentsArray // Array of installments
        });
        
        const newTransaction = await transaction.save();
        return res.status(201).json(newTransaction);
    }

    // 3. Default Single Transaction
    const transaction = new CashTransaction({
        description,
        amount,
        category,
        type: TransactionType.EXPENSE,
        tenantId: req.tenantId,
        timestamp: competenceDate,
        financialAccountId: financialAccountId === 'boleto' ? 'boleto' : (financialAccountId === 'cash-box' ? 'cash-box' : financialAccountId),
        paymentMethodId: (financialAccountId === 'cash-box' || financialAccountId === 'boleto') ? undefined : paymentMethodId,
        status: status,
        dueDate: dueDate ? new Date(dueDate) : undefined,
        paymentDate: (status === TransactionStatus.PAID) ? (paymentDate ? new Date(paymentDate) : new Date()) : undefined
    });
    
    const newTransaction = await transaction.save();
    res.status(201).json(newTransaction);

  } catch (err) {
    console.error("Error creating transaction:", err);
    res.status(400).json({ message: err.message });
  }
});

// POST Batch Pay Invoice
router.post('/pay-invoice', protect, authorize('owner', 'manager'), async (req, res) => {
    const { financialAccountId, paymentMethodId, dueDate, paymentDate } = req.body;

    if (!financialAccountId || !paymentMethodId || !dueDate || !paymentDate) {
        return res.status(400).json({ message: 'Dados insuficientes para baixar fatura.' });
    }

    try {
        const targetDate = new Date(dueDate);
        const startOfDay = new Date(targetDate.setUTCHours(0, 0, 0, 0));
        const endOfDay = new Date(targetDate.setUTCHours(23, 59, 59, 999));

        const result = await CashTransaction.findOneAndUpdate(
            {
                tenantId: req.tenantId,
                financialAccountId,
                paymentMethodId,
                isInvoice: true,
                dueDate: { $gte: startOfDay, $lte: endOfDay }
            },
            {
                $set: {
                    status: TransactionStatus.PAID,
                    paymentDate: new Date(paymentDate)
                }
            },
            { new: true }
        );

        if (!result) return res.status(404).json({ message: "Fatura não encontrada." });

        res.json({ message: 'Fatura paga.', transaction: result });

    } catch (err) {
        console.error("Error paying invoice:", err);
        res.status(500).json({ message: err.message });
    }
});

// PUT (update) a transaction using DELETE -> CREATE pattern
router.put('/:id', protect, authorize('owner', 'manager'), async (req, res) => {
  const { tenantId: _tid, description, amount, category, financialAccountId, paymentMethodId, installments, timestamp, status, dueDate, paymentDate, ...otherData } = req.body;
  
  // Use passed timestamp or keep original logic (defaults to now if missing)
  const competenceDate = timestamp ? new Date(timestamp) : new Date();

  try {
    const targetId = req.params.id;

    // --- PHASE 1: DELETE OLD RECORD(S) ---
    let deletedSomething = false;

    // Check 1: Is it a CashTransaction (ObjectId)?
    if (mongoose.Types.ObjectId.isValid(targetId)) {
        const cashT = await CashTransaction.findOne({ _id: targetId, tenantId: req.tenantId });
        if (cashT) {
            if(cashT.isInvoice) return res.status(403).json({ message: "Edite as compras individuais da fatura." });
            
            // Check specific installment update vs Full update
            // If installmentNumber is present in body, we might just be updating a sub-status.
            // However, "Delete-Create" is requested for FULL edits (changing type/values).
            // We assume Cost Modal sends a full payload.
            
            await CashTransaction.deleteOne({ _id: targetId });
            deletedSomething = true;
            
            // Sync Reverse Logic (if it was linked)
            if (cashT.purchaseId) await updateOriginStatus(req.tenantId, 'purchase', cashT.purchaseId);
        }
    }

    // Check 2: Is it a CreditCardTransaction group (Reference ID)?
    // Or if we didn't find it in Cash, maybe it was a CC Ref passed as ID
    if (!deletedSomething) {
        // If ID starts with COST- or is just a string ref
        const ccTrans = await CreditCardTransaction.find({ referenceId: targetId, tenantId: req.tenantId });
        
        if (ccTrans.length > 0) {
            if (ccTrans[0].source !== 'manual') return res.status(403).json({ message: "Edite a Compra ou OS de origem." });

            const affectedInvoices = new Set();
            ccTrans.forEach(t => affectedInvoices.add(JSON.stringify({ acc: t.financialAccountId, met: t.paymentMethodId, due: t.dueDate })));

            await CreditCardTransaction.deleteMany({ referenceId: targetId, tenantId: req.tenantId });
            deletedSomething = true;

            // Recalculate invoices
            for (const invStr of affectedInvoices) {
                const inv = JSON.parse(invStr);
                await syncInvoiceRecord(req.tenantId, inv.acc, inv.met, new Date(inv.due));
            }
        }
    }

    if (!deletedSomething) {
        return res.status(404).json({ message: "Lançamento não encontrado para edição." });
    }

    // --- PHASE 2: CREATE NEW RECORD(S) ---
    // Logic mirrored from POST to ensure consistency based on NEW payload

    // A. Credit Card Logic
    if (financialAccountId && financialAccountId !== 'cash-box' && financialAccountId !== 'boleto' && paymentMethodId) {
        const account = await FinancialAccount.findOne({ _id: financialAccountId, tenantId: req.tenantId });
        const methodRule = account?.paymentMethods.find(m => m.id === paymentMethodId || (m._id && m._id.toString() === paymentMethodId));

        if (methodRule && methodRule.type === 'Credit') {
            const numInstallments = installments && installments > 0 ? parseInt(installments) : 1;
            const installmentValue = amount / numInstallments;
            const referenceId = `COST-${Date.now()}-${Math.floor(Math.random() * 10000)}`; 

            const closingDay = methodRule.closingDay || 1;
            const dueDay = methodRule.dueDay || 10;

            const refDate = paymentDate ? new Date(paymentDate) : competenceDate;
            const pDay = refDate.getUTCDate();
            let targetMonth = refDate.getUTCMonth();
            let targetYear = refDate.getUTCFullYear();

            if (pDay >= closingDay) {
                targetMonth += 1;
                if (targetMonth > 11) { targetMonth = 0; targetYear += 1; }
            }

            const ccTransactions = [];
            const affectedDueDates = new Set();

            for (let i = 0; i < numInstallments; i++) {
                let currentInstMonth = targetMonth + i;
                let currentInstYear = targetYear;
                while (currentInstMonth > 11) { currentInstMonth -= 12; currentInstYear += 1; }
                
                const autoDueDate = new Date(Date.UTC(currentInstYear, currentInstMonth, dueDay, 12, 0, 0));
                affectedDueDates.add(autoDueDate.toISOString());

                const instDesc = numInstallments > 1 ? `${description} (${i + 1}/${numInstallments})` : description;

                ccTransactions.push({
                    tenantId: req.tenantId,
                    description: instDesc,
                    amount: installmentValue,
                    category,
                    timestamp: refDate,
                    dueDate: autoDueDate,
                    financialAccountId,
                    paymentMethodId,
                    installmentNumber: i + 1,
                    totalInstallments: numInstallments,
                    source: 'manual',
                    referenceId
                });
            }

            await CreditCardTransaction.insertMany(ccTransactions);

            for (const dateStr of affectedDueDates) {
                await syncInvoiceRecord(req.tenantId, financialAccountId, paymentMethodId, new Date(dateStr));
            }

            return res.json({ message: "Atualizado para Cartão de Crédito." });
        }
    }

    // B. Split Payment Logic (Boleto or Manual Installments)
    const numInstallments = installments && installments > 0 ? parseInt(installments) : 1;
    const isSplit = numInstallments > 1;

    if (isSplit) {
        const installmentValue = amount / numInstallments;
        const baseDueDate = dueDate ? new Date(dueDate) : new Date();
        const installmentsArray = [];

        for (let i = 0; i < numInstallments; i++) {
            const instDate = new Date(baseDueDate);
            instDate.setMonth(baseDueDate.getMonth() + i);
            
            installmentsArray.push({
                number: i + 1,
                amount: installmentValue,
                dueDate: instDate,
                status: TransactionStatus.PENDING,
                paymentDate: null
            });
        }
        
        const transaction = new CashTransaction({
            tenantId: req.tenantId,
            description, 
            amount, 
            type: TransactionType.EXPENSE,
            category,
            status: TransactionStatus.PENDING, 
            timestamp: competenceDate,
            dueDate: baseDueDate,
            financialAccountId: financialAccountId === 'boleto' ? 'boleto' : (financialAccountId || 'cash-box'),
            paymentMethodId: (financialAccountId === 'cash-box' || financialAccountId === 'boleto') ? undefined : paymentMethodId,
            installments: installmentsArray
        });
        
        const newTransaction = await transaction.save();
        return res.json(newTransaction);
    }

    // C. Default Single Transaction
    const transaction = new CashTransaction({
        description,
        amount,
        category,
        type: TransactionType.EXPENSE,
        tenantId: req.tenantId,
        timestamp: competenceDate,
        financialAccountId: financialAccountId === 'boleto' ? 'boleto' : (financialAccountId === 'cash-box' ? 'cash-box' : financialAccountId),
        paymentMethodId: (financialAccountId === 'cash-box' || financialAccountId === 'boleto') ? undefined : paymentMethodId,
        status: status,
        dueDate: dueDate ? new Date(dueDate) : undefined,
        paymentDate: (status === TransactionStatus.PAID) ? (paymentDate ? new Date(paymentDate) : new Date()) : undefined
    });
    
    const newTransaction = await transaction.save();
    return res.json(newTransaction);

  } catch (err) {
    console.error("Update Transaction Error:", err);
    res.status(400).json({ message: err.message });
  }
});

// DELETE a transaction
router.delete('/:id', protect, authorize('owner', 'manager'), async (req, res) => {
  try {
    // Only look in CashTransaction if it's a valid ObjectId
    if (mongoose.Types.ObjectId.isValid(req.params.id)) {
        const transaction = await CashTransaction.findOne({ _id: req.params.id, tenantId: req.tenantId });
        if (transaction) {
            if(transaction.isInvoice) {
                return res.status(403).json({ message: "Não é possível excluir uma fatura consolidada." });
            }
            
            const purchaseId = transaction.purchaseId;
            const serviceOrderId = transaction.serviceOrderId;

            await CashTransaction.deleteOne({ _id: req.params.id });
            
            // Sync Reverse
            if (purchaseId) await updateOriginStatus(req.tenantId, 'purchase', purchaseId);
            if (serviceOrderId) await updateOriginStatus(req.tenantId, 'service_order', serviceOrderId);

            return res.json({ message: 'Transaction deleted successfully' });
        }
    }

    // Credit Card Delete Logic
    const isRef = req.params.id.startsWith('COST-');
    const ccQuery = isRef 
        ? { referenceId: req.params.id, tenantId: req.tenantId }
        : { _id: mongoose.Types.ObjectId.isValid(req.params.id) ? req.params.id : null, tenantId: req.tenantId };

    if (!isRef && !ccQuery._id) return res.status(404).json({ message: 'Not found' });

    const ccTransaction = await CreditCardTransaction.findOne(ccQuery);
    
    if (ccTransaction) {
        if (ccTransaction.source !== 'manual') {
             return res.status(403).json({ message: "Este lançamento está vinculado a uma Compra ou OS. Exclua o registro de origem." });
        }
        
        const allInGroup = await CreditCardTransaction.find(ccQuery);
        const affectedInvoices = new Set();
        allInGroup.forEach(t => affectedInvoices.add(JSON.stringify({ acc: t.financialAccountId, met: t.paymentMethodId, due: t.dueDate })));

        await CreditCardTransaction.deleteMany(ccQuery);
        
        for (const invStr of affectedInvoices) {
            const inv = JSON.parse(invStr);
            await syncInvoiceRecord(req.tenantId, inv.acc, inv.met, new Date(inv.due));
        }

        return res.json({ message: 'Credit card cost deleted successfully' });
    }
    
    return res.status(404).json({ message: 'Not found' });

  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

export default router;
