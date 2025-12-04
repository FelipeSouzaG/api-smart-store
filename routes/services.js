import express from 'express';
const router = express.Router();
import Service from '../models/Service.js';
import { protect, authorize } from '../middleware/authMiddleware.js';

// GET all services (Scoped by Tenant)
router.get('/', protect, async (req, res) => {
  try {
    const services = await Service.find({ tenantId: req.tenantId });
    res.json(services);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST a new service (Inject Tenant)
router.post('/', protect, authorize('owner', 'manager'), async (req, res) => {
  const { name, brand, model, price } = req.body;
  if (!name || !brand || !model || price === undefined) {
    return res
      .status(400)
      .json({ message: 'Campos obrigatórios estão faltando.' });
  }

  const service = new Service({
    ...req.body,
    tenantId: req.tenantId,
  });

  try {
    const newService = await service.save();
    res.status(201).json(newService);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// PUT (update) a service (Scoped by Tenant)
router.put('/:id', protect, authorize('owner', 'manager'), async (req, res) => {
  try {
    const updatedService = await Service.findOneAndUpdate(
      { _id: req.params.id, tenantId: req.tenantId },
      req.body,
      { new: true }
    );
    if (!updatedService)
      return res.status(404).json({ message: 'Service not found' });
    res.json(updatedService);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// DELETE a service (Scoped by Tenant)
router.delete(
  '/:id',
  protect,
  authorize('owner', 'manager'),
  async (req, res) => {
    try {
      const service = await Service.findOneAndDelete({
        _id: req.params.id,
        tenantId: req.tenantId,
      });
      if (!service)
        return res.status(404).json({ message: 'Service not found' });
      res.json({ message: 'Service deleted successfully' });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

export default router;
