import express from 'express';
const router = express.Router();
import Product from '../models/Product.js';
import { protect, authorize } from '../middleware/authMiddleware.js';

// GET all products (Scoped by Tenant)
router.get('/', protect, async (req, res) => {
  try {
    const products = await Product.find({ tenantId: req.tenantId });
    res.json(products);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST a new product (Inject Tenant)
router.post('/', protect, authorize('owner', 'manager'), async (req, res) => {
  const { id, brand, model, price, category } = req.body;
  if (!id || !brand || !model || !price || !category) {
    return res
      .status(400)
      .json({ message: 'Campos obrigatórios estão faltando.' });
  }

  const product = new Product({
    ...req.body, // Spread body first
    _id: id,
    barcode: id,
    tenantId: req.tenantId, // Security: Force Tenant ID from token to overwrite any body data
  });

  try {
    const newProduct = await product.save();
    res.status(201).json(newProduct);
  } catch (err) {
    if (err.code === 11000) {
      return res
        .status(400)
        .json({
          message:
            'Um produto com este código de barras já existe nesta empresa.',
        });
    }
    res.status(400).json({ message: err.message });
  }
});

// PUT (update) a product (Scoped by Tenant)
router.put('/:id', protect, authorize('owner', 'manager'), async (req, res) => {
  try {
    // Security: Remove tenantId from body
    const { tenantId, ...updateData } = req.body;

    const updatedProduct = await Product.findOneAndUpdate(
      { _id: req.params.id, tenantId: req.tenantId }, // Filter by ID AND Tenant
      updateData,
      { new: true }
    );
    if (!updatedProduct)
      return res
        .status(404)
        .json({ message: 'Produto não encontrado ou acesso negado.' });
    res.json(updatedProduct);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// DELETE a product (Scoped by Tenant)
router.delete(
  '/:id',
  protect,
  authorize('owner', 'manager'),
  async (req, res) => {
    try {
      const product = await Product.findOneAndDelete({
        _id: req.params.id,
        tenantId: req.tenantId,
      });
      if (!product)
        return res
          .status(404)
          .json({ message: 'Produto não encontrado ou acesso negado.' });
      res.json({ message: 'Produto excluído com sucesso.' });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

export default router;
