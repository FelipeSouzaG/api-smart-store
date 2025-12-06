
import express from 'express';
const router = express.Router();
import PurchaseOrder from '../models/PurchaseOrder.js';
import Product from '../models/Product.js';
import CashTransaction from '../models/CashTransaction.js';
import Supplier from '../models/Supplier.js';
import FinancialAccount from '../models/FinancialAccount.js';
import {
  TransactionType,
  TransactionCategory,
  TransactionStatus,
  PaymentMethod,
} from '../types.js';
import { protect, authorize } from '../middleware/authMiddleware.js';

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

// Helper function to reverse stock and cost changes
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
    // prevent division by zero, and reset cost if stock is zero.
    const newAverageCost = newStock > 0 ? newTotalValue / newStock : 0;

    product.stock = newStock;
    product.cost = newStock > 0 ? newAverageCost : 0; // if stock is 0, cost should be 0.
    await product.save();
  }
};

// Helper function to create cash transactions (UPDATED FOR FINANCIAL ACCOUNTS)
const createTransactionsForPurchase = async (purchaseOrder, reqStatus, reqPaymentDate, reqDueDate) => {
  const transactionsToAdd = [];
  const { paymentDetails, tenantId, totalCost, supplierInfo, id } = purchaseOrder;
  const descriptionBase = `Compra #${id} - ${supplierInfo.name}`;

  // 1. Check for Financial Account Linkage
  if (paymentDetails.financialAccountId && paymentDetails.financialAccountId !== 'cash-box' && paymentDetails.paymentMethodId) {
      const account = await FinancialAccount.findOne({ _id: paymentDetails.financialAccountId, tenantId });
      const methodRule = account?.paymentMethods.find(m => m.id === paymentDetails.paymentMethodId);

      // A. CREDIT CARD LOGIC (Split installments)
      if (methodRule && methodRule.type === 'Credit') {
          // Determine number of installments from request payload logic passed down, or default to 1
          // Since PurchaseOrder schema stores installments array for legacy reasons, we might need to rely on the 'installments' count passed in payload or derived.
          // However, for consistency, we re-calculate based on the new logic if it's credit card.
          
          // NOTE: The `purchaseOrder.paymentDetails.installments` array might be empty if coming from new UI structure for Credit Card.
          // We assume simple division based on total cost if detailed installment array isn't provided.
          
          // Try to guess installment count. If it was stored in DB, use length. If not, default to 1.
          let numInstallments = 1;
          if (paymentDetails.installments && paymentDetails.installments.length > 0) {
             numInstallments = paymentDetails.installments.length;
          } else {
             // Fallback: This might happen if frontend sent a simple count. 
             // Ideally we should have passed `installmentsCount` from frontend to backend explicitly.
             // For now, let's assume 1 if array is empty, which treats it as sight credit.
             numInstallments = 1; 
          }

          const installmentValue = totalCost / numInstallments;
          const closingDay = methodRule.closingDay || 1;
          const dueDay = methodRule.dueDay || 10;
          
          const competenceDate = new Date(purchaseOrder.createdAt);
          const pDay = competenceDate.getDate();
          let targetMonth = competenceDate.getMonth();
          let targetYear = competenceDate.getFullYear();

          if (pDay >= closingDay) {
              targetMonth += 1;
              if (targetMonth > 11) { targetMonth = 0; targetYear += 1; }
          }

          for (let i = 0; i < numInstallments; i++) {
              let currentInstMonth = targetMonth + i;
              let currentInstYear = targetYear;
              while (currentInstMonth > 11) { currentInstMonth -= 12; currentInstYear += 1; }
              
              const autoDueDate = new Date(Date.UTC(currentInstYear, currentInstMonth, dueDay, 12, 0, 0));
              
              transactionsToAdd.push({
                  tenantId,
                  description: `${descriptionBase} (${i + 1}/${numInstallments})`,
                  amount: installmentValue,
                  type: TransactionType.EXPENSE,
                  category: TransactionCategory.PRODUCT_PURCHASE,
                  status: TransactionStatus.PENDING, // Credit card costs are always pending until invoice payment
                  dueDate: autoDueDate,
                  paymentDate: null,
                  purchaseId: id,
                  financialAccountId: paymentDetails.financialAccountId,
                  paymentMethodId: paymentDetails.paymentMethodId
              });
          }
          return transactionsToAdd;
      }
  }

  // 2. Default / Legacy / Cash Logic
  // If we provided explicit status/dates from frontend (new modal), use them.
  // Otherwise fall back to legacy schema logic.
  
  const finalStatus = reqStatus || (paymentDetails.method === PaymentMethod.BANK_SLIP ? TransactionStatus.PENDING : TransactionStatus.PAID);
  
  if (paymentDetails.method === PaymentMethod.BANK_SLIP || (finalStatus === TransactionStatus.PENDING && !paymentDetails.paymentDate)) {
      // Installments Logic (Manual Bank Slip or Manual Pending)
      if (paymentDetails.installments && paymentDetails.installments.length > 0) {
          paymentDetails.installments.forEach((inst) => {
            transactionsToAdd.push({
              tenantId,
              description: `${descriptionBase} (${inst.installmentNumber}/${paymentDetails.installments.length})`,
              amount: inst.amount,
              type: TransactionType.EXPENSE,
              category: TransactionCategory.PRODUCT_PURCHASE,
              status: TransactionStatus.PENDING,
              dueDate: inst.dueDate,
              timestamp: inst.dueDate,
              purchaseId: id,
              financialAccountId: paymentDetails.financialAccountId,
              paymentMethodId: paymentDetails.paymentMethodId
            });
          });
      } else {
          // Single Pending Item
          transactionsToAdd.push({
              tenantId,
              description: descriptionBase,
              amount: totalCost,
              type: TransactionType.EXPENSE,
              category: TransactionCategory.PRODUCT_PURCHASE,
              status: TransactionStatus.PENDING,
              dueDate: reqDueDate ? new Date(reqDueDate) : new Date(),
              timestamp: new Date(),
              purchaseId: id,
              financialAccountId: paymentDetails.financialAccountId,
              paymentMethodId: paymentDetails.paymentMethodId
          });
      }
  } else {
      // Immediate Payment (Cash, Pix, Debit)
      transactionsToAdd.push({
        tenantId,
        description: descriptionBase,
        amount: totalCost,
        type: TransactionType.EXPENSE,
        category: TransactionCategory.PRODUCT_PURCHASE,
        status: TransactionStatus.PAID,
        timestamp: reqPaymentDate ? new Date(reqPaymentDate) : (paymentDetails.paymentDate || new Date()),
        dueDate: reqPaymentDate ? new Date(reqPaymentDate) : (paymentDetails.paymentDate || new Date()),
        paymentDate: reqPaymentDate ? new Date(reqPaymentDate) : (paymentDetails.paymentDate || new Date()),
        purchaseId: id,
        financialAccountId: paymentDetails.financialAccountId || 'cash-box',
        paymentMethodId: paymentDetails.paymentMethodId
      });
  }
  
  return transactionsToAdd;
};

// GET all purchase orders
router.get('/', protect, authorize('owner', 'manager'), async (req, res) => {
  try {
    const purchases = await PurchaseOrder.find({ tenantId: req.tenantId }).sort(
      { createdAt: -1 }
    );
    res.json(purchases);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST a new purchase order
router.post('/', protect, authorize('owner', 'manager'), async (req, res) => {
  const { items, supplierInfo, reference, status, paymentDate, dueDate } = req.body;
  
  if (!items || items.length === 0 || !supplierInfo || !reference) {
    return res.status(400).json({ message: 'Dados da compra incompletos.' });
  }
  
  try {
    const count = await PurchaseOrder.countDocuments({
      tenantId: req.tenantId,
    });
    const newId = `PO-${(count + Date.now()).toString().slice(-4)}`;

    const { ...purchaseData } = req.body;

    // Supplier Upsert Logic (Scoped by Tenant)
    if (
      supplierInfo &&
      supplierInfo.cnpjCpf &&
      supplierInfo.name &&
      supplierInfo.phone
    ) {
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
    
    // Pass extra fields from body to transaction helper
    const transactions = await createTransactionsForPurchase(newPurchaseOrder, status, paymentDate, dueDate);
    
    if (transactions.length > 0) {
      await CashTransaction.insertMany(transactions);
    }

    const savedPurchase = await newPurchaseOrder.save();
    res.status(201).json(savedPurchase);
  } catch (err) {
    console.error('Error creating purchase:', err);
    res.status(400).json({ message: err.message });
  }
});

// PUT (update) a purchase order
router.put('/:id', protect, authorize('owner', 'manager'), async (req, res) => {
  try {
    const originalPO = await PurchaseOrder.findOne({
      _id: req.params.id,
      tenantId: req.tenantId,
    });
    if (!originalPO)
      return res.status(404).json({ message: 'Purchase Order not found' });

    // Reverse old state
    await reversePurchaseFromProducts(originalPO);
    await CashTransaction.deleteMany({
      purchaseId: originalPO.id,
      tenantId: req.tenantId,
    });

    // Apply new state
    const { supplierInfo, tenantId, status, paymentDate, dueDate, ...purchaseData } = req.body; 

    if (
      supplierInfo &&
      supplierInfo.cnpjCpf &&
      supplierInfo.name &&
      supplierInfo.phone
    ) {
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

    const updatedPOData = {
      supplierInfo,
      ...purchaseData,
      tenantId: req.tenantId,
    };

    Object.assign(originalPO, updatedPOData);

    await applyPurchaseToProducts(originalPO);
    
    // Pass extra fields from body to transaction helper
    const transactions = await createTransactionsForPurchase(originalPO, status, paymentDate, dueDate);
    
    if (transactions.length > 0) {
      await CashTransaction.insertMany(transactions);
    }

    const updatedPurchase = await PurchaseOrder.findOneAndUpdate(
      { _id: req.params.id, tenantId: req.tenantId },
      updatedPOData,
      { new: true }
    );
    res.json(updatedPurchase);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// DELETE a purchase order
router.delete(
  '/:id',
  protect,
  authorize('owner', 'manager'),
  async (req, res) => {
    try {
      const poToDelete = await PurchaseOrder.findOne({
        _id: req.params.id,
        tenantId: req.tenantId,
      });
      if (!poToDelete)
        return res.status(404).json({ message: 'Purchase Order not found' });

      await reversePurchaseFromProducts(poToDelete);
      await CashTransaction.deleteMany({
        purchaseId: poToDelete.id,
        tenantId: req.tenantId,
      });
      await PurchaseOrder.findByIdAndDelete(req.params.id);

      res.json({ message: 'Purchase Order deleted successfully' });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

export default router;
