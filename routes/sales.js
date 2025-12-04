import express from 'express';
import mongoose from 'mongoose';
import TicketSale from '../models/TicketSale.js';
import Product from '../models/Product.js';
import Service from '../models/Service.js';
import CashTransaction from '../models/CashTransaction.js';
import Customer from '../models/Customer.js';
import {
  TransactionType,
  TransactionCategory,
  TransactionStatus,
} from '../types.js';
import { protect, authorize } from '../middleware/authMiddleware.js';

const router = express.Router();

// GET all sales (Scoped by Tenant)
router.get('/', protect, authorize('owner', 'manager'), async (req, res) => {
  try {
    const sales = await TicketSale.find({ tenantId: req.tenantId }).sort({
      timestamp: -1,
    });
    res.json(sales);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST a new sale
router.post('/', protect, async (req, res) => {
  const {
    items,
    total,
    customerName,
    customerWhatsapp,
    customerCnpjCpf,
    paymentMethod,
    discountApplied,
  } = req.body;

  // Use user data from JWT or fallback object created in middleware
  const userId = req.user._id || req.user.id;
  const userName = req.user.name || 'Usuário SaaS';
  const tenantId = req.tenantId;
  const now = new Date();

  if (!items || items.length === 0 || total === undefined) {
    return res.status(400).json({ message: 'Dados da venda incompletos.' });
  }

  try {
    // 1. Upsert customer logic (Scoped by Tenant)
    let customerId = null;

    if (customerWhatsapp && customerName) {
      const cleanedPhone = customerWhatsapp.replace(/\D/g, '');
      const cleanedDoc = customerCnpjCpf
        ? customerCnpjCpf.replace(/\D/g, '')
        : null;

      // SERVER-SIDE HARD STOP: Validation for CPF/CNPJ hijacking
      if (cleanedDoc && cleanedDoc.length >= 11) {
        // Support legacy formatted data lookup
        const queries = [cleanedDoc];
        if (cleanedDoc.length === 11)
          queries.push(
            cleanedDoc.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4')
          );
        if (cleanedDoc.length === 14)
          queries.push(
            cleanedDoc.replace(
              /(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/,
              '$1.$2.$3/$4-$5'
            )
          );

        // Find ANY customer with this document (raw or formatted) in this tenant
        const existingDocs = await Customer.find({
          tenantId,
          cnpjCpf: { $in: queries },
        });

        for (const docCustomer of existingDocs) {
          const existingPhoneClean = docCustomer.phone.replace(/\D/g, '');

          // If we found a customer with this DOC, check if the phone is different
          // If phone is different, it means we are trying to assign an existing CPF to a new/different person.
          if (existingPhoneClean !== cleanedPhone) {
            return res.status(400).json({
              message: `BLOQUEIO DE SEGURANÇA: O CPF/CNPJ informado já pertence ao cliente "${docCustomer.name}" (Tel: ${docCustomer.phone}). Não é possível usar o mesmo documento para números diferentes.`,
            });
          }
        }
      }

      // Safe to proceed with Upsert based on Phone
      const customer = await Customer.findOneAndUpdate(
        { tenantId, phone: cleanedPhone }, // Search by Tenant AND Phone
        {
          tenantId,
          phone: cleanedPhone,
          name: customerName,
          cnpjCpf: cleanedDoc, // Update doc if provided (and valid). Saves as cleaned.
        },
        { new: true, upsert: true, setDefaultsOnInsert: true }
      );
      customerId = customer.id;
    }

    // 2. Generate new Ticket ID (Scoped by Tenant)
    const year = now.getFullYear();
    const month = (now.getMonth() + 1).toString().padStart(2, '0');
    const prefix = `TC-${year}${month}-`;

    // Count only this tenant's sales for ID generation
    const lastSale = await TicketSale.findOne({
      tenantId,
      _id: new RegExp(`^${prefix}`),
    }).sort({ _id: -1 });

    let nextSequence = 1;
    if (lastSale) {
      const lastSequence = parseInt(lastSale.id.split('-')[2], 10);
      nextSequence = lastSequence + 1;
    }

    // To ensure global uniqueness without ugly IDs, we can append a short hash of tenantId
    const tenantSuffix = tenantId.toString().slice(-4);
    const newTicketId = `${prefix}${nextSequence
      .toString()
      .padStart(4, '0')}-${tenantSuffix}`;

    // 3. Update product stock AND Calculate Total Cost
    let saleTotalCost = 0;
    const updatedItems = [];

    for (const saleItem of items) {
      let itemCost = 0;

      if (saleItem.type === 'product') {
        // Find product within Tenant (Isolation check)
        const product = await Product.findOne({
          _id: saleItem.item.id,
          tenantId,
        });
        if (product) {
          itemCost = product.cost;
          product.stock -= saleItem.quantity;
          product.lastSold = now;
          await product.save();
        }
      } else if (saleItem.type === 'service') {
        // Find service within Tenant (Isolation check)
        const service = await Service.findOne({
          _id: saleItem.item.id,
          tenantId,
        });
        if (service) {
          itemCost =
            service.partCost + service.serviceCost + service.shippingCost;
        }
      }

      saleTotalCost += itemCost * saleItem.quantity;

      updatedItems.push({
        ...saleItem,
        unitCost: itemCost,
      });
    }

    // 4. Create financial transaction
    const description = paymentMethod
      ? `Venda #${newTicketId} - ${paymentMethod}`
      : `Venda #${newTicketId}`;

    const newTransaction = new CashTransaction({
      tenantId,
      description: description,
      amount: total,
      type: TransactionType.INCOME,
      category: TransactionCategory.SALES_REVENUE,
      status: TransactionStatus.PAID,
      timestamp: now,
      dueDate: now,
      saleId: newTicketId,
    });
    await newTransaction.save();

    // 5. Create and save the new sale
    const newSale = new TicketSale({
      tenantId,
      _id: newTicketId,
      items: updatedItems,
      total,
      totalCost: saleTotalCost,
      discount: discountApplied || 0,
      paymentMethod,
      customerName,
      customerWhatsapp,
      customerId,
      userId,
      userName,
      timestamp: now,
      saleHour: now.getHours(),
    });

    const savedSale = await newSale.save();
    res.status(201).json(savedSale);
  } catch (err) {
    console.error('Error creating sale:', err);
    res.status(500).json({ message: err.message });
  }
});

// DELETE a sale by ID
router.delete(
  '/:id',
  protect,
  authorize('owner', 'manager'),
  async (req, res) => {
    const { id } = req.params;
    const session = await mongoose.startSession();

    try {
      await session.withTransaction(async () => {
        // ISOLATION: Ensure we only find sales for this tenant
        const sale = await TicketSale.findOne({
          _id: id,
          tenantId: req.tenantId,
        }).session(session);
        if (!sale) {
          throw new Error('Sale not found');
        }

        // Step 1: Revert stock
        for (const item of sale.items) {
          if (item.type === 'product') {
            await Product.findOneAndUpdate(
              { _id: item.item.id, tenantId: req.tenantId },
              { $inc: { stock: item.quantity } },
              { session }
            );
          }
        }

        // Step 2: Delete transaction (Isolation ensured by query)
        await CashTransaction.deleteOne({
          saleId: id,
          tenantId: req.tenantId,
        }).session(session);

        // Step 3: Delete ticket
        await TicketSale.findByIdAndDelete(id).session(session);
      });

      res.json({ message: 'Venda excluída com sucesso.' });
    } catch (error) {
      console.error('Error deleting sale:', error.message);
      res
        .status(500)
        .json({ message: 'Ocorreu um erro no servidor ao excluir a venda.' });
    } finally {
      session.endSession();
    }
  }
);

export default router;
