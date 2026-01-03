import express from 'express';
const router = express.Router();
import Supplier from '../models/Supplier.js';
import { protect, authorize } from '../middleware/authMiddleware.js';
import mongoose from 'mongoose';

// GET all suppliers (Scoped by Tenant)
router.get('/', protect, authorize('owner', 'manager'), async (req, res) => {
  try {
    const suppliers = await Supplier.find({ tenantId: req.tenantId }).sort({
      name: 1,
    });
    res.json(suppliers);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET a supplier by Phone (Scoped by Tenant)
router.get(
  '/by-phone/:phone',
  protect,
  authorize('owner', 'manager'),
  async (req, res) => {
    try {
      const { phone } = req.params;
      const cleanedPhone = phone.replace(/\D/g, '');

      if (!cleanedPhone) return res.json(null);

      // Search for raw digits OR formatted versions
      const queries = [cleanedPhone];
      if (cleanedPhone.length >= 10) {
        // (XX) XXXX-XXXX or (XX) XXXXX-XXXX
        if (cleanedPhone.length === 10) {
          queries.push(
            cleanedPhone.replace(/(\d{2})(\d{4})(\d{4})/, '($1) $2-$3')
          );
        } else if (cleanedPhone.length === 11) {
          queries.push(
            cleanedPhone.replace(/(\d{2})(\d{5})(\d{4})/, '($1) $2-$3')
          );
        }
      }

      const supplier = await Supplier.findOne({
        tenantId: req.tenantId,
        phone: { $in: queries },
      });

      res.json(supplier || null);
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

// GET a supplier by ID or CNPJ/CPF (Scoped by Tenant)
router.get(
  '/:identifier',
  protect,
  authorize('owner', 'manager'),
  async (req, res) => {
    try {
      const { identifier } = req.params;
      const cleanedIdentifier = identifier.replace(/\D/g, '');

      // Determine if we are looking up by ObjectId (from UI edit) or CNPJ (from Purchase search)
      let query;
      if (mongoose.Types.ObjectId.isValid(identifier)) {
        query = { _id: identifier, tenantId: req.tenantId };
      } else {
        query = { cnpjCpf: cleanedIdentifier, tenantId: req.tenantId };
      }

      const supplier = await Supplier.findOne(query);

      if (!supplier) {
        return res.status(404).json({ message: 'Fornecedor não encontrado.' });
      }
      res.json(supplier);
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

// POST a new supplier (Inject Tenant)
router.post('/', protect, authorize('owner', 'manager'), async (req, res) => {
  const { cnpjCpf, name, contactPerson, phone } = req.body;
  if (!cnpjCpf || !name || !phone) {
    return res
      .status(400)
      .json({ message: 'Nome, CPF/CNPJ e Telefone são obrigatórios.' });
  }
  const cleanedId = cnpjCpf.replace(/\D/g, '');
  const cleanedPhone = phone.replace(/\D/g, '');

  try {
    // Check for duplicates within the tenant (CNPJ)
    const existingSupplier = await Supplier.findOne({
      cnpjCpf: cleanedId,
      tenantId: req.tenantId,
    });
    if (existingSupplier) {
      return res
        .status(400)
        .json({ message: 'Fornecedor com este CPF/CNPJ já existe.' });
    }

    // Check for duplicates within the tenant (Phone)
    // We check strict cleaned phone to ensure uniqueness
    if (cleanedPhone) {
      const queries = [cleanedPhone];
      if (cleanedPhone.length === 10)
        queries.push(
          cleanedPhone.replace(/(\d{2})(\d{4})(\d{4})/, '($1) $2-$3')
        );
      if (cleanedPhone.length === 11)
        queries.push(
          cleanedPhone.replace(/(\d{2})(\d{5})(\d{4})/, '($1) $2-$3')
        );

      const existingPhone = await Supplier.findOne({
        tenantId: req.tenantId,
        phone: { $in: queries },
      });
      if (existingPhone) {
        return res
          .status(400)
          .json({ message: 'Telefone já cadastrado para outro fornecedor.' });
      }
    }

    const newSupplier = new Supplier({
      ...req.body, // Spread first
      tenantId: req.tenantId, // Security: Force Tenant ID from token
      cnpjCpf: cleanedId,
    });

    const savedSupplier = await newSupplier.save();
    res.status(201).json(savedSupplier);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// PUT (update) a supplier (Scoped by Tenant)
router.put('/:id', protect, authorize('owner', 'manager'), async (req, res) => {
  if (!req.body.name || !req.body.phone) {
    return res
      .status(400)
      .json({ message: 'Nome e Telefone são obrigatórios.' });
  }

  try {
    const { id } = req.params;
    let query;

    // Resolve ID
    if (mongoose.Types.ObjectId.isValid(id)) {
      query = { _id: id, tenantId: req.tenantId };
    } else {
      const cleanedIdParam = id.replace(/\D/g, '');
      query = { cnpjCpf: cleanedIdParam, tenantId: req.tenantId };
    }

    // Check if supplier exists
    const supplierToUpdate = await Supplier.findOne(query);
    if (!supplierToUpdate) {
      return res.status(404).json({ message: 'Fornecedor não encontrado.' });
    }

    // Check for duplicate CNPJ/CPF if it's being changed
    if (req.body.cnpjCpf) {
      const newCnpj = req.body.cnpjCpf.replace(/\D/g, '');

      // Look for ANY supplier with this CNPJ in this tenant, EXCLUDING the current one
      const duplicateCheck = await Supplier.findOne({
        tenantId: req.tenantId,
        cnpjCpf: newCnpj,
        _id: { $ne: supplierToUpdate._id },
      });

      if (duplicateCheck) {
        return res
          .status(400)
          .json({
            message: 'Já existe outro fornecedor cadastrado com este CPF/CNPJ.',
          });
      }

      // Update body with cleaned CNPJ
      req.body.cnpjCpf = newCnpj;
    }

    // Check for duplicate Phone if it's being changed
    if (req.body.phone) {
      const newPhoneRaw = req.body.phone.replace(/\D/g, '');
      const currentPhoneRaw = supplierToUpdate.phone.replace(/\D/g, '');

      if (newPhoneRaw !== currentPhoneRaw) {
        const queries = [newPhoneRaw];
        if (newPhoneRaw.length === 10)
          queries.push(
            newPhoneRaw.replace(/(\d{2})(\d{4})(\d{4})/, '($1) $2-$3')
          );
        if (newPhoneRaw.length === 11)
          queries.push(
            newPhoneRaw.replace(/(\d{2})(\d{5})(\d{4})/, '($1) $2-$3')
          );

        const duplicatePhone = await Supplier.findOne({
          tenantId: req.tenantId,
          phone: { $in: queries },
          _id: { $ne: supplierToUpdate._id },
        });

        if (duplicatePhone) {
          return res
            .status(400)
            .json({ message: 'Telefone já cadastrado para outro fornecedor.' });
        }
      }
    }

    // Security: Remove tenantId from body to prevent moving supplier to another tenant
    const { tenantId, ...updateData } = req.body;

    const updatedSupplier = await Supplier.findByIdAndUpdate(
      supplierToUpdate._id,
      updateData,
      { new: true }
    );

    res.json(updatedSupplier);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// DELETE a supplier (Scoped by Tenant)
router.delete(
  '/:id',
  protect,
  authorize('owner', 'manager'),
  async (req, res) => {
    try {
      const { id } = req.params;
      let query;
      if (mongoose.Types.ObjectId.isValid(id)) {
        query = { _id: id, tenantId: req.tenantId };
      } else {
        const cleanedId = id.replace(/\D/g, '');
        query = { cnpjCpf: cleanedId, tenantId: req.tenantId };
      }

      const supplier = await Supplier.findOneAndDelete(query);
      if (!supplier) {
        return res.status(404).json({ message: 'Fornecedor não encontrado.' });
      }
      res.json({ message: 'Fornecedor excluído com sucesso.' });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

export default router;
