import express from 'express';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

const SAAS_API_BASE = (
  process.env.SAAS_API_URL || 'http://localhost:4000/api'
).replace(/\/$/, '');

// @route   GET api/system/broadcasts
// @desc    Busca comunicados ativos do servidor central para o usuário atual
// @access  Private
router.get('/broadcasts', protect, async (req, res) => {
  try {
    const userRole = req.user.role;
    const url = `${SAAS_API_BASE}/communication/broadcasts?role=${userRole}`;

    // Tratamento SSL para Dev Local
    const isLocal =
      SAAS_API_BASE.includes('localhost') || SAAS_API_BASE.includes('.local.');
    const originalEnv = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    if (isLocal) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    // Restaura SSL
    if (isLocal) {
      if (originalEnv === undefined)
        delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = originalEnv;
    }

    if (response.ok) {
      const data = await response.json();
      res.json(data);
    } else {
      console.warn(`[System] Falha ao buscar broadcasts: ${response.status}`);
      res.json([]);
    }
  } catch (error) {
    console.error('Erro ao buscar broadcasts:', error.message);
    res.json([]);
  }
});

export default router;
