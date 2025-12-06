
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

        // --- CREDIT CARD SPLIT LOGIC ---
        // Generates dynamic costs for each installment based on card cycle
        if (methodRule && methodRule.type === 'Credit') {
            const numInstallments = installments && installments > 0 ? parseInt(installments) : 1;
            const installmentValue = amount / numInstallments;
            const newTransactions = [];
            
            // Default config if missing
            const closingDay = methodRule.closingDay || 1;
            const dueDay = methodRule.dueDay || 10;

            // Calculate First Invoice Month based on Purchase Date vs Closing Date
            const purchaseDay = competenceDate.getUTCDate();
            let targetMonth = competenceDate.getUTCMonth();
            let targetYear = competenceDate.getUTCFullYear();

            // If purchase day >= closing day, the bill for this month is closed, so it goes to NEXT month
            if (purchaseDay >= closingDay) {
                targetMonth += 1;
                // Handle year rollover immediately for the start month
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
                
                // Format description with installment info and card name
                const instDesc = numInstallments > 1 
                    ? `${description} - ${methodRule.name} (${i + 1}/${numInstallments})` 
                    : `${description} - ${methodRule.name}`;

                newTransactions.push({
                    ...transactionBase,
                    description: instDesc,
                    amount: installmentValue,
                    // FORCE PENDING: Credit card purchases are accounts payable.
                    // They stay PENDING until the user manually pays the invoice transaction.
                    status: TransactionStatus.PENDING, 
                    dueDate: autoDueDate,
                    paymentDate: null // No cash outflow yet
                });
            }

            const created = await CashTransaction.insertMany(newTransactions);
            return res.status(201).json(created[0]); // Return first one for frontend feedback
        }
    }

    // 2. Default Behavior (Cash Box, Bank-Debit, Bank-Pix, or Pending Bill)
    const transaction = new CashTransaction({
        ...transactionBase,
        dueDate: dueDate ? new Date(dueDate) : undefined,
        paymentDate: paymentDate ? new Date(paymentDate) : undefined
    });
    
    // Safety Fallback: If Paid but no paymentDate, default to now
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
// Pays all transactions belonging to a specific card invoice (Account + Method + DueDate)
router.post('/pay-invoice', protect, authorize('owner', 'manager'), async (req, res) => {
    const { financialAccountId, paymentMethodId, dueDate, paymentDate } = req.body;

    if (!financialAccountId || !paymentMethodId || !dueDate || !paymentDate) {
        return res.status(400).json({ message: 'Dados insuficientes para baixar fatura.' });
    }

    try {
        // Construct date range for the Due Date (Match the specific day)
        // Since dueDate is stored as UTC Noon, we match the exact ISO string or range
        const targetDate = new Date(dueDate);
        const startOfDay = new Date(targetDate.setUTCHours(0, 0, 0, 0));
        const endOfDay = new Date(targetDate.setUTCHours(23, 59, 59, 999));

        const result = await CashTransaction.updateMany(
            {
                tenantId: req.tenantId,
                financialAccountId,
                paymentMethodId,
                status: TransactionStatus.PENDING,
                dueDate: {
                    $gte: startOfDay,
                    $lte: endOfDay
                }
            },
            {
                $set: {
                    status: TransactionStatus.PAID,
                    paymentDate: new Date(paymentDate)
                }
            }
        );

        res.json({ message: 'Fatura atualizada.', updatedCount: result.modifiedCount });

    } catch (err) {
        console.error("Error paying invoice:", err);
        res.status(500).json({ message: err.message });
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
