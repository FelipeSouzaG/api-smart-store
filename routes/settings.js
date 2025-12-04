import express from 'express';
const router = express.Router();
import StoreConfig from '../models/StoreConfig.js';
import { protect, authorize } from '../middleware/authMiddleware.js';

// GET global settings (Scoped by Tenant)
router.get('/', protect, async (req, res) => {
  try {
    let config = await StoreConfig.findOne({ tenantId: req.tenantId });

    // If no config exists yet, create one with defaults for this tenant
    // Use data from JWT (req.tenantInfo) to pre-fill registration data
    if (!config) {
      config = new StoreConfig({
        tenantId: req.tenantId,
        companyInfo: {
          name: req.tenantInfo?.companyName || '',
          cnpjCpf: req.tenantInfo?.document || '',
          email: req.user?.email || '',
          phone: '', // Phone is deliberately empty as requested
          address: {},
        },
      });
      await config.save();
    }

    res.json(config);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PUT update global settings (Scoped by Tenant)
router.put('/', protect, authorize('owner', 'manager'), async (req, res) => {
  try {
    let config = await StoreConfig.findOne({ tenantId: req.tenantId });

    if (!config) {
      config = new StoreConfig({ ...req.body, tenantId: req.tenantId });
      await config.save();
    } else {
      // Security: Prevent tenantId overwrite
      const { tenantId, ...updates } = req.body;
      Object.assign(config, updates);
      await config.save();
    }

    res.json(config);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

export default router;
