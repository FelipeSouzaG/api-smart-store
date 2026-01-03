import express from 'express';
import User from '../models/User.js';
import TicketSale from '../models/TicketSale.js';
import Product from '../models/Product.js';
import ServiceOrder from '../models/ServiceOrder.js';
import Customer from '../models/Customer.js';
import CashTransaction from '../models/CashTransaction.js';
import { protect } from '../middleware/authMiddleware.js';
import jwt from 'jsonwebtoken';

const router = express.Router();

const SAAS_API_BASE = (
  process.env.SAAS_API_URL || 'http://localhost:4000/api'
).replace(/\/$/, '');

// Helper Fire-and-Forget para Telemetria 2.0
const sendTelemetry = async (tenantId) => {
  try {
    const url = `${SAAS_API_BASE}/admin/tenants/${tenantId}/telemetry`;

    // 1. Definição de Período (Mês Atual)
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    // 2. Coleta de Métricas (Execução paralela)
    const [
      salesCount,
      revenueResult,
      productsCount,
      customersCount,
      servicesCount,
      expensesCount,
    ] = await Promise.all([
      TicketSale.countDocuments({
        tenantId,
        timestamp: { $gte: startOfMonth },
      }),
      TicketSale.aggregate([
        { $match: { tenantId, timestamp: { $gte: startOfMonth } } },
        { $group: { _id: null, total: { $sum: '$total' } } },
      ]),
      Product.countDocuments({ tenantId }),
      Customer.countDocuments({ tenantId }),
      ServiceOrder.countDocuments({
        tenantId,
        createdAt: { $gte: startOfMonth },
      }),
      CashTransaction.countDocuments({
        tenantId,
        type: 'expense',
        timestamp: { $gte: startOfMonth },
      }),
    ]);

    const revenue = revenueResult.length > 0 ? revenueResult[0].total : 0;
    const averageTicket = salesCount > 0 ? revenue / salesCount : 0;

    // 3. Montagem do Payload
    const payload = {
      salesCount,
      revenue,
      productsCount,
      customersCount,
      averageTicket,
      activeModules: {
        pos: salesCount > 0,
        services: servicesCount > 0,
        financial: expensesCount > 0,
      },
      appVersion: '1.2.0',
    };

    // 4. Envio Assíncrono (Fire and Forget) com tratamento de SSL Local
    const isLocal =
      SAAS_API_BASE.includes('localhost') || SAAS_API_BASE.includes('.local.');
    const originalEnv = process.env.NODE_TLS_REJECT_UNAUTHORIZED;

    if (isLocal) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .catch((err) => {
        // Silencioso em falha para não poluir logs de produção
        // console.error("Telemetry failed:", err.message);
      })
      .finally(() => {
        if (isLocal) {
          if (originalEnv === undefined)
            delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
          else process.env.NODE_TLS_REJECT_UNAUTHORIZED = originalEnv;
        }
      });
  } catch (e) {
    // Erro interno silencioso
  }
};

// @route   GET api/auth/me
// @desc    Validate token and Establish Secure Session
// @access  Private
router.get('/me', protect, async (req, res) => {
  try {
    let existingUser = await User.findOne({
      _id: req.user.id,
      tenantId: req.tenantId,
    });

    if (!existingUser) {
      const newUser = new User({
        _id: req.user.id,
        tenantId: req.tenantId,
        name: req.user.name,
        email: req.user.email,
        role: req.user.role,
        password: 'integrated_account',
      });
      await newUser.save();
      existingUser = newUser;
    }

    const tokenPayload = {
      userId: existingUser._id,
      tenantId: existingUser.tenantId,
      role: existingUser.role,
      name: existingUser.name,
      email: existingUser.email,
      companyName: req.tenantInfo?.companyName,
      document: req.tenantInfo?.document,
      tenantName: req.tenantInfo?.tenantName,
    };

    const sessionToken = jwt.sign(tokenPayload, process.env.JWT_SECRET, {
      expiresIn: '1d',
    });

    // CONFIGURAÇÃO CRÍTICA DE COOKIES COM DOMÍNIO
    // O domínio deve incluir o ponto inicial (ex: .fluxoclean.com.br) para funcionar em todos os subdomínios
    const isProduction = process.env.NODE_ENV === 'production';
    let cookieDomain;

    if (isProduction) {
      cookieDomain = '.fluxoclean.com.br';
    } else {
      // Em desenvolvimento local com Docker/Nginx Proxy Manager
      cookieDomain = '.local.fluxoclean.com.br';
    }

    res.cookie('token', sessionToken, {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      domain: cookieDomain, // Essencial para persistir entre api.local... e outlet.local...
      maxAge: 24 * 60 * 60 * 1000, // 1 day
    });

    // Telemetria não bloqueante
    sendTelemetry(req.tenantId);

    res.status(200).json({
      user: existingUser,
      token: sessionToken,
    });
  } catch (err) {
    console.error('Auth/Me Error:', err.message);
    res.status(500).json({ message: 'Server Error' });
  }
});

router.post('/logout', (req, res) => {
  const isProduction = process.env.NODE_ENV === 'production';
  const cookieDomain = isProduction
    ? '.fluxoclean.com.br'
    : '.local.fluxoclean.com.br';

  res.cookie('token', '', {
    httpOnly: true,
    expires: new Date(0),
    secure: true,
    sameSite: 'none',
    domain: cookieDomain,
  });
  res.status(200).json({ message: 'Logged out' });
});

router.post('/login', (req, res) =>
  res
    .status(410)
    .json({ message: 'Login local desativado. Use o portal SaaS.' })
);
router.get('/system-status', (req, res) => res.json({ userCount: 1 }));

export default router;
