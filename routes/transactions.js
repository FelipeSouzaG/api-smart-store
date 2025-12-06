
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
  // Extract fields - Note: dueDate/paymentDate might come from frontend for manual entries
  const { description, amount, category, paymentMethodId, installments, financialAccountId, timestamp, dueDate, paymentDate, status } = req.body;
  
  if (!description || !amount || !category) {
    return res.status(400).json({ message: 'Descrição, valor e categoria são obrigatórios.' });
  }

  // Competence Date (Data da Compra/Fato Gerador)
  const competenceDate = timestamp ? new Date(timestamp) : new Date();

  // Base transaction structure
  const transactionBase = {
    description,
    amount,
    category,
    type: TransactionType.EXPENSE, // Manual costs are always expense
    status, // From frontend (might be overridden for Credit Card)
    tenantId: req.tenantId,
    timestamp: competenceDate,
    financialAccountId: financialAccountId === 'cash-box' ? 'cash-box' : financialAccountId, // Persist 'cash-box' string or ID
    paymentMethodId: financialAccountId === 'cash-box' ? undefined : paymentMethodId // Clear method if cash
  };

  try {
    // 1. Check for Financial Rules (Credit Card Logic)
    // Only proceed if it is a real account (not cash-box) and has a method selected
    if (financialAccountId && financialAccountId !== 'cash-box' && paymentMethodId) {
        const account = await FinancialAccount.findOne({ _id: financialAccountId, tenantId: req.tenantId });
        const methodRule = account?.paymentMethods.find(m => m.id === paymentMethodId);

        // --- CREDIT CARD LOGIC ---
        // If it's a Credit Card, we ignore the passed dueDate/paymentDate and calculate our own based on cycle
        if (methodRule && methodRule.type === 'Credit') {
            const numInstallments = installments && installments > 0 ? installments : 1;
            const installmentValue = amount / numInstallments;
            const newTransactions = [];
            
            const closingDay = methodRule.closingDay || 1;
            const dueDay = methodRule.dueDay || 10;

            // Calculate First Due Date based on Purchase Date vs Closing Date
            // We must use the day of the purchase to compare against closing day
            const purchaseDay = competenceDate.getUTCDate(); // Use UTC date to avoid timezone shifts
            
            // Start calculation based on purchase month/year
            let targetMonth = competenceDate.getUTCMonth();
            let targetYear = competenceDate.getUTCFullYear();

            // If purchase day >= closing day, the bill for this month is closed, so it goes to NEXT month
            if (purchaseDay >= closingDay) {
                targetMonth += 1;
                if (targetMonth > 11) {
                    targetMonth = 0;
                    targetYear += 1;
                }
            }

            // Generate Installments
            for (let i = 0; i < numInstallments; i++) {
                // Calculate current installment month/year
                let currentInstMonth = targetMonth + i;
                let currentInstYear = targetYear;
                
                // Adjust for year rollover (e.g. month 13 becomes month 1 of next year)
                while (currentInstMonth > 11) {
                    currentInstMonth -= 12;
                    currentInstYear += 1;
                }
                
                // Construct specific Due Date (Noon UTC to be safe)
                const autoDueDate = new Date(Date.UTC(currentInstYear, currentInstMonth, dueDay, 12, 0, 0));
                
                newTransactions.push({
                    ...transactionBase,
                    description: numInstallments > 1 ? `${description} (${i + 1}/${numInstallments})` : description,
                    amount: installmentValue,
                    // FORCE PENDING: Credit card purchases are debts to be paid later (Accounts Payable).
                    // Even if user clicked "Paid" (meaning "I swiped the card"), the cash hasn't left the bank yet.
                    status: TransactionStatus.PENDING, 
                    dueDate: autoDueDate,
                    paymentDate: null // No cash outflow yet
                });
            }

            const created = await CashTransaction.insertMany(newTransactions);
            return res.status(201).json(created[0]); 
        }
    }

    // 2. Default Behavior (Cash Box, Bank-Debit, Bank-Pix, or Pending Bill)
    // Use the dates provided by the frontend
    const transaction = new CashTransaction({
        ...transactionBase,
        dueDate: dueDate ? new Date(dueDate) : undefined,
        paymentDate: paymentDate ? new Date(paymentDate) : undefined
    });
    
    // Safety Fallback: If Paid but no paymentDate, default to now (though frontend should block this)
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
