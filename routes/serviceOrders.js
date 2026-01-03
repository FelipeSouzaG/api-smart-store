import express from 'express';
const router = express.Router();
import ServiceOrder from '../models/ServiceOrder.js';
import Customer from '../models/Customer.js';
import CashTransaction from '../models/CashTransaction.js';
import CreditCardTransaction from '../models/CreditCardTransaction.js';
import StoreConfig from '../models/StoreConfig.js'; // Use StoreConfig
import {
  TransactionType,
  TransactionCategory,
  TransactionStatus,
  ServiceOrderStatus,
} from '../types.js';
import { protect, authorize } from '../middleware/authMiddleware.js';
import { syncInvoiceRecord } from '../utils/financeHelpers.js';

// GET all service orders
router.get('/', protect, async (req, res) => {
  try {
    const serviceOrders = await ServiceOrder.find({
      tenantId: req.tenantId,
    }).sort({ createdAt: -1 });
    res.json(serviceOrders);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST new OS
router.post(
  '/',
  protect,
  authorize('owner', 'manager', 'technician'),
  async (req, res) => {
    const { customerName, customerWhatsapp, customerCnpjCpf, ...orderData } =
      req.body;
    const now = new Date();
    const year = now.getFullYear();
    const month = (now.getMonth() + 1).toString().padStart(2, '0');
    const count = await ServiceOrder.countDocuments({
      _id: new RegExp(`^OS-${year}${month}`),
      tenantId: req.tenantId,
    });
    const sequentialId = (count + 1).toString().padStart(4, '0');
    const tenantSuffix = req.tenantId.toString().slice(-4);
    const newOrderId = `OS-${year}${month}${sequentialId}-${tenantSuffix}`;

    try {
      let customerId = null;
      if (customerWhatsapp && customerName) {
        const cleanedPhone = customerWhatsapp.replace(/\D/g, '');
        const customer = await Customer.findOneAndUpdate(
          { phone: cleanedPhone, tenantId: req.tenantId },
          {
            tenantId: req.tenantId,
            phone: cleanedPhone,
            name: customerName,
            cnpjCpf: customerCnpjCpf || '',
          },
          { new: true, upsert: true, setDefaultsOnInsert: true }
        );
        customerId = customer.id;
      }
      const newOrder = new ServiceOrder({
        _id: newOrderId,
        tenantId: req.tenantId,
        customerName,
        customerWhatsapp,
        customerCnpjCpf,
        customerId,
        ...orderData,
        status: ServiceOrderStatus.PENDING,
        createdAt: now,
      });
      const savedOrder = await newOrder.save();
      res.status(201).json(savedOrder);
    } catch (err) {
      res.status(400).json({ message: err.message });
    }
  }
);

// Helper to create financials (Used in Toggle Status and PUT)
const createServiceFinancials = async (order, req, costPaymentDetails) => {
  // 1. Revenue
  await CashTransaction.create({
    tenantId: req.tenantId,
    description: `Faturamento OS #${order.id} - ${order.serviceDescription}`,
    amount: order.finalPrice || order.totalPrice,
    type: TransactionType.INCOME,
    category: TransactionCategory.SERVICE_REVENUE,
    status: TransactionStatus.PAID,
    timestamp: new Date(),
    dueDate: new Date(),
    paymentDate: new Date(),
    serviceOrderId: order.id,
    financialAccountId: 'cash-box',
  });

  // 2. Cost
  const costAmount = Number(order.totalCost);
  if (costAmount > 0 && costPaymentDetails) {
    const {
      status: costStatus,
      financialAccountId,
      installments,
      date,
    } = costPaymentDetails;
    const competenceDate = new Date();

    if (financialAccountId === 'credit-main') {
      // --- CC Logic ---
      const config = await StoreConfig.findOne({ tenantId: req.tenantId });
      const closingDay = config?.financialSettings?.cardClosingDay || 1;
      const dueDay = config?.financialSettings?.cardDueDay || 10;

      const numInstallments = installments || 1;
      const installmentValue = costAmount / numInstallments;

      const pDay = competenceDate.getDate();
      let targetMonth = competenceDate.getMonth();
      let targetYear = competenceDate.getFullYear();
      if (pDay >= closingDay) {
        targetMonth += 1;
        if (targetMonth > 11) {
          targetMonth = 0;
          targetYear += 1;
        }
      }

      const ccTransactions = [];
      const affected = new Set();

      for (let i = 0; i < numInstallments; i++) {
        let m = targetMonth + i;
        let y = targetYear;
        while (m > 11) {
          m -= 12;
          y += 1;
        }
        const autoDue = new Date(Date.UTC(y, m, dueDay, 12, 0, 0));
        affected.add(autoDue.toISOString());

        ccTransactions.push({
          tenantId: req.tenantId,
          description: `Custo OS #${order.id} (${i + 1}/${numInstallments})`,
          amount: installmentValue,
          category: TransactionCategory.SERVICE_COST,
          timestamp: competenceDate,
          dueDate: autoDue,
          financialAccountId: 'credit-main',
          paymentMethodId: 'default',
          installmentNumber: i + 1,
          totalInstallments: numInstallments,
          source: 'service_order',
          referenceId: order.id,
        });
      }
      await CreditCardTransaction.insertMany(ccTransactions);
      for (const d of affected)
        await syncInvoiceRecord(
          req.tenantId,
          'credit-main',
          'default',
          new Date(d)
        );
    } else {
      // Cash/Bank
      await CashTransaction.create({
        tenantId: req.tenantId,
        description: `Custo OS #${order.id}`,
        amount: costAmount,
        type: TransactionType.EXPENSE,
        category: TransactionCategory.SERVICE_COST,
        status: costStatus,
        timestamp: competenceDate,
        dueDate: date ? new Date(date) : new Date(),
        paymentDate:
          costStatus === TransactionStatus.PAID
            ? date
              ? new Date(date)
              : new Date()
            : undefined,
        serviceOrderId: order.id,
        financialAccountId: financialAccountId || 'cash-box',
      });
    }
  }
};

const cleanupServiceFinancials = async (orderId, tenantId) => {
  // Cleanup financials
  await CashTransaction.deleteMany({ serviceOrderId: orderId, tenantId });

  // Cleanup CC
  const ccTrans = await CreditCardTransaction.find({
    referenceId: orderId,
    tenantId,
    source: 'service_order',
  });
  const affected = new Set();
  ccTrans.forEach((t) => affected.add(JSON.stringify({ due: t.dueDate })));
  await CreditCardTransaction.deleteMany({
    referenceId: orderId,
    tenantId,
    source: 'service_order',
  });

  for (const invStr of affected) {
    const inv = JSON.parse(invStr);
    await syncInvoiceRecord(
      tenantId,
      'credit-main',
      'default',
      new Date(inv.due)
    );
  }
};

// PUT Update
router.put(
  '/:id',
  protect,
  authorize('owner', 'manager', 'technician'),
  async (req, res) => {
    const {
      customerName,
      customerWhatsapp,
      customerCnpjCpf,
      costPaymentDetails,
      ...orderData
    } = req.body;
    try {
      const order = await ServiceOrder.findOne({
        _id: req.params.id,
        tenantId: req.tenantId,
      });
      if (!order) return res.status(404).json({ message: 'Not Found' });

      // Handle Customer Info Update
      let customerId = orderData.customerId;
      if (customerWhatsapp && customerName) {
        const cleanedPhone = customerWhatsapp.replace(/\D/g, '');
        const customer = await Customer.findOneAndUpdate(
          { phone: cleanedPhone, tenantId: req.tenantId },
          {
            tenantId: req.tenantId,
            phone: cleanedPhone,
            name: customerName,
            cnpjCpf: customerCnpjCpf || '',
          },
          { new: true, upsert: true, setDefaultsOnInsert: true }
        );
        customerId = customer.id;
      }

      order.customerName = customerName;
      order.customerWhatsapp = customerWhatsapp;
      order.customerCnpjCpf = customerCnpjCpf;
      if (customerId) order.customerId = customerId;
      Object.assign(order, orderData);

      if (order.status === ServiceOrderStatus.COMPLETED) {
        await cleanupServiceFinancials(order.id, req.tenantId);
        await createServiceFinancials(order, req, costPaymentDetails);
      }

      const updated = await order.save();
      res.json(updated);
    } catch (err) {
      res.status(400).json({ message: err.message });
    }
  }
);

// DELETE
router.delete(
  '/:id',
  protect,
  authorize('owner', 'manager', 'technician'),
  async (req, res) => {
    try {
      const order = await ServiceOrder.findOne({
        _id: req.params.id,
        tenantId: req.tenantId,
      });
      if (!order) return res.status(404).json({ message: 'Not found' });

      await cleanupServiceFinancials(req.params.id, req.tenantId);

      await ServiceOrder.findByIdAndDelete(req.params.id);
      res.json({ message: 'Deleted' });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

// TOGGLE STATUS
router.post(
  '/:id/toggle-status',
  protect,
  authorize('owner', 'manager', 'technician'),
  async (req, res) => {
    const { paymentMethod, discount, finalPrice, costPaymentDetails } =
      req.body;
    try {
      const order = await ServiceOrder.findOne({
        _id: req.params.id,
        tenantId: req.tenantId,
      });
      if (!order)
        return res.status(404).json({ message: 'Service Order not found' });

      if (order.status === ServiceOrderStatus.PENDING) {
        order.status = ServiceOrderStatus.COMPLETED;
        order.completedAt = new Date();
        if (finalPrice !== undefined) order.finalPrice = Number(finalPrice);
        if (discount !== undefined) order.discount = Number(discount);
        if (paymentMethod) order.paymentMethod = paymentMethod;

        await createServiceFinancials(order, req, costPaymentDetails);
      } else {
        // Reopen
        order.status = ServiceOrderStatus.PENDING;
        await cleanupServiceFinancials(order.id, req.tenantId);
      }

      const updated = await order.save();
      res.json(updated);
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

export default router;
