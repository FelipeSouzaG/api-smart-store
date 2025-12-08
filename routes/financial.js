
import express from 'express';
const router = express.Router();
import FinancialAccount from '../models/FinancialAccount.js';
import CreditCardTransaction from '../models/CreditCardTransaction.js';
import CashTransaction from '../models/CashTransaction.js';
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

// GET Credit Card Transactions (Statement)
// Returns individual credit card purchases/costs from BOTH collections
router.get('/statement', protect, authorize('owner', 'manager'), async (req, res) => {
    const { accountId, methodId } = req.query;
    
    // Default filters
    const ccQuery = { tenantId: req.tenantId };
    const cashQuery = { tenantId: req.tenantId, isInvoice: false };

    if (accountId) {
        ccQuery.financialAccountId = accountId;
        cashQuery.financialAccountId = accountId;
    }
    if (methodId) {
        ccQuery.paymentMethodId = methodId;
        cashQuery.paymentMethodId = methodId;
    }

    try {
        // 1. Fetch from CreditCardTransaction (Purchases, OS)
        const ccItems = await CreditCardTransaction.find(ccQuery).lean();

        // 2. Fetch from CashTransaction (Manual Costs with Credit Card)
        // We must unwind the installments to match the flat structure of the statement
        const cashDocs = await CashTransaction.find(cashQuery).lean();
        
        const cashItemsFlat = [];
        cashDocs.forEach(doc => {
            // Only include docs that actually have installments (Credit structure)
            if (doc.installments && doc.installments.length > 0) {
                doc.installments.forEach(inst => {
                    cashItemsFlat.push({
                        _id: `${doc._id}_${inst.number}`, // Virtual ID
                        id: `${doc._id}_${inst.number}`,
                        description: `${doc.description} (${inst.number}/${doc.installments.length})`,
                        amount: inst.amount,
                        category: doc.category,
                        timestamp: doc.timestamp,
                        dueDate: inst.dueDate, // The specific installment due date
                        financialAccountId: doc.financialAccountId,
                        paymentMethodId: doc.paymentMethodId,
                        installmentNumber: inst.number,
                        totalInstallments: doc.installments.length,
                        source: 'manual'
                    });
                });
            }
        });

        // 3. Merge and Sort
        const allItems = [...ccItems, ...cashItemsFlat].sort((a, b) => {
            // Sort by Purchase Date DESC, then Due Date DESC
            const dateA = new Date(a.timestamp).getTime();
            const dateB = new Date(b.timestamp).getTime();
            if (dateA !== dateB) return dateB - dateA;
            return new Date(b.dueDate).getTime() - new Date(a.dueDate).getTime();
        });

        res.json(allItems);
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
