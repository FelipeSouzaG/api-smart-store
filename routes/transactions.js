
import express from 'express';
const router = express.Router();
import CashTransaction from '../models/CashTransaction.js';
import FinancialAccount from '../models/FinancialAccount.js';
import { protect, authorize } from '../middleware/authMiddleware.js';
import { TransactionType, TransactionCategory, TransactionStatus } from '../types.js';

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
  const { description, amount, category, paymentMethodId, installments, financialAccountId, timestamp } = req.body;
  
  if (!description || !amount || !category) {
    return res.status(400).json({ message: 'Descrição, valor e categoria são obrigatórios.' });
  }

  // Competence Date (Data da Compra/Fato Gerador)
  const competenceDate = timestamp ? new Date(timestamp) : new Date();

  // Base transaction structure
  const transactionBase = {
    ...req.body,
    tenantId: req.tenantId,
    timestamp: competenceDate,
  };

  try {
    // 1. Check for Financial Rules (Credit Card Logic)
    if (paymentMethodId && financialAccountId) {
        const account = await FinancialAccount.findOne({ _id: financialAccountId, tenantId: req.tenantId });
        const methodRule = account?.paymentMethods.find(m => m.id === paymentMethodId);

        // --- CREDIT CARD LOGIC ---
        if (methodRule && methodRule.type === 'Credit') {
            const numInstallments = installments && installments > 0 ? installments : 1;
            const installmentValue = amount / numInstallments;
            const newTransactions = [];
            
            const closingDay = methodRule.closingDay || 1;
            const dueDay = methodRule.dueDay || 10;

            // Calculate First Due Date based on Purchase Date vs Closing Date
            // Example: Buy 20th. Close 25th. Bill comes THIS month (or next month depending on due day logic).
            // Standard Logic: If Buy Date < Closing Date, it enters current cycle. If Buy Date >= Closing Date, it enters NEXT cycle.
            
            let referenceDate = new Date(competenceDate); // Start calculation from purchase date
            
            // If purchase is AFTER closing day, bump to next month's bill
            if (referenceDate.getDate() >= closingDay) {
                referenceDate.setMonth(referenceDate.getMonth() + 1);
            }

            // Generate Installments
            for (let i = 0; i < numInstallments; i++) {
                // Determine Due Date: The configured Due Day of the reference month
                // We create a new date object to avoid mutating referenceDate incorrectly in loop
                let targetMonth = referenceDate.getMonth() + i; 
                let targetYear = referenceDate.getFullYear();
                
                // Adjust year if month overflows (handled by Date constructor usually, but explicit is safer)
                const dueDate = new Date(targetYear, targetMonth, dueDay, 12, 0, 0);
                
                // Check for year rollover in case Date constructor behaves oddly with index loop
                // (Date(2023, 13, 1) becomes Feb 2024 automatically, so standard JS Date is fine)

                newTransactions.push({
                    ...transactionBase,
                    description: numInstallments > 1 ? `${description} (${i + 1}/${numInstallments})` : description,
                    amount: installmentValue,
                    // FORCE PENDING: Credit card purchases are debts to be paid later.
                    status: TransactionStatus.PENDING, 
                    dueDate: dueDate,
                    paymentDate: null, // No cash outflow yet
                    financialAccountId,
                    paymentMethodId
                });
            }

            const created = await CashTransaction.insertMany(newTransactions);
            return res.status(201).json(created[0]); 
        }
    }

    // 2. Default Behavior (Cash, Pix, Debit - Immediate or Scheduled)
    // For Debit/Pix, if status is PAID, paymentDate should be set.
    const transaction = new CashTransaction(transactionBase);
    
    // Sanity check: If Paid but no paymentDate, default to now
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

// PUT (update) a transaction
router.put('/:id', protect, authorize('owner', 'manager'), async (req, res) => {
  try {
    const { tenantId, ...updateData } = req.body;
    const updatedTransaction = await CashTransaction.findOneAndUpdate(
      { _id: req.params.id, tenantId: req.tenantId },
      updateData,
      { new: true }
    );

    if (!updatedTransaction)
      return res.status(404).json({ message: 'Transaction not found or access denied' });
    res.json(updatedTransaction);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// DELETE a transaction
router.delete('/:id', protect, authorize('owner', 'manager'), async (req, res) => {
  try {
    const transaction = await CashTransaction.findOneAndDelete({
      _id: req.params.id,
      tenantId: req.tenantId,
    });

    if (!transaction)
      return res.status(404).json({ message: 'Transaction not found or access denied' });
    res.json({ message: 'Transaction deleted successfully' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

export default router;
