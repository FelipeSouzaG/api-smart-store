
import express from 'express';
const router = express.Router();
import CashTransaction from '../models/CashTransaction.js';
import CreditCardTransaction from '../models/CreditCardTransaction.js';
import FinancialAccount from '../models/FinancialAccount.js';
import { protect, authorize } from '../middleware/authMiddleware.js';
import { TransactionType, TransactionCategory, TransactionStatus } from '../types.js';
import { syncInvoiceRecord } from '../utils/financeHelpers.js';

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
    // 1. Credit Card Logic (Unified Record)
    if (financialAccountId && financialAccountId !== 'cash-box' && financialAccountId !== 'boleto' && paymentMethodId) {
        const account = await FinancialAccount.findOne({ _id: financialAccountId, tenantId: req.tenantId });
        const methodRule = account?.paymentMethods.find(m => m.id === paymentMethodId || (m._id && m._id.toString() === paymentMethodId));

        if (methodRule && methodRule.type === 'Credit') {
            // --- CREDIT CARD: Create ONE CashTransaction with Installments & Sync Invoice ---
            const numInstallments = installments && installments > 0 ? parseInt(installments) : 1;
            const installmentValue = amount / numInstallments;
            
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

            const installmentsArray = [];
            const affectedDueDates = new Set();

            for (let i = 0; i < numInstallments; i++) {
                let currentInstMonth = targetMonth + i;
                let currentInstYear = targetYear;
                while (currentInstMonth > 11) { currentInstMonth -= 12; currentInstYear += 1; }
                
                const autoDueDate = new Date(Date.UTC(currentInstYear, currentInstMonth, dueDay, 12, 0, 0));
                affectedDueDates.add(autoDueDate.toISOString());

                installmentsArray.push({
                    number: i + 1,
                    amount: installmentValue,
                    dueDate: autoDueDate,
                    status: TransactionStatus.PENDING, // Pending inside the invoice
                    paymentDate: null
                });
            }

            // Create ONE parent record
            const transaction = new CashTransaction({
                tenantId: req.tenantId,
                description,
                amount,
                type: TransactionType.EXPENSE,
                category,
                status: TransactionStatus.PAID, // User marks as PAID (credit card usage), but cash flow is via invoice
                timestamp: competenceDate,
                paymentDate: refDate, // Date of purchase
                financialAccountId,
                paymentMethodId,
                installments: installmentsArray
            });

            await transaction.save();

            // Sync Invoices for all affected dates
            for (const dateStr of affectedDueDates) {
                await syncInvoiceRecord(req.tenantId, financialAccountId, paymentMethodId, new Date(dateStr));
            }

            return res.status(201).json({ message: "Lançado no cartão e faturas atualizadas." });
        }
    }

    // 2. Split Payment Logic (Boleto or Bank with Installments > 1) -> Create ONE CashTransaction with installments array
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
        return res.status(201).json(newTransaction);
    }

    // 3. Default Behavior (Single Payment)
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

// PUT (update) a transaction
router.put('/:id', protect, authorize('owner', 'manager'), async (req, res) => {
  const { tenantId, description, amount, category, financialAccountId, paymentMethodId, installments, timestamp, status, installmentNumber, ...otherData } = req.body;
  const competenceDate = timestamp ? new Date(timestamp) : new Date();

  try {
    // 1. Partial Update (Specific Installment Status)
    if (installmentNumber !== undefined) {
        const doc = await CashTransaction.findOne({ _id: req.params.id, tenantId: req.tenantId });
        if (doc && doc.installments && doc.installments.length > 0) {
            const sub = doc.installments.find(i => i.number === installmentNumber);
            if (sub) {
                sub.status = status;
                if (status === TransactionStatus.PAID) {
                    sub.paymentDate = otherData.paymentDate ? new Date(otherData.paymentDate) : new Date();
                } else {
                    sub.paymentDate = null;
                }
                const allPaid = doc.installments.every(i => i.status === TransactionStatus.PAID);
                if (allPaid) doc.status = TransactionStatus.PAID;
                
                await doc.save();
                return res.json(doc);
            }
        }
    }

    // 2. Full Update Logic (Recreate)
    
    // Check existing CashTransaction
    const existingCash = await CashTransaction.findOne({ _id: req.params.id, tenantId: req.tenantId });
    if (existingCash) {
         if(existingCash.isInvoice) return res.status(403).json({ message: "Edite as compras individuais da fatura." });
         
         // If it was credit card cost before, we need to recalc invoices upon deletion
         if (existingCash.financialAccountId && existingCash.paymentMethodId && existingCash.installments?.length > 0) {
             const acc = await FinancialAccount.findOne({ _id: existingCash.financialAccountId, tenantId: req.tenantId });
             const method = acc?.paymentMethods.find(m => m.id === existingCash.paymentMethodId || m._id.toString() === existingCash.paymentMethodId);
             if (method && method.type === 'Credit') {
                 // It was a unified credit cost. Need to sync invoices after deletion.
                 const datesToSync = new Set(existingCash.installments.map(i => i.dueDate.toISOString()));
                 await CashTransaction.deleteOne({ _id: req.params.id });
                 for (const d of datesToSync) await syncInvoiceRecord(req.tenantId, existingCash.financialAccountId, existingCash.paymentMethodId, new Date(d));
             } else {
                 await CashTransaction.deleteOne({ _id: req.params.id });
             }
         } else {
             await CashTransaction.deleteOne({ _id: req.params.id });
         }
    } else {
        // Check legacy CreditCardTransaction
        const existingCC = await CreditCardTransaction.findOne({ _id: req.params.id, tenantId: req.tenantId });
        if (existingCC) {
            if (existingCC.source !== 'manual') return res.status(403).json({ message: "Edite a Compra ou OS de origem." });
            await CreditCardTransaction.deleteOne({ _id: req.params.id });
            await syncInvoiceRecord(req.tenantId, existingCC.financialAccountId, existingCC.paymentMethodId, existingCC.dueDate);
        } else {
            return res.status(404).json({ message: 'Lançamento não encontrado para edição.' });
        }
    }

    // --- RE-CREATE LOGIC (Simulating POST) ---
    
    // 2.1 Credit Card Logic (Unified)
    if (financialAccountId && financialAccountId !== 'cash-box' && financialAccountId !== 'boleto' && paymentMethodId) {
        const account = await FinancialAccount.findOne({ _id: financialAccountId, tenantId: req.tenantId });
        const methodRule = account?.paymentMethods.find(m => m.id === paymentMethodId || (m._id && m._id.toString() === paymentMethodId));

        if (methodRule && methodRule.type === 'Credit') {
            const numInstallments = installments && installments > 0 ? parseInt(installments) : 1;
            const installmentValue = amount / numInstallments;
            
            const closingDay = methodRule.closingDay || 1;
            const dueDay = methodRule.dueDay || 10;

            const refDate = otherData.paymentDate ? new Date(otherData.paymentDate) : competenceDate;
            const pDay = refDate.getUTCDate();
            let targetMonth = refDate.getUTCMonth();
            let targetYear = refDate.getUTCFullYear();

            if (pDay >= closingDay) {
                targetMonth += 1;
                if (targetMonth > 11) { targetMonth = 0; targetYear += 1; }
            }

            const installmentsArray = [];
            const affectedDueDates = new Set();

            for (let i = 0; i < numInstallments; i++) {
                let currentInstMonth = targetMonth + i;
                let currentInstYear = targetYear;
                while (currentInstMonth > 11) { currentInstMonth -= 12; currentInstYear += 1; }
                
                const autoDueDate = new Date(Date.UTC(currentInstYear, currentInstMonth, dueDay, 12, 0, 0));
                affectedDueDates.add(autoDueDate.toISOString());

                installmentsArray.push({
                    number: i + 1,
                    amount: installmentValue,
                    dueDate: autoDueDate,
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
                status: TransactionStatus.PAID,
                timestamp: competenceDate,
                paymentDate: refDate,
                financialAccountId,
                paymentMethodId,
                installments: installmentsArray
            });

            await transaction.save();

            for (const dateStr of affectedDueDates) {
                await syncInvoiceRecord(req.tenantId, financialAccountId, paymentMethodId, new Date(dateStr));
            }

            return res.status(201).json({ message: "Atualizado no cartão." });
        }
    }

    // 2.2 Split Logic (Boleto/Bank)
    const numInstallments = installments || 1;
    if (numInstallments > 1) {
       const installmentValue = amount / numInstallments;
       const baseDueDate = otherData.dueDate ? new Date(otherData.dueDate) : new Date();
       const installmentsArray = [];
       for (let i = 0; i < numInstallments; i++) {
           const instDate = new Date(baseDueDate);
           instDate.setMonth(baseDueDate.getMonth() + i);
           installmentsArray.push({ number: i + 1, amount: installmentValue, dueDate: instDate, status: TransactionStatus.PENDING, paymentDate: null });
       }
       const newT = new CashTransaction({
           tenantId: req.tenantId, description, amount, type: TransactionType.EXPENSE, category,
           status: TransactionStatus.PENDING, timestamp: competenceDate, dueDate: baseDueDate,
           financialAccountId: financialAccountId === 'boleto' ? 'boleto' : financialAccountId,
           paymentMethodId: financialAccountId === 'boleto' ? undefined : paymentMethodId,
           installments: installmentsArray
       });
       await newT.save();
       return res.json(newT);
    }

    // 2.3 Single
    const newT = new CashTransaction({
       tenantId: req.tenantId, description, amount, category, type: TransactionType.EXPENSE,
       timestamp: competenceDate, status,
       financialAccountId: financialAccountId === 'boleto' ? 'boleto' : (financialAccountId || 'cash-box'),
       paymentMethodId: (financialAccountId === 'cash-box' || financialAccountId === 'boleto') ? undefined : paymentMethodId,
       dueDate: otherData.dueDate ? new Date(otherData.dueDate) : undefined,
       paymentDate: status === TransactionStatus.PAID ? (otherData.paymentDate ? new Date(otherData.paymentDate) : new Date()) : undefined
    });
    await newT.save();
    return res.json(newT);

  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// DELETE a transaction
router.delete('/:id', protect, authorize('owner', 'manager'), async (req, res) => {
  try {
    const transaction = await CashTransaction.findOne({ _id: req.params.id, tenantId: req.tenantId });
    
    if (transaction) {
        if(transaction.isInvoice) {
            return res.status(403).json({ message: "Não é possível excluir uma fatura consolidada diretamente." });
        }
        
        // If it's a unified credit card transaction, sync invoices after delete
        let datesToSync = new Set();
        if (transaction.financialAccountId && transaction.paymentMethodId && transaction.installments?.length > 0) {
             const acc = await FinancialAccount.findOne({ _id: transaction.financialAccountId, tenantId: req.tenantId });
             const method = acc?.paymentMethods.find(m => m.id === transaction.paymentMethodId || m._id.toString() === transaction.paymentMethodId);
             if (method && method.type === 'Credit') {
                 transaction.installments.forEach(i => datesToSync.add(i.dueDate.toISOString()));
             }
        }

        await CashTransaction.deleteOne({ _id: req.params.id });
        
        for (const d of datesToSync) {
            await syncInvoiceRecord(req.tenantId, transaction.financialAccountId, transaction.paymentMethodId, new Date(d));
        }

        return res.json({ message: 'Transaction deleted successfully' });
    }

    // Legacy support
    const ccTransaction = await CreditCardTransaction.findOne({ _id: req.params.id, tenantId: req.tenantId });
    if (ccTransaction) {
        if (ccTransaction.source !== 'manual') {
             return res.status(403).json({ message: "Este lançamento está vinculado a uma Compra ou OS." });
        }
        await CreditCardTransaction.deleteOne({ _id: req.params.id });
        await syncInvoiceRecord(req.tenantId, ccTransaction.financialAccountId, ccTransaction.paymentMethodId, ccTransaction.dueDate);
        return res.json({ message: 'Credit card cost deleted successfully' });
    }

    return res.status(404).json({ message: 'Not found' });

  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

export default router;
