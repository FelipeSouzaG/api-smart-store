
import express from 'express';
const router = express.Router();
import PurchaseOrder from '../models/PurchaseOrder.js';
import Product from '../models/Product.js';
import CashTransaction from '../models/CashTransaction.js';
import CreditCardTransaction from '../models/CreditCardTransaction.js';
import Supplier from '../models/Supplier.js';
import FinancialAccount from '../models/FinancialAccount.js';
import { TransactionType, TransactionCategory, TransactionStatus, PaymentMethod } from '../types.js';
import { protect, authorize } from '../middleware/authMiddleware.js';
import { syncInvoiceRecord } from '../utils/financeHelpers.js';

// Helper function to apply stock and cost changes
const applyPurchaseToProducts = async (purchaseOrder) => {
  const totalItemCost = purchaseOrder.items.reduce(
    (sum, item) => sum + item.unitCost * item.quantity,
    0
  );
  const additionalCosts = purchaseOrder.freightCost + purchaseOrder.otherCost;

  for (const item of purchaseOrder.items) {
    const product = await Product.findOne({
      _id: item.productId,
      tenantId: purchaseOrder.tenantId,
    });
    if (!product) continue;

    const itemProportion =
      totalItemCost > 0 ? (item.unitCost * item.quantity) / totalItemCost : 0;
    const dilutedCostPerItem =
      additionalCosts > 0
        ? (itemProportion * additionalCosts) / item.quantity
        : 0;
    const finalUnitCost = item.unitCost + dilutedCostPerItem;

    const oldTotalCost = product.cost * product.stock;
    const newItemsTotalCost = finalUnitCost * item.quantity;
    const newStock = product.stock + item.quantity;
    const newAverageCost =
      newStock > 0
        ? (oldTotalCost + newItemsTotalCost) / newStock
        : finalUnitCost;

    product.stock = newStock;
    product.cost = newAverageCost;
    await product.save();
  }
};

const reversePurchaseFromProducts = async (purchaseOrder) => {
  const totalItemCost = purchaseOrder.items.reduce(
    (sum, item) => sum + item.unitCost * item.quantity,
    0
  );
  const additionalCosts = purchaseOrder.freightCost + purchaseOrder.otherCost;

  for (const item of purchaseOrder.items) {
    const product = await Product.findOne({
      _id: item.productId,
      tenantId: purchaseOrder.tenantId,
    });
    if (!product) continue;

    const itemProportion =
      totalItemCost > 0 ? (item.unitCost * item.quantity) / totalItemCost : 0;
    const dilutedCostPerItem =
      additionalCosts > 0
        ? (itemProportion * additionalCosts) / item.quantity
        : 0;
    const originalFinalUnitCost = item.unitCost + dilutedCostPerItem;

    const currentTotalValue = product.cost * product.stock;
    const valueOfItemsToRemove = originalFinalUnitCost * item.quantity;
    const newStock = product.stock - item.quantity;

    const newTotalValue = currentTotalValue - valueOfItemsToRemove;
    const newAverageCost = newStock > 0 ? newTotalValue / newStock : 0;

    product.stock = newStock;
    product.cost = newStock > 0 ? newAverageCost : 0; 
    await product.save();
  }
};

const createTransactionsForPurchase = async (purchaseOrder, reqStatus, reqPaymentDate, reqDueDate) => {
  const { paymentDetails, tenantId, totalCost, supplierInfo, id } = purchaseOrder;
  const descriptionBase = `Compra #${id} - ${supplierInfo.name}`;

  // 1. Credit Card Logic (Generates CreditCardTransaction)
  if (paymentDetails.financialAccountId && paymentDetails.financialAccountId !== 'cash-box' && paymentDetails.financialAccountId !== 'boleto' && paymentDetails.paymentMethodId) {
      const account = await FinancialAccount.findOne({ _id: paymentDetails.financialAccountId, tenantId });
      const methodRule = account?.paymentMethods.find(m => m.id === paymentDetails.paymentMethodId || (m._id && m._id.toString() === paymentDetails.paymentMethodId));

      if (methodRule && methodRule.type === 'Credit') {
          let numInstallments = 1;
          if (paymentDetails.installmentCount && paymentDetails.installmentCount > 0) {
              numInstallments = paymentDetails.installmentCount;
          } else if (Array.isArray(paymentDetails.installments) && paymentDetails.installments.length > 0) {
              numInstallments = paymentDetails.installments.length;
          }

          const installmentValue = totalCost / numInstallments;
          const closingDay = methodRule.closingDay || 1;
          const dueDay = methodRule.dueDay || 10;
          const competenceDate = reqPaymentDate ? new Date(reqPaymentDate) : new Date(purchaseOrder.createdAt);
          const pDay = competenceDate.getDate();
          let targetMonth = competenceDate.getMonth();
          let targetYear = competenceDate.getFullYear();

          if (pDay >= closingDay) {
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
              
              ccTransactions.push({
                  tenantId,
                  description: `${descriptionBase} (${i + 1}/${numInstallments})`,
                  amount: installmentValue,
                  category: TransactionCategory.PRODUCT_PURCHASE,
                  timestamp: competenceDate,
                  dueDate: autoDueDate,
                  financialAccountId: paymentDetails.financialAccountId,
                  paymentMethodId: paymentDetails.paymentMethodId,
                  installmentNumber: i + 1,
                  totalInstallments: numInstallments,
                  source: 'purchase',
                  referenceId: id
              });
          }
          await CreditCardTransaction.insertMany(ccTransactions);
          for (const dateStr of affectedDueDates) {
                await syncInvoiceRecord(tenantId, paymentDetails.financialAccountId, paymentDetails.paymentMethodId, new Date(dateStr));
          }
          return;
      }
  }

  // 2. Boleto / Manual Split Logic -> Generates MULTIPLE CashTransactions (Individual Control)
  // This satisfies the requirement: "Pagamento do boleto seja feito no caixa individualmente"
  if (paymentDetails.method === PaymentMethod.BANK_SLIP && Array.isArray(paymentDetails.installments) && paymentDetails.installments.length > 0) {
        const transactionsToAdd = paymentDetails.installments.map((inst) => ({
            tenantId,
            description: `${descriptionBase} (${inst.installmentNumber}/${paymentDetails.installments.length})`,
            amount: inst.amount,
            type: TransactionType.EXPENSE,
            category: TransactionCategory.PRODUCT_PURCHASE,
            status: TransactionStatus.PENDING,
            timestamp: new Date(purchaseOrder.createdAt),
            dueDate: new Date(inst.dueDate),
            purchaseId: id, // Link to Parent
            financialAccountId: 'boleto',
            paymentMethodId: undefined
        }));
        
        await CashTransaction.insertMany(transactionsToAdd);
        return;
  }

  // 3. Single Cash Transaction (Cash/Pix/Debit)
  const finalStatus = reqStatus || (paymentDetails.method === PaymentMethod.BANK_SLIP ? TransactionStatus.PENDING : TransactionStatus.PAID);
  
  await CashTransaction.create({
    tenantId,
    description: descriptionBase,
    amount: totalCost,
    type: TransactionType.EXPENSE,
    category: TransactionCategory.PRODUCT_PURCHASE,
    status: finalStatus,
    timestamp: reqPaymentDate ? new Date(reqPaymentDate) : (paymentDetails.paymentDate || new Date()),
    dueDate: reqDueDate ? new Date(reqDueDate) : (paymentDetails.paymentDate || new Date()),
    paymentDate: finalStatus === TransactionStatus.PAID ? (reqPaymentDate ? new Date(reqPaymentDate) : (paymentDetails.paymentDate || new Date())) : undefined,
    purchaseId: id, // Link to Parent
    financialAccountId: paymentDetails.financialAccountId === 'boleto' ? undefined : (paymentDetails.financialAccountId || 'cash-box'),
    paymentMethodId: paymentDetails.paymentMethodId
  });
};

router.get('/', protect, authorize('owner', 'manager'), async (req, res) => {
  try {
    const purchases = await PurchaseOrder.find({ tenantId: req.tenantId }).sort({ createdAt: -1 });
    res.json(purchases);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/', protect, authorize('owner', 'manager'), async (req, res) => {
  const { items, supplierInfo, reference, status, paymentDate, dueDate } = req.body;
  if (!items || items.length === 0 || !supplierInfo || !reference) {
    return res.status(400).json({ message: 'Dados da compra incompletos.' });
  }
  try {
    const count = await PurchaseOrder.countDocuments({ tenantId: req.tenantId });
    const newId = `PO-${(count + Date.now()).toString().slice(-4)}`;
    const { ...purchaseData } = req.body;

    if (supplierInfo?.cnpjCpf) {
      const cleanedCnpjCpf = supplierInfo.cnpjCpf.replace(/\D/g, '');
      await Supplier.findOneAndUpdate(
        { tenantId: req.tenantId, cnpjCpf: cleanedCnpjCpf },
        {
          tenantId: req.tenantId,
          cnpjCpf: cleanedCnpjCpf,
          name: supplierInfo.name,
          contactPerson: supplierInfo.contactPerson,
          phone: supplierInfo.phone,
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    }

    const newPurchaseOrder = new PurchaseOrder({
      ...purchaseData,
      _id: newId,
      tenantId: req.tenantId,
      supplierInfo,
      createdAt: new Date(),
    });

    await applyPurchaseToProducts(newPurchaseOrder);
    await createTransactionsForPurchase(newPurchaseOrder, status, paymentDate, dueDate);

    const savedPurchase = await newPurchaseOrder.save();
    res.status(201).json(savedPurchase);
  } catch (err) {
    console.error('Error creating purchase:', err);
    res.status(400).json({ message: err.message });
  }
});

router.delete('/:id', protect, authorize('owner', 'manager'), async (req, res) => {
    try {
      const poToDelete = await PurchaseOrder.findOne({ _id: req.params.id, tenantId: req.tenantId });
      if (!poToDelete) return res.status(404).json({ message: 'Purchase Order not found' });

      await reversePurchaseFromProducts(poToDelete);
      
      // Cleanup CashTransactions (Individual records linked by purchaseId)
      await CashTransaction.deleteMany({ purchaseId: poToDelete.id, tenantId: req.tenantId });
      
      // Cleanup CreditCardTransactions
      const ccTrans = await CreditCardTransaction.find({ referenceId: poToDelete.id, tenantId: req.tenantId, source: 'purchase' });
      const affectedInvoices = new Set();
      ccTrans.forEach(t => affectedInvoices.add(JSON.stringify({ acc: t.financialAccountId, met: t.paymentMethodId, due: t.dueDate })));
      
      await CreditCardTransaction.deleteMany({ referenceId: poToDelete.id, tenantId: req.tenantId, source: 'purchase' });
      
      for (const invStr of affectedInvoices) {
          const inv = JSON.parse(invStr);
          await syncInvoiceRecord(req.tenantId, inv.acc, inv.met, new Date(inv.due));
      }

      await PurchaseOrder.findByIdAndDelete(req.params.id);
      res.json({ message: 'Purchase Order deleted successfully' });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

router.put('/:id', protect, authorize('owner', 'manager'), async (req, res) => {
    try {
        const originalPO = await PurchaseOrder.findOne({ _id: req.params.id, tenantId: req.tenantId });
        if (!originalPO) return res.status(404).json({ message: 'Not found' });

        // 1. Reverse Old
        await reversePurchaseFromProducts(originalPO);
        await CashTransaction.deleteMany({ purchaseId: originalPO.id, tenantId: req.tenantId });
        
        const ccTrans = await CreditCardTransaction.find({ referenceId: originalPO.id, tenantId: req.tenantId, source: 'purchase' });
        const affectedInvoices = new Set();
        ccTrans.forEach(t => affectedInvoices.add(JSON.stringify({ acc: t.financialAccountId, met: t.paymentMethodId, due: t.dueDate })));
        await CreditCardTransaction.deleteMany({ referenceId: originalPO.id, tenantId: req.tenantId, source: 'purchase' });
        
        for (const invStr of affectedInvoices) {
            const inv = JSON.parse(invStr);
            await syncInvoiceRecord(req.tenantId, inv.acc, inv.met, new Date(inv.due));
        }

        // 2. Apply New
        const { supplierInfo, status, paymentDate, dueDate, ...purchaseData } = req.body;
        Object.assign(originalPO, { supplierInfo, ...purchaseData });
        
        await applyPurchaseToProducts(originalPO);
        await createTransactionsForPurchase(originalPO, status, paymentDate, dueDate);
        
        const updated = await originalPO.save();
        res.json(updated);

    } catch (err) {
        res.status(400).json({message: err.message});
    }
});

export default router;
