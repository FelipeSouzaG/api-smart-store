import express from 'express';
import mongoose from 'mongoose';
import EcommerceOrder from '../models/EcommerceOrder.js';
import TicketSale from '../models/TicketSale.js';
import CashTransaction from '../models/CashTransaction.js';
import ServiceOrder from '../models/ServiceOrder.js';
import Product from '../models/Product.js';
import Service from '../models/Service.js'; // Importado para buscar custos
import Customer from '../models/Customer.js';
import {
  TransactionType,
  TransactionCategory,
  TransactionStatus,
  ServiceOrderStatus,
} from '../types.js';
import { protect, authorize } from '../middleware/authMiddleware.js';

const router = express.Router();

// GET all orders
router.get('/', protect, authorize('owner', 'manager'), async (req, res) => {
  try {
    const orders = await EcommerceOrder.find({ tenantId: req.tenantId }).sort({
      createdAt: -1,
    });
    res.json(orders);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PUT Update Shipping Info Only
router.put(
  '/:id/shipping',
  protect,
  authorize('owner', 'manager'),
  async (req, res) => {
    const { shippingInfo } = req.body;
    const { id } = req.params;
    try {
      const order = await EcommerceOrder.findOneAndUpdate(
        { _id: id, tenantId: req.tenantId },
        { $set: { shippingInfo } },
        { new: true }
      );
      if (!order)
        return res.status(404).json({ message: 'Pedido não encontrado.' });
      res.json(order);
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

// PUT Update Status (Transitions Logic with ATOMIC TRANSACTIONS)
router.put(
  '/:id/status',
  protect,
  authorize('owner', 'manager'),
  async (req, res) => {
    const { status, shippingInfo } = req.body;
    const { id } = req.params;
    const tenantId = req.tenantId;

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const order = await EcommerceOrder.findOne({ _id: id, tenantId }).session(
        session
      );
      if (!order) {
        await session.abortTransaction();
        return res.status(404).json({ message: 'Pedido não encontrado.' });
      }

      // Idempotency check
      if (order.status === status) {
        await session.abortTransaction();
        return res.json(order);
      }

      // 1. PENDING -> SENT (Baixa de Estoque APENAS para Produtos)
      if (order.status === 'PENDING' && status === 'SENT') {
        for (const item of order.items) {
          if (item.type === 'service') continue; // Services don't decrease stock

          const product = await Product.findOne({
            _id: item.productId,
            tenantId,
          }).session(session);

          if (!product) {
            throw new Error(
              `Produto ${item.productName} não encontrado no cadastro.`
            );
          }

          if (product.stock < item.quantity) {
            throw new Error(
              `Estoque insuficiente para ${item.productName}. Disponível: ${product.stock}, Necessário: ${item.quantity}.`
            );
          }

          product.stock -= item.quantity;
          product.lastSold = new Date();
          await product.save({ session });
        }

        order.status = 'SENT';
        order.shippingInfo = {
          ...order.shippingInfo,
          ...shippingInfo,
          shippedAt: new Date(),
        };
        await order.save({ session });
      }

      // 2. SENT -> PENDING (Estorno de Estoque)
      else if (order.status === 'SENT' && status === 'PENDING') {
        for (const item of order.items) {
          if (item.type === 'service') continue;

          await Product.findOneAndUpdate(
            { _id: item.productId, tenantId },
            { $inc: { stock: item.quantity } },
            { session }
          );
        }

        order.status = 'PENDING';
        order.shippingInfo.shippedAt = undefined;
        order.shippingInfo.trackingCode = undefined;
        await order.save({ session });
      }

      // 3. SENT -> DELIVERED (SPLIT LOGIC: TicketSale vs ServiceOrder)
      else if (order.status === 'SENT' && status === 'DELIVERED') {
        const productItems = order.items.filter(
          (i) => i.type === 'product' || !i.type
        ); // Default to product if missing
        const serviceItems = order.items.filter((i) => i.type === 'service');

        // --- Common Customer Upsert ---
        let customerId = order.relatedCustomerId;
        const cleanPhone = order.customer.phone.replace(/\D/g, '');

        let customer = await Customer.findOne({
          tenantId,
          phone: cleanPhone,
        }).session(session);
        if (!customer) {
          customer = new Customer({
            tenantId,
            name: order.customer.name,
            phone: cleanPhone,
          });
          await customer.save({ session });
        }
        customerId = customer.id;

        const now = new Date();
        const year = now.getFullYear();
        const month = (now.getMonth() + 1).toString().padStart(2, '0');

        // --- A. Handle Products (TicketSale + Sales Revenue) ---
        let ticketId = undefined;
        if (productItems.length > 0) {
          let totalProductCost = 0;
          let totalProductRevenue = 0;
          const saleItems = [];

          for (const item of productItems) {
            const product = await Product.findOne({
              _id: item.productId,
              tenantId,
            }).session(session);
            let unitCost = 0;
            if (product) unitCost = product.cost;

            totalProductCost += unitCost * item.quantity;
            totalProductRevenue += item.unitPrice * item.quantity;

            saleItems.push({
              item: { id: item.productId, name: item.productName },
              quantity: item.quantity,
              unitPrice: item.unitPrice,
              unitCost: unitCost,
              type: 'product',
            });
          }

          const count = await TicketSale.countDocuments({
            tenantId,
            _id: new RegExp(`^TC-${year}${month}`),
          }).session(session);
          const seq = (count + 1).toString().padStart(4, '0');
          ticketId = `TC-${year}${month}-${seq}-ECOM`;

          const newSale = new TicketSale({
            tenantId,
            _id: ticketId,
            items: saleItems,
            total: totalProductRevenue,
            totalCost: totalProductCost,
            discount: 0,
            paymentMethod: 'E-commerce',
            timestamp: now,
            customerName: order.customer.name,
            customerWhatsapp: cleanPhone,
            customerId,
            saleHour: now.getHours(),
            userId: req.user.id,
            userName: req.user.name,
          });
          await newSale.save({ session });

          // Cash Transaction for Products
          const newTx = new CashTransaction({
            tenantId,
            description: `Venda Online (Produtos) #${order._id}`,
            amount: totalProductRevenue,
            type: TransactionType.INCOME,
            category: TransactionCategory.SALES_REVENUE,
            status: TransactionStatus.PAID,
            timestamp: now,
            dueDate: now,
            paymentDate: now,
            saleId: ticketId,
            financialAccountId: 'cash-box',
          });
          await newTx.save({ session });
        }

        // --- B. Handle Services (ServiceOrder ONLY) ---
        let serviceOrderId = undefined;
        if (serviceItems.length > 0) {
          const countOS = await ServiceOrder.countDocuments({
            tenantId,
            _id: new RegExp(`^OS-${year}${month}`),
          }).session(session);
          const seqOS = (countOS + 1).toString().padStart(4, '0');
          serviceOrderId = `OS-${year}${month}${seqOS}-ECOM`;

          let totalServiceRevenue = 0;
          let totalServiceCost = 0; // Custo Total calculado
          const descriptions = [];

          for (const item of serviceItems) {
            totalServiceRevenue += item.unitPrice * item.quantity;
            descriptions.push(`${item.quantity}x ${item.productName}`);

            // Busca custo do serviço original para popular a OS
            const serviceDef = await Service.findOne({
              _id: item.productId,
              tenantId,
            }).session(session);
            if (serviceDef) {
              const unitCost =
                (serviceDef.partCost || 0) +
                (serviceDef.serviceCost || 0) +
                (serviceDef.shippingCost || 0);
              totalServiceCost += unitCost * item.quantity;
            }
          }

          // Create OS in PENDING state (Awaiting device/execution)
          const newOS = new ServiceOrder({
            tenantId,
            _id: serviceOrderId,
            customerName: order.customer.name,
            customerWhatsapp: cleanPhone,
            customerId,
            serviceId: serviceItems[0].productId, // Link first service as primary for reference
            serviceDescription: `Venda Online: ${descriptions.join(', ')}`,
            totalPrice: totalServiceRevenue,
            totalCost: totalServiceCost, // Salva o custo para acionar o modal de pagamento ao finalizar a OS
            status: ServiceOrderStatus.PENDING, // IMPORTANT: Starts Pending
            createdAt: now,
            // Payment info stored for reference, but revenue not booked yet
            paymentMethod: 'E-commerce (Pré-pago/A Combinar)',
            finalPrice: totalServiceRevenue,
          });
          await newOS.save({ session });

          // NOTE: CashTransaction removed here as requested.
          // Revenue will be recorded when the OS is completed in ServiceOrders module.
        }

        order.status = 'DELIVERED';
        order.shippingInfo.deliveredAt = new Date();
        order.relatedTicketId = ticketId;
        order.relatedServiceOrderId = serviceOrderId; // Save OS link
        order.relatedCustomerId = customerId;
        await order.save({ session });
      }

      // 4. DELIVERED -> SENT (Estorno Financeiro)
      else if (order.status === 'DELIVERED' && status === 'SENT') {
        // Revert Product Sale
        if (order.relatedTicketId) {
          await TicketSale.deleteOne({
            _id: order.relatedTicketId,
            tenantId,
          }).session(session);
          await CashTransaction.deleteOne({
            saleId: order.relatedTicketId,
            tenantId,
          }).session(session);
        }
        // Revert Service Order
        if (order.relatedServiceOrderId) {
          await ServiceOrder.deleteOne({
            _id: order.relatedServiceOrderId,
            tenantId,
          }).session(session);
          // No CashTransaction for service to delete here anymore
        }

        order.status = 'SENT';
        order.relatedTicketId = undefined;
        order.relatedServiceOrderId = undefined;
        order.shippingInfo.deliveredAt = undefined;
        await order.save({ session });
      } else {
        await session.abortTransaction();
        return res
          .status(400)
          .json({ message: 'Transição de status inválida.' });
      }

      await session.commitTransaction();
      res.json(order);
    } catch (err) {
      await session.abortTransaction();
      console.error('Transaction Aborted:', err);
      res.status(500).json({ message: err.message });
    } finally {
      session.endSession();
    }
  }
);

// DELETE Order (Cleanup based on state with TRANSACTION)
router.delete(
  '/:id',
  protect,
  authorize('owner', 'manager'),
  async (req, res) => {
    const { id } = req.params;
    const tenantId = req.tenantId;

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const order = await EcommerceOrder.findOne({ _id: id, tenantId }).session(
        session
      );
      if (!order) {
        await session.abortTransaction();
        return res.status(404).json({ message: 'Pedido não encontrado.' });
      }

      // Logic 1: If DELIVERED, remove Finance + Sale/OS AND Restore Stock (Products only)
      if (order.status === 'DELIVERED') {
        if (order.relatedTicketId) {
          await TicketSale.deleteOne({
            _id: order.relatedTicketId,
            tenantId,
          }).session(session);
          await CashTransaction.deleteOne({
            saleId: order.relatedTicketId,
            tenantId,
          }).session(session);
        }
        if (order.relatedServiceOrderId) {
          await ServiceOrder.deleteOne({
            _id: order.relatedServiceOrderId,
            tenantId,
          }).session(session);
        }

        // Restore Stock
        for (const item of order.items) {
          if (item.type === 'service') continue;
          await Product.findOneAndUpdate(
            { _id: item.productId, tenantId },
            { $inc: { stock: item.quantity } },
            { session }
          );
        }
      }
      // Logic 2: If SENT, just Restore Stock
      else if (order.status === 'SENT') {
        for (const item of order.items) {
          if (item.type === 'service') continue;
          await Product.findOneAndUpdate(
            { _id: item.productId, tenantId },
            { $inc: { stock: item.quantity } },
            { session }
          );
        }
      }
      // Logic 3: If PENDING, just delete (no stock/money moved yet)

      await EcommerceOrder.deleteOne({ _id: id, tenantId }).session(session);

      await session.commitTransaction();
      res.json({ message: 'Pedido excluído e registros revertidos.' });
    } catch (err) {
      await session.abortTransaction();
      console.error('Delete Transaction Error:', err);
      res.status(500).json({ message: err.message });
    } finally {
      session.endSession();
    }
  }
);

export default router;
