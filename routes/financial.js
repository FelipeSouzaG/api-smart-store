
import express from 'express';
const router = express.Router();
import FinancialAccount from '../models/FinancialAccount.js';
import CreditCardTransaction from '../models/CreditCardTransaction.js';
import { protect, authorize } from '../middleware/authMiddleware.js';

// GET all accounts
router.get('/', protect, authorize('owner', 'manager'), async (req, res) => {
  try {
    const accounts = await FinancialAccount.find({ tenantId: req.tenantId }).sort({ bankName: 1 });
    res.json(accounts);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET Credit Card Statement Items (Sub-items of an invoice)
router.get('/statement', protect, authorize('owner', 'manager'), async (req, res) => {
    const { accountId, methodId } = req.query;
    if(!accountId || !methodId) return res.status(400).json({message: "IDs required"});

    try {
        const items = await CreditCardTransaction.find({
            tenantId: req.tenantId,
            financialAccountId: accountId,
            paymentMethodId: methodId
        }).sort({ dueDate: -1, timestamp: -1 });
        
        res.json(items);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// POST new account
router.post('/', protect, authorize('owner'), async (req, res) => {
  try {
    const { bankName, receivingRules, paymentMethods } = req.body;
    
    if (!bankName) return res.status(400).json({ message: 'Nome do banco é obrigatório.' });

    const newAccount = new FinancialAccount({
      tenantId: req.tenantId,
      bankName,
      receivingRules: receivingRules || [],
      paymentMethods: paymentMethods || []
    });

    const savedAccount = await newAccount.save();
    res.status(201).json(savedAccount);
  } catch (err) {
    console.error("Erro ao salvar banco:", err);
    res.status(400).json({ message: err.message });
  }
});

// PUT update account
router.put('/:id', protect, authorize('owner'), async (req, res) => {
  try {
    const { bankName, receivingRules, paymentMethods } = req.body;
    
    const account = await FinancialAccount.findOne({ _id: req.params.id, tenantId: req.tenantId });
    if (!account) return res.status(404).json({ message: 'Conta não encontrada.' });

    if (bankName) account.bankName = bankName;
    if (receivingRules !== undefined) account.receivingRules = receivingRules;
    if (paymentMethods !== undefined) account.paymentMethods = paymentMethods;

    await account.save();
    res.json(account);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// DELETE account
router.delete('/:id', protect, authorize('owner'), async (req, res) => {
  try {
    await FinancialAccount.findOneAndDelete({ _id: req.params.id, tenantId: req.tenantId });
    res.json({ message: 'Conta removida.' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

export default router;
