
import express from 'express';
const router = express.Router();
import ServiceOrder from '../models/ServiceOrder.js';
import Customer from '../models/Customer.js';
import CashTransaction from '../models/CashTransaction.js';
import CreditCardTransaction from '../models/CreditCardTransaction.js';
import FinancialAccount from '../models/FinancialAccount.js';
import { TransactionType, TransactionCategory, TransactionStatus, ServiceOrderStatus } from '../types.js';
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
router.post('/', protect, authorize('owner', 'manager', 'technician'), async (req, res) => {
    // ... [Standard Creation Logic, no financial impact yet] ...
    const { customerName, customerWhatsapp, customerCnpjCpf, ...orderData } = req.body;
    const now = new Date();
    const year = now.getFullYear();
    const month = (now.getMonth() + 1).toString().padStart(2, '0');
    const count = await ServiceOrder.countDocuments({ _id: new RegExp(`^OS-${year}${month}`), tenantId: req.tenantId });
    const sequentialId = (count + 1).toString().padStart(4, '0');
    const tenantSuffix = req.tenantId.toString().slice(-4);
    const newOrderId = `OS-${year}${month}${sequentialId}-${tenantSuffix}`;

    try {
        let customerId = null;
        if (customerWhatsapp && customerName) {
            const cleanedPhone = customerWhatsapp.replace(/\D/g, '');
            const customer = await Customer.findOneAndUpdate(
                { phone: cleanedPhone, tenantId: req.tenantId },
                { tenantId: req.tenantId, phone: cleanedPhone, name: customerName, cnpjCpf: customerCnpjCpf || '' },
                { new: true, upsert: true, setDefaultsOnInsert: true }
            );
            customerId = customer.id;
        }
        const newOrder = new ServiceOrder({
            _id: newOrderId,
            tenantId: req.tenantId,
            customerName, customerWhatsapp, customerCnpjCpf, customerId, ...orderData,
            status: ServiceOrderStatus.PENDING, createdAt: now
        });
        const savedOrder = await newOrder.save();
        res.status(201).json(savedOrder);
    } catch(err) { res.status(400).json({message: err.message}); }
});

// PUT Update
router.put('/:id', protect, authorize('owner', 'manager', 'technician'), async (req, res) => {
    // ... [Standard Update Logic] ...
    const { customerName, customerWhatsapp, customerCnpjCpf, ...orderData } = req.body;
    try {
        const order = await ServiceOrder.findOne({ _id: req.params.id, tenantId: req.tenantId });
        if(!order) return res.status(404).json({message: "Not Found"});
        
        let customerId = orderData.customerId;
        if (customerWhatsapp && customerName) {
            const cleanedPhone = customerWhatsapp.replace(/\D/g, '');
            const customer = await Customer.findOneAndUpdate(
                { phone: cleanedPhone, tenantId: req.tenantId },
                { tenantId: req.tenantId, phone: cleanedPhone, name: customerName, cnpjCpf: customerCnpjCpf || '' },
                { new: true, upsert: true, setDefaultsOnInsert: true }
            );
            customerId = customer.id;
        }
        const updated = await ServiceOrder.findOneAndUpdate(
            { _id: req.params.id, tenantId: req.tenantId },
            { customerName, customerWhatsapp, customerCnpjCpf, customerId, ...orderData },
            { new: true }
        );
        res.json(updated);
    } catch(err) { res.status(400).json({message: err.message}); }
});

// DELETE
router.delete('/:id', protect, authorize('owner', 'manager', 'technician'), async (req, res) => {
    try {
        const order = await ServiceOrder.findOne({ _id: req.params.id, tenantId: req.tenantId });
        if(!order) return res.status(404).json({message: "Not found"});
        
        // Cleanup financials
        await CashTransaction.deleteMany({ serviceOrderId: req.params.id, tenantId: req.tenantId });
        
        // Cleanup CC
        const ccTrans = await CreditCardTransaction.find({ referenceId: req.params.id, tenantId: req.tenantId, source: 'service_order' });
        const affected = new Set();
        ccTrans.forEach(t => affected.add(JSON.stringify({ acc: t.financialAccountId, met: t.paymentMethodId, due: t.dueDate })));
        await CreditCardTransaction.deleteMany({ referenceId: req.params.id, tenantId: req.tenantId, source: 'service_order' });
        
        for (const invStr of affected) {
            const inv = JSON.parse(invStr);
            await syncInvoiceRecord(req.tenantId, inv.acc, inv.met, new Date(inv.due));
        }

        await ServiceOrder.findByIdAndDelete(req.params.id);
        res.json({message: "Deleted"});
    } catch(err) { res.status(500).json({message: err.message}); }
});

// TOGGLE STATUS (The important one for financials)
router.post('/:id/toggle-status', protect, authorize('owner', 'manager', 'technician'), async (req, res) => {
    const { paymentMethod, discount, finalPrice, costPaymentDetails } = req.body;
    try {
        const order = await ServiceOrder.findOne({ _id: req.params.id, tenantId: req.tenantId });
        if (!order) return res.status(404).json({ message: 'Service Order not found' });

        if (order.status === ServiceOrderStatus.PENDING) {
            order.status = ServiceOrderStatus.COMPLETED;
            order.completedAt = new Date();
            if (finalPrice !== undefined) order.finalPrice = Number(finalPrice);
            if (discount !== undefined) order.discount = Number(discount);
            if (paymentMethod) order.paymentMethod = paymentMethod;

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
                financialAccountId: 'cash-box'
            });

            // 2. Cost
            const costAmount = Number(order.totalCost);
            if (costAmount > 0 && costPaymentDetails) {
                const { status: costStatus, financialAccountId, paymentMethodId, installments, date } = costPaymentDetails;
                const competenceDate = new Date(); // OS completion date

                // Check if Credit Card
                if (financialAccountId && financialAccountId !== 'cash-box' && paymentMethodId) {
                    const account = await FinancialAccount.findOne({ _id: financialAccountId, tenantId: req.tenantId });
                    const methodRule = account?.paymentMethods.find(m => m.id === paymentMethodId || (m._id && m._id.toString() === paymentMethodId));

                    if (methodRule && methodRule.type === 'Credit') {
                        // --- CC Logic ---
                        const numInstallments = installments || 1;
                        const installmentValue = costAmount / numInstallments;
                        const closingDay = methodRule.closingDay || 1;
                        const dueDay = methodRule.dueDay || 10;
                        
                        const pDay = competenceDate.getDate();
                        let targetMonth = competenceDate.getMonth();
                        let targetYear = competenceDate.getFullYear();
                        if (pDay >= closingDay) { targetMonth += 1; if(targetMonth>11){targetMonth=0; targetYear+=1;} }

                        const ccTransactions = [];
                        const affected = new Set();

                        for (let i = 0; i < numInstallments; i++) {
                            let m = targetMonth + i;
                            let y = targetYear;
                            while(m > 11) { m -= 12; y += 1; }
                            const autoDue = new Date(Date.UTC(y, m, dueDay, 12, 0, 0));
                            affected.add(autoDue.toISOString());

                            ccTransactions.push({
                                tenantId: req.tenantId,
                                description: `Custo OS #${order.id} (${i+1}/${numInstallments})`,
                                amount: installmentValue,
                                category: TransactionCategory.SERVICE_COST,
                                timestamp: competenceDate,
                                dueDate: autoDue,
                                financialAccountId,
                                paymentMethodId,
                                installmentNumber: i + 1,
                                totalInstallments: numInstallments,
                                source: 'service_order',
                                referenceId: order.id
                            });
                        }
                        await CreditCardTransaction.insertMany(ccTransactions);
                        for (const d of affected) await syncInvoiceRecord(req.tenantId, financialAccountId, paymentMethodId, new Date(d));
                    } else {
                        // Bank Debit/Pix
                        await CashTransaction.create({
                            tenantId: req.tenantId,
                            description: `Custo OS #${order.id}`,
                            amount: costAmount,
                            type: TransactionType.EXPENSE,
                            category: TransactionCategory.SERVICE_COST,
                            status: costStatus,
                            timestamp: competenceDate,
                            dueDate: date ? new Date(date) : new Date(),
                            paymentDate: costStatus === TransactionStatus.PAID ? (date ? new Date(date) : new Date()) : undefined,
                            serviceOrderId: order.id,
                            financialAccountId, paymentMethodId
                        });
                    }
                } else {
                    // Cash Box
                    await CashTransaction.create({
                        tenantId: req.tenantId,
                        description: `Custo OS #${order.id}`,
                        amount: costAmount,
                        type: TransactionType.EXPENSE,
                        category: TransactionCategory.SERVICE_COST,
                        status: costStatus,
                        timestamp: competenceDate,
                        dueDate: date ? new Date(date) : new Date(),
                        paymentDate: costStatus === TransactionStatus.PAID ? (date ? new Date(date) : new Date()) : undefined,
                        serviceOrderId: order.id,
                        financialAccountId: 'cash-box'
                    });
                }
            }

        } else {
            // Reopen
            order.status = ServiceOrderStatus.PENDING;
            // Reverse financials
            await CashTransaction.deleteMany({ serviceOrderId: order.id, tenantId: req.tenantId });
            
            const ccTrans = await CreditCardTransaction.find({ referenceId: order.id, tenantId: req.tenantId, source: 'service_order' });
            const affected = new Set();
            ccTrans.forEach(t => affected.add(JSON.stringify({ acc: t.financialAccountId, met: t.paymentMethodId, due: t.dueDate })));
            await CreditCardTransaction.deleteMany({ referenceId: order.id, tenantId: req.tenantId, source: 'service_order' });
            
            for (const invStr of affected) {
                const inv = JSON.parse(invStr);
                await syncInvoiceRecord(req.tenantId, inv.acc, inv.met, new Date(inv.due));
            }
        }

        const updated = await order.save();
        res.json(updated);
    } catch(err) { res.status(500).json({message: err.message}); }
});

export default router;
