
import express from 'express';
const router = express.Router();
import ServiceOrder from '../models/ServiceOrder.js';
import Customer from '../models/Customer.js';
import CashTransaction from '../models/CashTransaction.js';
import FinancialAccount from '../models/FinancialAccount.js';
import {
  TransactionType,
  TransactionCategory,
  TransactionStatus,
  ServiceOrderStatus,
} from '../types.js';
import { protect, authorize } from '../middleware/authMiddleware.js';

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

// POST a new service order
router.post(
  '/',
  protect,
  authorize('owner', 'manager', 'technician'),
  async (req, res) => {
    const { customerName, customerWhatsapp, customerCnpjCpf, ...orderData } =
      req.body;

    // Generate new ID
    const now = new Date();
    const year = now.getFullYear();
    const month = (now.getMonth() + 1).toString().padStart(2, '0');
    // Scoped count
    const count = await ServiceOrder.countDocuments({
      _id: new RegExp(`^OS-${year}${month}`),
      tenantId: req.tenantId,
    });
    const sequentialId = (count + 1).toString().padStart(4, '0');

    // Tenant suffix to ensure uniqueness across DB
    const tenantSuffix = req.tenantId.toString().slice(-4);
    const newOrderId = `OS-${year}${month}${sequentialId}-${tenantSuffix}`;

    try {
      // Customer Upsert Logic (Scoped)
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

// PUT (update) a service order
router.put(
  '/:id',
  protect,
  authorize('owner', 'manager', 'technician'),
  async (req, res) => {
    const { customerName, customerWhatsapp, customerCnpjCpf, ...orderData } =
      req.body;
    try {
      const order = await ServiceOrder.findOne({
        _id: req.params.id,
        tenantId: req.tenantId,
      });
      if (!order) {
        return res
          .status(404)
          .json({ message: 'Ordem de Serviço não encontrada.' });
      }

      if (
        req.user.role === 'technician' &&
        order.status === ServiceOrderStatus.COMPLETED
      ) {
        return res
          .status(403)
          .json({
            message: 'Técnicos não podem editar Ordens de Serviço concluídas.',
          });
      }

      // Customer Upsert Logic (Scoped)
      let customerId = orderData.customerId; // Keep existing if not changed
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

      const updatePayload = {
        customerName,
        customerWhatsapp,
        customerCnpjCpf,
        customerId,
        ...orderData,
      };

      const updatedOrder = await ServiceOrder.findOneAndUpdate(
        { _id: req.params.id, tenantId: req.tenantId },
        updatePayload,
        { new: true }
      );
      res.json(updatedOrder);
    } catch (err) {
      res.status(400).json({ message: err.message });
    }
  }
);

// DELETE a service order
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
      if (!order)
        return res
          .status(404)
          .json({ message: 'Ordem de Serviço não encontrada.' });

      // Technicians can only delete PENDING orders.
      if (
        req.user.role === 'technician' &&
        order.status !== ServiceOrderStatus.PENDING
      ) {
        return res
          .status(403)
          .json({
            message:
              'Técnicos só podem excluir Ordens de Serviço com status "Pendente".',
          });
      }

      // Also delete associated transactions (Scoped by Tenant)
      await CashTransaction.deleteMany({
        serviceOrderId: req.params.id,
        tenantId: req.tenantId,
      });
      await ServiceOrder.findByIdAndDelete(req.params.id);

      res.json({
        message:
          'Ordem de Serviço e transações associadas foram excluídas com sucesso.',
      });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

// POST toggle status of a service order
router.post(
  '/:id/toggle-status',
  protect,
  authorize('owner', 'manager', 'technician'),
  async (req, res) => {
    const { paymentMethod, discount, finalPrice, costPaymentDetails } = req.body;

    try {
      const order = await ServiceOrder.findOne({
        _id: req.params.id,
        tenantId: req.tenantId,
      });
      if (!order)
        return res.status(404).json({ message: 'Service Order not found' });

      if (order.status === ServiceOrderStatus.PENDING) {
        // --- COMPLETING THE ORDER ---
        order.status = ServiceOrderStatus.COMPLETED;
        order.completedAt = new Date();

        // Update financial details (Revenue)
        if (finalPrice !== undefined) order.finalPrice = Number(finalPrice);
        if (discount !== undefined) order.discount = Number(discount);
        if (paymentMethod) order.paymentMethod = paymentMethod;

        const amountToReceive =
          finalPrice !== undefined
            ? Number(finalPrice)
            : Number(order.totalPrice);

        const transactionsToAdd = [];

        // 1. REVENUE TRANSACTION (Receita)
        transactionsToAdd.push({
          tenantId: req.tenantId,
          description: `Faturamento OS #${order.id} - ${order.serviceDescription}`,
          amount: amountToReceive,
          type: TransactionType.INCOME,
          category: TransactionCategory.SERVICE_REVENUE,
          status: TransactionStatus.PAID,
          timestamp: new Date(),
          dueDate: new Date(),
          paymentDate: new Date(),
          serviceOrderId: order.id,
          financialAccountId: 'cash-box' 
        });

        // 2. COST TRANSACTION (Despesa) - Only if cost > 0
        const costAmount = Number(order.totalCost);
        
        if (costAmount > 0 && costPaymentDetails) {
            
            let costStatus = costPaymentDetails.status;
            let financialAccountId = costPaymentDetails.financialAccountId || 'cash-box';
            let paymentMethodId = costPaymentDetails.paymentMethodId;
            let isCreditCard = false;
            let numInstallments = 1;
            
            // Determine date based on status selection in frontend
            const inputDate = costPaymentDetails.date ? new Date(costPaymentDetails.date) : new Date();

            // Check if it is a Credit Card payment method (Financeiro Table)
            if (financialAccountId !== 'cash-box' && paymentMethodId) {
                const account = await FinancialAccount.findOne({ _id: financialAccountId, tenantId: req.tenantId });
                const methodRule = account?.paymentMethods.find(m => m.id === paymentMethodId);

                if (methodRule && methodRule.type === 'Credit') {
                    isCreditCard = true;
                    numInstallments = costPaymentDetails.installments || 1;
                    
                    // --- CREDIT CARD LOGIC ---
                    const installmentValue = costAmount / numInstallments;
                    const closingDay = methodRule.closingDay || 1;
                    const dueDay = methodRule.dueDay || 10;
                    
                    const pDate = new Date(); // Purchase Date is NOW
                    const pDay = pDate.getDate();
                    let targetMonth = pDate.getMonth();
                    let targetYear = pDate.getFullYear();

                    // If purchased AFTER closing day, it goes to next month
                    if (pDay >= closingDay) {
                        targetMonth += 1;
                        if (targetMonth > 11) { targetMonth = 0; targetYear += 1; }
                    }

                    for (let i = 0; i < numInstallments; i++) {
                        let currentInstMonth = targetMonth + i;
                        let currentInstYear = targetYear;
                        while (currentInstMonth > 11) { currentInstMonth -= 12; currentInstYear += 1; }
                        
                        // Create UTC Date for consistency (Noon UTC)
                        const autoDueDate = new Date(Date.UTC(currentInstYear, currentInstMonth, dueDay, 12, 0, 0));
                        
                        transactionsToAdd.push({
                            tenantId: req.tenantId,
                            description: `Custo OS #${order.id} - ${order.serviceDescription} (${i + 1}/${numInstallments})`,
                            amount: installmentValue,
                            type: TransactionType.EXPENSE,
                            category: TransactionCategory.SERVICE_COST,
                            // FORCE PENDING: Credit card costs are essentially "Accounts Payable" until the bill is paid.
                            status: TransactionStatus.PENDING, 
                            timestamp: new Date(),
                            dueDate: autoDueDate,
                            paymentDate: null,
                            serviceOrderId: order.id,
                            financialAccountId,
                            paymentMethodId
                        });
                    }
                }
            }

            // Logic B: Normal Payment (Cash/Pix/Debit) OR Manual Pending
            if (!isCreditCard) {
                let costDueDate, costPaymentDate;

                if (costStatus === TransactionStatus.PAID) {
                    // If Paid, it impacts Cash/Bank Balance immediately
                    costDueDate = inputDate;
                    costPaymentDate = inputDate;
                } else {
                    // If Pending, it's an Account Payable in 'Caixa'
                    costDueDate = inputDate;
                    costPaymentDate = null;
                }

                transactionsToAdd.push({
                    tenantId: req.tenantId,
                    description: `Custo OS #${order.id} - ${order.serviceDescription}`,
                    amount: costAmount,
                    type: TransactionType.EXPENSE,
                    category: TransactionCategory.SERVICE_COST,
                    status: costStatus,
                    timestamp: new Date(), // Competence
                    dueDate: costDueDate,
                    paymentDate: costPaymentDate,
                    serviceOrderId: order.id,
                    financialAccountId,
                    paymentMethodId
                });
            }
        }

        if (transactionsToAdd.length > 0) {
            await CashTransaction.insertMany(transactionsToAdd);
        }

      } else {
        // --- REVERTING TO PENDING ---
        if (req.user.role === 'technician') {
          return res.status(403).json({ message: 'Técnicos não têm permissão para reabrir OS.' });
        }
        order.status = ServiceOrderStatus.PENDING;
        order.completedAt = undefined;
        order.finalPrice = undefined;
        order.discount = undefined;
        order.paymentMethod = undefined;

        // Remove transactions
        await CashTransaction.deleteMany({
          serviceOrderId: order.id,
          tenantId: req.tenantId,
        });
      }

      const updatedOrder = await order.save();
      res.json(updatedOrder);
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: err.message });
    }
  }
);

export default router;
