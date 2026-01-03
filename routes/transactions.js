import express from 'express';
import mongoose from 'mongoose'; // Import mongoose for validation
const router = express.Router();
import CashTransaction from '../models/CashTransaction.js';
import CreditCardTransaction from '../models/CreditCardTransaction.js';
import StoreConfig from '../models/StoreConfig.js'; // NEW
import { protect, authorize } from '../middleware/authMiddleware.js';
import {
  TransactionType,
  TransactionCategory,
  TransactionStatus,
} from '../types.js';
import {
  syncInvoiceRecord,
  updateOriginStatus,
  processInvoiceStatus,
} from '../utils/financeHelpers.js';

// GET all transactions (Scoped by Tenant)
router.get('/', protect, authorize('owner', 'manager'), async (req, res) => {
  try {
    // CRITICAL: Update Invoice Statuses based on Today's Date before fetching
    await processInvoiceStatus(req.tenantId);

    const transactions = await CashTransaction.find({
      tenantId: req.tenantId,
    }).sort({ timestamp: -1 });
    res.json(transactions);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET all credit card transactions (Scoped by Tenant) - REPLACES financial/statement
router.get(
  '/credit-card',
  protect,
  authorize('owner', 'manager'),
  async (req, res) => {
    try {
      const transactions = await CreditCardTransaction.find({
        tenantId: req.tenantId,
      }).sort({ timestamp: -1 });
      res.json(transactions);
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

// Helper to create a manual transaction (Cash or Card)
const createManualTransaction = async (req, data) => {
  const {
    description,
    amount,
    category,
    installments,
    financialAccountId,
    timestamp,
    dueDate,
    paymentDate,
    status,
    referenceId,
  } = data;

  const competenceDate = timestamp ? new Date(timestamp) : new Date();
  const refId =
    referenceId || `COST-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

  // 1. Credit Card Logic (Fixed ID: 'credit-main')
  if (financialAccountId === 'credit-main') {
    const config = await StoreConfig.findOne({ tenantId: req.tenantId });
    const closingDay = config?.financialSettings?.cardClosingDay || 1;
    const dueDay = config?.financialSettings?.cardDueDay || 10;

    const numInstallments =
      installments && installments > 0 ? parseInt(installments) : 1;
    const installmentValue = amount / numInstallments;

    const refDate = paymentDate ? new Date(paymentDate) : competenceDate;
    const pDay = refDate.getUTCDate();
    let targetMonth = refDate.getUTCMonth();
    let targetYear = refDate.getUTCFullYear();

    if (pDay >= closingDay) {
      targetMonth += 1;
      if (targetMonth > 11) {
        targetMonth = 0;
        targetYear += 1;
      }
    }

    const ccTransactions = [];
    const affectedDueDates = new Set();

    for (let i = 0; i < numInstallments; i++) {
      let currentInstMonth = targetMonth + i;
      let currentInstYear = targetYear;
      while (currentInstMonth > 11) {
        currentInstMonth -= 12;
        currentInstYear += 1;
      }

      const autoDueDate = new Date(
        Date.UTC(currentInstYear, currentInstMonth, dueDay, 12, 0, 0)
      );
      affectedDueDates.add(autoDueDate.toISOString());

      ccTransactions.push({
        tenantId: req.tenantId,
        description: `${description} (${i + 1}/${numInstallments})`,
        amount: installmentValue,
        category,
        timestamp: refDate,
        dueDate: autoDueDate,
        financialAccountId: 'credit-main',
        paymentMethodId: 'default',
        installmentNumber: i + 1,
        totalInstallments: numInstallments,
        source: 'manual',
        referenceId: refId,
        status: TransactionStatus.PENDING,
      });
    }

    await CreditCardTransaction.insertMany(ccTransactions);
    for (const dateStr of affectedDueDates) {
      await syncInvoiceRecord(
        req.tenantId,
        'credit-main',
        'default',
        new Date(dateStr)
      );
    }

    const parentTransaction = new CashTransaction({
      tenantId: req.tenantId,
      description,
      amount,
      type: TransactionType.EXPENSE,
      category,
      status: TransactionStatus.PAID,
      timestamp: competenceDate,
      paymentDate: refDate,
      financialAccountId: 'credit-main',
      installments: [{ number: numInstallments, amount: amount }],
      purchaseId: refId,
    });

    return await parentTransaction.save();
  }

  // 2. Split Payment Logic (Boleto/Manual)
  const numInstallments =
    installments && installments > 0 ? parseInt(installments) : 1;
  if (numInstallments > 1 || financialAccountId === 'boleto') {
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
        paymentDate: null,
        financialAccountId:
          financialAccountId === 'boleto' ? 'boleto' : financialAccountId,
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
      financialAccountId: financialAccountId || 'cash-box',
      installments: installmentsArray,
    });

    return await transaction.save();
  }

  // 3. Default Single
  const transaction = new CashTransaction({
    description,
    amount,
    category,
    type: TransactionType.EXPENSE,
    tenantId: req.tenantId,
    timestamp: competenceDate,
    financialAccountId: financialAccountId || 'cash-box',
    status: status,
    dueDate: dueDate ? new Date(dueDate) : undefined,
    paymentDate:
      status === TransactionStatus.PAID
        ? paymentDate
          ? new Date(paymentDate)
          : new Date()
        : undefined,
  });

  return await transaction.save();
};

// POST
router.post('/', protect, authorize('owner', 'manager'), async (req, res) => {
  const { description, amount, category } = req.body;
  if (!description || !amount || !category)
    return res.status(400).json({ message: 'Dados incompletos.' });
  try {
    const result = await createManualTransaction(req, req.body);
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// PAY INVOICE (POST)
router.post(
  '/pay-invoice',
  protect,
  authorize('owner', 'manager'),
  async (req, res) => {
    const { dueDate, paymentDate } = req.body;
    if (!dueDate || !paymentDate)
      return res.status(400).json({ message: 'Dados insuficientes.' });
    try {
      const targetDate = new Date(dueDate);
      const startOfDay = new Date(targetDate.setUTCHours(0, 0, 0, 0));
      const endOfDay = new Date(targetDate.setUTCHours(23, 59, 59, 999));

      const result = await CashTransaction.findOneAndUpdate(
        {
          tenantId: req.tenantId,
          financialAccountId: 'credit-main',
          isInvoice: true,
          dueDate: { $gte: startOfDay, $lte: endOfDay },
        },
        {
          $set: {
            status: TransactionStatus.PAID,
            paymentDate: new Date(paymentDate),
            invoiceStatus: 'Closed',
          },
        },
        { new: true }
      );

      await CreditCardTransaction.updateMany(
        {
          tenantId: req.tenantId,
          financialAccountId: 'credit-main',
          dueDate: { $gte: startOfDay, $lte: endOfDay },
        },
        { $set: { status: TransactionStatus.PAID } }
      );

      res.json({ message: 'Fatura paga.', transaction: result });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

// PUT (Update - SURGICAL VS RECREATION)
router.put('/:id', protect, authorize('owner', 'manager'), async (req, res) => {
  const targetId = req.params.id;
  const transactionData = req.body;
  const { installmentNumber } = transactionData;

  try {
    const existingCash = await CashTransaction.findOne({
      _id: targetId,
      tenantId: req.tenantId,
    });

    // CASE 1: Partial Update (Specific installment of Boleto) - Logic A
    if (existingCash && installmentNumber) {
      const updated = await CashTransaction.findOneAndUpdate(
        {
          _id: targetId,
          tenantId: req.tenantId,
          'installments.number': installmentNumber,
        },
        {
          $set: {
            'installments.$.status': transactionData.status,
            'installments.$.paymentDate':
              transactionData.status === TransactionStatus.PAID
                ? transactionData.paymentDate
                  ? new Date(transactionData.paymentDate)
                  : new Date()
                : null,
          },
        },
        { new: true }
      );

      if (updated) {
        const allPaid = updated.installments.every(
          (inst) => inst.status === TransactionStatus.PAID
        );
        updated.status = allPaid
          ? TransactionStatus.PAID
          : TransactionStatus.PENDING;
        updated.paymentDate = allPaid ? new Date() : null;
        await updated.save();

        // SYNC STATUS WITH ORIGIN
        if (updated.purchaseId)
          await updateOriginStatus(
            req.tenantId,
            'purchase',
            updated.purchaseId
          );
        if (updated.serviceOrderId)
          await updateOriginStatus(
            req.tenantId,
            'service_order',
            updated.serviceOrderId
          );
      }
      return res.json(updated);
    }

    // CASE 2: Invoice Revert - No destruction
    if (existingCash && existingCash.isInvoice) {
      const updated = await CashTransaction.findByIdAndUpdate(
        targetId,
        {
          $set: {
            status: transactionData.status,
            paymentDate: null,
            invoiceStatus: 'Closed',
          },
        },
        { new: true }
      );
      if (existingCash.dueDate) {
        const start = new Date(existingCash.dueDate);
        start.setUTCHours(0, 0, 0, 0);
        const end = new Date(existingCash.dueDate);
        end.setUTCHours(23, 59, 59, 999);
        await CreditCardTransaction.updateMany(
          {
            tenantId: req.tenantId,
            financialAccountId: 'credit-main',
            dueDate: { $gte: start, $lte: end },
          },
          { $set: { status: TransactionStatus.PENDING } }
        );
      }
      return res.json(updated);
    }

    // Guard for Surgical or Recreation Case
    if (!existingCash) {
      return res.status(404).json({ message: 'Lançamento não encontrado.' });
    }

    // CASE 3: SURGICAL LOW (Simple status change from Cash Flow)
    const isMajorChange =
      !!transactionData.financialAccountId &&
      transactionData.financialAccountId !== existingCash.financialAccountId;

    const isRecreationTriggered =
      !transactionData.isSurgical &&
      (isMajorChange ||
        (transactionData.installments &&
          parseInt(transactionData.installments) > 1));

    if (!isRecreationTriggered && !existingCash.isInvoice) {
      // Simple update
      const updated = await CashTransaction.findByIdAndUpdate(
        targetId,
        {
          $set: {
            status: transactionData.status,
            paymentDate:
              transactionData.status === TransactionStatus.PAID
                ? transactionData.paymentDate || new Date()
                : null,
            financialAccountId:
              transactionData.financialAccountId ||
              existingCash.financialAccountId,
          },
        },
        { new: true }
      );

      // SYNC STATUS WITH ORIGIN
      if (updated && updated.purchaseId)
        await updateOriginStatus(req.tenantId, 'purchase', updated.purchaseId);
      if (updated && updated.serviceOrderId)
        await updateOriginStatus(
          req.tenantId,
          'service_order',
          updated.serviceOrderId
        );

      return res.json(updated);
    }

    // CASE 4: FULL RECREATION (Clean Slate from Costs Modal)
    let originalRefId = null;
    let originalServiceId = null;

    if (existingCash.purchaseId) originalRefId = existingCash.purchaseId;
    if (existingCash.serviceOrderId)
      originalServiceId = existingCash.serviceOrderId;

    await CashTransaction.findByIdAndDelete(targetId);

    if (originalRefId && existingCash.financialAccountId === 'credit-main') {
      const itemsToDelete = await CreditCardTransaction.find({
        referenceId: originalRefId,
        tenantId: req.tenantId,
      });
      const affected = new Set();
      itemsToDelete.forEach((t) =>
        affected.add(JSON.stringify({ due: t.dueDate }))
      );
      await CreditCardTransaction.deleteMany({
        referenceId: originalRefId,
        tenantId: req.tenantId,
      });
      for (const invStr of affected) {
        const inv = JSON.parse(invStr);
        await syncInvoiceRecord(
          req.tenantId,
          'credit-main',
          'default',
          new Date(inv.due)
        );
      }
    }

    const result = await createManualTransaction(req, {
      ...transactionData,
      referenceId: originalRefId || `COST-${Date.now()}`,
      serviceOrderId: originalServiceId,
    });

    // SYNC STATUS WITH ORIGIN AFTER RECREATION
    if (originalRefId)
      await updateOriginStatus(req.tenantId, 'purchase', originalRefId);
    if (originalServiceId)
      await updateOriginStatus(
        req.tenantId,
        'service_order',
        originalServiceId
      );

    res.json(result);
  } catch (err) {
    console.error('Update Transaction Error:', err);
    res.status(400).json({ message: err.message });
  }
});

// DELETE
router.delete(
  '/:id',
  protect,
  authorize('owner', 'manager'),
  async (req, res) => {
    try {
      const tx = await CashTransaction.findOne({
        _id: req.params.id,
        tenantId: req.tenantId,
      });
      if (tx) {
        const pid = tx.purchaseId;
        const sid = tx.serviceOrderId;
        await CashTransaction.deleteOne({ _id: req.params.id });

        if (tx.financialAccountId === 'credit-main' && pid) {
          const itemsToDelete = await CreditCardTransaction.find({
            referenceId: pid,
            tenantId: req.tenantId,
          });
          const affected = new Set();
          itemsToDelete.forEach((t) =>
            affected.add(JSON.stringify({ due: t.dueDate }))
          );
          await CreditCardTransaction.deleteMany({
            referenceId: pid,
            tenantId: req.tenantId,
          });
          for (const invStr of affected) {
            const inv = JSON.parse(invStr);
            await syncInvoiceRecord(
              req.tenantId,
              'credit-main',
              'default',
              new Date(inv.due)
            );
          }
        }
        if (pid) await updateOriginStatus(req.tenantId, 'purchase', pid);
        if (sid) await updateOriginStatus(req.tenantId, 'service_order', sid);
        return res.json({ message: 'Deleted' });
      }
      res.status(404).json({ message: 'Not found' });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

export default router;
