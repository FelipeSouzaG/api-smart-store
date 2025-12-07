
import express from 'express';
const router = express.Router();
import CashTransaction from '../models/CashTransaction.js';
import CreditCardTransaction from '../models/CreditCardTransaction.js';
import FinancialAccount from '../models/FinancialAccount.js';
import { protect, authorize } from '../middleware/authMiddleware.js';
import { TransactionType, TransactionCategory, TransactionStatus } from '../types.js';
import { syncInvoiceRecord } from '../utils/financeHelpers.js';

// GET all transactions (Scoped by Tenant)
// Only returns CashTransactions (Actual cash flow + Invoice Aggregates)
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

  const competenceDate = timestamp ? new Date(timestamp) : new Date();

  try {
    // 1. Check for Credit Card Logic (Independent of status passed by frontend, though intent is Paid/Pending via CC)
    if (financialAccountId && financialAccountId !== 'cash-box' && paymentMethodId) {
        const account = await FinancialAccount.findOne({ _id: financialAccountId, tenantId: req.tenantId });
        const methodRule = account?.paymentMethods.find(m => m.id === paymentMethodId || (m._id && m._id.toString() === paymentMethodId));

        if (methodRule && methodRule.type === 'Credit') {
            // --- CREDIT CARD: Save to CreditCardTransaction & Sync Invoice ---
            const numInstallments = installments && installments > 0 ? parseInt(installments) : 1;
            const installmentValue = amount / numInstallments;
            
            const closingDay = methodRule.closingDay || 1;
            const dueDay = methodRule.dueDay || 10;

            const purchaseDay = competenceDate.getUTCDate();
            let targetMonth = competenceDate.getUTCMonth();
            let targetYear = competenceDate.getUTCFullYear();

            if (purchaseDay >= closingDay) {
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
                    timestamp: competenceDate,
                    dueDate: autoDueDate,
                    financialAccountId,
                    paymentMethodId,
                    installmentNumber: i + 1,
                    totalInstallments: numInstallments,
                    source: 'manual'
                });
            }

            await CreditCardTransaction.insertMany(ccTransactions);

            // Sync Invoices for all affected dates
            for (const dateStr of affectedDueDates) {
                await syncInvoiceRecord(req.tenantId, financialAccountId, paymentMethodId, new Date(dateStr));
            }

            // Return early to prevent saving to CashTransaction
            return res.status(201).json({ message: "Lançado no cartão e faturas atualizadas." });
        }
    }

    // 2. Default Behavior (Cash Box, Bank-Debit, Bank-Pix) -> CashTransaction
    const transaction = new CashTransaction({
        description,
        amount,
        category,
        type: TransactionType.EXPENSE,
        tenantId: req.tenantId,
        timestamp: competenceDate,
        financialAccountId: financialAccountId === 'cash-box' ? 'cash-box' : financialAccountId,
        paymentMethodId: financialAccountId === 'cash-box' ? undefined : paymentMethodId,
        status: status,
        dueDate: dueDate ? new Date(dueDate) : undefined,
        paymentDate: paymentDate ? new Date(paymentDate) : undefined
    });
    
    if (transaction.status === TransactionStatus.PAID && !transaction.paymentDate) {
        transaction.paymentDate = new Date();
    }

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

        // Update the Aggregate Invoice Record
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
  const { tenantId, description, amount, category, financialAccountId, paymentMethodId, installments, timestamp, status, ...otherData } = req.body;
  const competenceDate = timestamp ? new Date(timestamp) : new Date();

  try {
    // 1. Check if it is an Invoice Record (Auto-generated)
    const existing = await CashTransaction.findOne({ _id: req.params.id, tenantId: req.tenantId });
    if(existing && existing.isInvoice) {
         // Allow only status/paymentDate update
         existing.status = status || existing.status;
         existing.paymentDate = otherData.paymentDate || existing.paymentDate;
         await existing.save();
         return res.json(existing);
    }

    if (!existing) return res.status(404).json({ message: 'Transaction not found' });

    // 2. Logic: Moving from Cash to Credit Card?
    // If the new update has credit card details, we must DELETE this CashTransaction and CREATE CreditCardTransactions.
    if (financialAccountId && financialAccountId !== 'cash-box' && paymentMethodId) {
        const account = await FinancialAccount.findOne({ _id: financialAccountId, tenantId: req.tenantId });
        const methodRule = account?.paymentMethods.find(m => m.id === paymentMethodId || (m._id && m._id.toString() === paymentMethodId));

        if (methodRule && methodRule.type === 'Credit') {
             // DELETE original CashTransaction
             await CashTransaction.deleteOne({ _id: req.params.id });

             // CREATE CreditCardTransaction logic (Duplicate from POST)
             const numInstallments = installments && installments > 0 ? parseInt(installments) : 1;
             const installmentValue = amount / numInstallments;
             
             const closingDay = methodRule.closingDay || 1;
             const dueDay = methodRule.dueDay || 10;

             const purchaseDay = competenceDate.getUTCDate();
             let targetMonth = competenceDate.getUTCMonth();
             let targetYear = competenceDate.getUTCFullYear();

             if (purchaseDay >= closingDay) {
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
                     timestamp: competenceDate,
                     dueDate: autoDueDate,
                     financialAccountId,
                     paymentMethodId,
                     installmentNumber: i + 1,
                     totalInstallments: numInstallments,
                     source: 'manual'
                 });
             }

             await CreditCardTransaction.insertMany(ccTransactions);

             // Sync Invoices for all affected dates
             for (const dateStr of affectedDueDates) {
                 await syncInvoiceRecord(req.tenantId, financialAccountId, paymentMethodId, new Date(dateStr));
             }

             return res.json({ message: "Transação movida para cartão de crédito." });
        }
    }

    // 3. Normal Update (Cash/Debit/Pix/Pending)
    // Only update fields that are passed
    const updatePayload = {
        description, amount, category, financialAccountId, paymentMethodId, timestamp: competenceDate, status, ...otherData
    };
    
    // Ensure dates are parsed if present
    if (otherData.dueDate) updatePayload.dueDate = new Date(otherData.dueDate);
    if (otherData.paymentDate) updatePayload.paymentDate = new Date(otherData.paymentDate);

    const updatedTransaction = await CashTransaction.findOneAndUpdate(
      { _id: req.params.id, tenantId: req.tenantId },
      updatePayload,
      { new: true }
    );

    res.json(updatedTransaction);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// DELETE a transaction
router.delete('/:id', protect, authorize('owner', 'manager'), async (req, res) => {
  try {
    const transaction = await CashTransaction.findOne({ _id: req.params.id, tenantId: req.tenantId });
    if (!transaction) return res.status(404).json({ message: 'Not found' });

    if(transaction.isInvoice) {
        return res.status(403).json({ message: "Não é possível excluir uma fatura consolidada diretamente. Exclua os itens individuais no menu Financeiro." });
    }

    await CashTransaction.deleteOne({ _id: req.params.id });
    res.json({ message: 'Transaction deleted successfully' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

export default router;
