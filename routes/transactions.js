
import express from 'express';
const router = express.Router();
import CashTransaction from '../models/CashTransaction.js';
import FinancialAccount from '../models/FinancialAccount.js';
import { protect, authorize } from '../middleware/authMiddleware.js';
import { TransactionType, TransactionCategory, TransactionStatus } from '../types.js';

// GET all transactions (Scoped by Tenant)
router.get('/', protect, authorize('owner', 'manager'), async (req, res) => {
  try {
    // CRITICAL: Filter by tenantId to prevent data leakage
    const transactions = await CashTransaction.find({
      tenantId: req.tenantId,
    }).sort({ timestamp: -1 });
    res.json(transactions);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST a new transaction (for manual costs)
// UPDATED: Handle Financial Rules (Credit Card Installments)
router.post('/', protect, authorize('owner', 'manager'), async (req, res) => {
  const { description, amount, category, paymentMethodId, installments, financialAccountId } = req.body;
  
  if (!description || !amount || !category) {
    return res
      .status(400)
      .json({ message: 'Descrição, valor e categoria são obrigatórios.' });
  }

  // Base transaction structure
  const transactionBase = {
    ...req.body,
    tenantId: req.tenantId,
    timestamp: req.body.timestamp || new Date(), // Use provided timestamp or now (Launch Date)
  };

  try {
    // Special Logic for Credit Card Payment (Installments)
    if (paymentMethodId && financialAccountId && installments > 1) {
        const account = await FinancialAccount.findOne({ _id: financialAccountId, tenantId: req.tenantId });
        const methodRule = account?.paymentMethods.find(m => m.id === paymentMethodId);

        if (methodRule && methodRule.type === 'Credit') {
            const installmentValue = amount / installments;
            const newTransactions = [];
            const closingDay = methodRule.closingDay || 1;
            const dueDay = methodRule.dueDay || 10;

            // Generate transactions for each installment
            let currentRefDate = new Date();
            // Start calculation based on current date vs closing date
            if (currentRefDate.getDate() >= closingDay) {
                // If past closing, bill comes next month
                currentRefDate.setMonth(currentRefDate.getMonth() + 1);
            }

            for (let i = 0; i < installments; i++) {
                // Set due date to configured day
                const dueDate = new Date(currentRefDate.getFullYear(), currentRefDate.getMonth(), dueDay, 12, 0, 0);
                
                // If PaymentStatus is PAID, we assume user paid it NOW (pre-payment? unlikely for credit). 
                // Usually Credit Card costs are registered as Pending until bill is paid, OR Paid if reconciling old bills.
                // However, user said "Credit Inter accumulates in competency". 
                // We will create them as PENDING due to future date, or PAID if user explicitly said so (reconciling).
                // But logically, future installments are Pending.
                
                // Override status if it's future
                const status = (req.body.status === 'Pago' && i === 0 && dueDate <= new Date()) ? 'Pago' : 'Pendente'; 
                // Wait, credit card purchase creates a debt now, paid later. 
                // The logical flow: Register Cost -> Status PENDING (Waiting Bill). 
                
                newTransactions.push({
                    ...transactionBase,
                    description: `${description} (${i + 1}/${installments})`,
                    amount: installmentValue,
                    dueDate: dueDate,
                    paymentDate: status === 'Pago' ? req.body.paymentDate : null, // Only set payment date if actually paid
                    status: status
                });

                // Move to next month
                currentRefDate.setMonth(currentRefDate.getMonth() + 1);
            }

            const created = await CashTransaction.insertMany(newTransactions);
            return res.status(201).json(created[0]); // Return first as confirmation
        }
    }

    // Default Behavior (Single Transaction)
    const transaction = new CashTransaction(transactionBase);
    const newTransaction = await transaction.save();
    res.status(201).json(newTransaction);

  } catch (err) {
    console.error("Error creating transaction:", err);
    res.status(400).json({ message: err.message });
  }
});

// PUT (update) a transaction (Scoped by Tenant)
router.put('/:id', protect, authorize('owner', 'manager'), async (req, res) => {
  try {
    // SECURITY: Strip tenantId from body to prevent moving transaction to another tenant
    const { tenantId, ...updateData } = req.body;

    // Security: Ensure we only update transactions belonging to this tenant
    const updatedTransaction = await CashTransaction.findOneAndUpdate(
      { _id: req.params.id, tenantId: req.tenantId },
      updateData,
      { new: true }
    );

    if (!updatedTransaction)
      return res
        .status(404)
        .json({ message: 'Transaction not found or access denied' });
    res.json(updatedTransaction);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// DELETE a transaction (Scoped by Tenant)
router.delete(
  '/:id',
  protect,
  authorize('owner', 'manager'),
  async (req, res) => {
    try {
      // Security: Ensure we only delete transactions belonging to this tenant
      const transaction = await CashTransaction.findOneAndDelete({
        _id: req.params.id,
        tenantId: req.tenantId,
      });

      if (!transaction)
        return res
          .status(404)
          .json({ message: 'Transaction not found or access denied' });
      res.json({ message: 'Transaction deleted successfully' });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

export default router;
