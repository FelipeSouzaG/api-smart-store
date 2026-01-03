import express from 'express';
import mongoose from 'mongoose';
const router = express.Router();
import Customer from '../models/Customer.js';
import { protect, authorize } from '../middleware/authMiddleware.js';

// GET /api/customers/by-document/:doc - Strict search by CNPJ/CPF
// Must be defined BEFORE /:identifier to avoid routing conflicts
router.get('/by-document/:doc', protect, async (req, res) => {
  try {
    const { doc } = req.params;
    const cleanedDoc = doc.replace(/\D/g, '');

    if (!cleanedDoc) return res.json(null);

    // Search for raw digits OR formatted versions (legacy data support)
    const queries = [cleanedDoc];

    if (cleanedDoc.length === 11) {
      // CPF Format: 000.000.000-00
      queries.push(
        cleanedDoc.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4')
      );
    } else if (cleanedDoc.length === 14) {
      // CNPJ Format: 00.000.000/0000-00
      queries.push(
        cleanedDoc.replace(
          /(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/,
          '$1.$2.$3/$4-$5'
        )
      );
    }

    const customer = await Customer.findOne({
      tenantId: req.tenantId,
      cnpjCpf: { $in: queries },
    });

    res.json(customer || null);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/customers/:identifier - Find customer by phone OR ID OR CNPJ/CPF
router.get('/:identifier', protect, async (req, res) => {
  try {
    const { identifier } = req.params;
    const cleanedIdentifier = identifier.replace(/\D/g, '');

    let customer = null;

    if (mongoose.Types.ObjectId.isValid(identifier)) {
      // 1. Search by internal ID
      customer = await Customer.findOne({
        _id: identifier,
        tenantId: req.tenantId,
      });
    } else {
      // 2. Search by Phone (Priority 1 for POS)
      customer = await Customer.findOne({
        phone: cleanedIdentifier,
        tenantId: req.tenantId,
      });

      // 3. If not found by Phone, try searching by CPF/CNPJ (Verification fallback for validation)
      if (!customer && cleanedIdentifier.length >= 11) {
        // Support legacy formatted data
        const queries = [cleanedIdentifier];
        if (cleanedIdentifier.length === 11) {
          queries.push(
            cleanedIdentifier.replace(
              /(\d{3})(\d{3})(\d{3})(\d{2})/,
              '$1.$2.$3-$4'
            )
          );
        } else if (cleanedIdentifier.length === 14) {
          queries.push(
            cleanedIdentifier.replace(
              /(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/,
              '$1.$2.$3/$4-$5'
            )
          );
        }

        customer = await Customer.findOne({
          tenantId: req.tenantId,
          cnpjCpf: { $in: queries },
        });
      }
    }

    // Return null instead of 404 to make frontend checks easier
    if (!customer) {
      return res.json(null);
    }
    res.json(customer);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/customers - Create a new customer
router.post('/', protect, async (req, res) => {
  const { phone, name, cnpjCpf } = req.body;
  if (!phone || !name) {
    return res
      .status(400)
      .json({ message: 'Nome e telefone são obrigatórios.' });
  }
  const cleanedPhone = phone.replace(/\D/g, '');

  try {
    // Check for duplicate Phone within Tenant
    const existingCustomerPhone = await Customer.findOne({
      phone: cleanedPhone,
      tenantId: req.tenantId,
    });
    if (existingCustomerPhone) {
      return res
        .status(400)
        .json({ message: 'Cliente com este telefone já existe.' });
    }

    // Check for duplicate CNPJ/CPF if provided within Tenant
    if (cnpjCpf) {
      const cleanedDoc = cnpjCpf.replace(/\D/g, '');
      if (cleanedDoc) {
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

        const existingCustomerDoc = await Customer.findOne({
          tenantId: req.tenantId,
          cnpjCpf: { $in: queries },
        });

        if (existingCustomerDoc) {
          return res
            .status(400)
            .json({ message: 'Cliente com este CPF/CNPJ já existe.' });
        }
      }
    }

    // Always save cleaned data for new records to normalize DB
    const customer = new Customer({
      tenantId: req.tenantId,
      phone: cleanedPhone,
      name,
      cnpjCpf: cnpjCpf ? cnpjCpf.replace(/\D/g, '') : undefined,
    });

    const newCustomer = await customer.save();
    res.status(201).json(newCustomer);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// GET /api/customers - Get all customers
router.get('/', protect, async (req, res) => {
  try {
    const customers = await Customer.find({ tenantId: req.tenantId }).sort({
      name: 1,
    });
    res.json(customers);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PUT /api/customers/:id - Update a customer
router.put('/:id', protect, async (req, res) => {
  try {
    const { name, cnpjCpf, phone } = req.body;
    if (!name) {
      return res.status(400).json({ message: 'O nome é obrigatório.' });
    }

    const customerToUpdate = await Customer.findOne({
      _id: req.params.id,
      tenantId: req.tenantId,
    });
    if (!customerToUpdate) {
      return res.status(404).json({ message: 'Cliente não encontrado.' });
    }

    // Build Update Object explicitly
    const updateData = { name };

    // Handle Phone Update & Duplicate Check
    if (phone) {
      const cleanPhone = phone.replace(/\D/g, '');
      if (cleanPhone !== customerToUpdate.phone) {
        const dupPhone = await Customer.findOne({
          phone: cleanPhone,
          tenantId: req.tenantId,
          _id: { $ne: customerToUpdate._id },
        });
        if (dupPhone)
          return res
            .status(400)
            .json({ message: 'Telefone já pertence a outro cliente.' });
        updateData.phone = cleanPhone;
      }
    }

    // Handle CNPJ/CPF Update & Duplicate Check
    // Check if cnpjCpf is being updated (not undefined)
    if (cnpjCpf !== undefined) {
      const cleanDoc = cnpjCpf.replace(/\D/g, '');

      // If user entered a value (not just clearing it)
      if (cleanDoc) {
        const queries = [cleanDoc];
        if (cleanDoc.length === 11)
          queries.push(
            cleanDoc.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4')
          );
        if (cleanDoc.length === 14)
          queries.push(
            cleanDoc.replace(
              /(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/,
              '$1.$2.$3/$4-$5'
            )
          );

        const dupDoc = await Customer.findOne({
          tenantId: req.tenantId,
          cnpjCpf: { $in: queries },
          _id: { $ne: customerToUpdate._id },
        });
        if (dupDoc)
          return res
            .status(400)
            .json({ message: 'CPF/CNPJ já pertence a outro cliente.' });
      }

      // Normalize to clean format on save
      updateData.cnpjCpf = cleanDoc;
    }

    const updatedCustomer = await Customer.findByIdAndUpdate(
      customerToUpdate._id,
      updateData,
      { new: true, runValidators: true }
    );

    res.json(updatedCustomer);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// DELETE /api/customers/:id - Delete a customer
router.delete(
  '/:id',
  protect,
  authorize('owner', 'manager'),
  async (req, res) => {
    try {
      const customer = await Customer.findOneAndDelete({
        _id: req.params.id,
        tenantId: req.tenantId,
      });
      if (!customer) {
        return res.status(404).json({ message: 'Cliente não encontrado.' });
      }
      res.json({ message: 'Cliente excluído com sucesso.' });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

export default router;
