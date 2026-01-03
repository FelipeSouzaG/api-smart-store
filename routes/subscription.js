import express from 'express';
const router = express.Router();
import { protect } from '../middleware/authMiddleware.js';

const SAAS_API_BASE = (
  process.env.SAAS_API_URL || 'http://localhost:4000/api'
).replace(/\/$/, '');

// Proxy para verificar pagamento
// O frontend chama esta rota localmente, e esta rota chama o SaaS Server-to-Server
router.post('/check-payment/:reference', protect, async (req, res) => {
  const { reference } = req.params;
  const url = `${SAAS_API_BASE}/subscription/check-payment/${reference}`;

  try {
    // Recupera o token para autenticação no SaaS
    let token = req.headers.authorization?.split(' ')[1];
    if (!token && req.cookies && req.cookies.token) {
      token = req.cookies.token;
    }

    // Tratamento SSL para Dev Local
    const isLocal =
      SAAS_API_BASE.includes('localhost') || SAAS_API_BASE.includes('.local.');
    const originalEnv = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    if (isLocal) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
    });

    // Restaura SSL
    if (isLocal) {
      if (originalEnv === undefined)
        delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = originalEnv;
    }

    const data = await response.json();

    // Repassa o status e resposta exata do SaaS
    res.status(response.status).json(data);
  } catch (error) {
    console.error(
      `[Subscription Proxy] Error calling ${SAAS_API_BASE}:`,
      error.message
    );
    res
      .status(500)
      .json({ message: 'Erro de comunicação com servidor de pagamentos.' });
  }
});

export default router;
