import express from 'express';
const router = express.Router();
import CashTransaction from '../models/CashTransaction.js';
import { protect, authorize } from '../middleware/authMiddleware.js';

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
router.post('/', protect, authorize('owner', 'manager'), async (req, res) => {
  const { description, amount, category } = req.body;
  if (!description || !amount || !category) {
    return res
      .status(400)
      .json({ message: 'Descrição, valor e categoria são obrigatórios.' });
  }

  const transaction = new CashTransaction({
    ...req.body, // Spread body first
    tenantId: req.tenantId, // SECURITY: Force Tenant ID from token to overwrite any injected tenantId
    timestamp: req.body.dueDate || new Date(),
  });

  try {
    const newTransaction = await transaction.save();
    res.status(201).json(newTransaction);
  } catch (err) {
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
