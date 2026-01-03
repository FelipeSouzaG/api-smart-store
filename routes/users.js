import express from 'express';
import User from '../models/User.js';
import jwt from 'jsonwebtoken';
import { protect, authorize } from '../middleware/authMiddleware.js';

const router = express.Router();

// Configuration for SaaS Central API
const SAAS_API_BASE = (
  process.env.SAAS_API_URL || 'http://localhost:4000/api'
).replace(/\/$/, '');
const SAAS_ENDPOINT = `${SAAS_API_BASE}/auth/sub-users`;

// Helper to sync with SaaS
const syncWithSaaS = async (method, endpoint, body, token) => {
  const url = `${SAAS_ENDPOINT}${endpoint}`;
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };

  try {
    // Tratamento SSL para Dev Local
    const isLocal =
      SAAS_API_BASE.includes('localhost') || SAAS_API_BASE.includes('.local.');
    const originalEnv = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    if (isLocal) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    // Restaura SSL
    if (isLocal) {
      if (originalEnv === undefined)
        delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = originalEnv;
    }

    if (!response.ok) {
      let errorDetails = 'Unknown error';
      try {
        const errorData = await response.json();
        errorDetails = errorData.message || response.statusText;
      } catch (e) {
        errorDetails = response.statusText;
      }

      throw new Error(
        `Falha na comunicação com SaaS (${response.status}): ${errorDetails}`
      );
    }

    return await response.json();
  } catch (error) {
    console.error(`[SaaS Sync Error] ${method} ${url}`, error.message);
    throw error;
  }
};

// ... (Restante do arquivo users.js mantido igual, apenas substituindo a função helper acima)

// @route   POST api/users/setup-owner
router.post('/setup-owner', async (req, res) => {
  const { name, email, password } = req.body;

  if (!name || !email || !password) {
    return res
      .status(400)
      .json({ message: 'Nome, email e senha são obrigatórios.' });
  }

  try {
    const userCount = await User.countDocuments();
    if (userCount > 0) {
      return res
        .status(403)
        .json({ message: 'O sistema já possui um administrador.' });
    }

    const defaultTenantId = 'standalone-tenant';
    const user = new User({
      name,
      email,
      password,
      role: 'owner',
      tenantId: defaultTenantId,
    });
    await user.save();

    const token = jwt.sign(
      { id: user._id, role: user.role, tenantId: user.tenantId },
      process.env.JWT_SECRET,
      { expiresIn: '1d' }
    );
    res.status(201).json({ token, user: user.toJSON() });
  } catch (err) {
    console.error(err.message);
    res
      .status(500)
      .json({ message: 'Erro no servidor ao registrar o administrador.' });
  }
});

// @route   POST api/users
router.post('/', protect, authorize('owner'), async (req, res) => {
  const { name, email, password, role } = req.body;
  let ownerToken = req.headers.authorization
    ? req.headers.authorization.split(' ')[1]
    : req.cookies.token;

  if (!name || !email || !password || !role) {
    return res
      .status(400)
      .json({ message: 'Todos os campos são obrigatórios.' });
  }

  if (role === 'owner') {
    return res
      .status(400)
      .json({ message: "Não é possível criar outro usuário 'owner'." });
  }

  try {
    let saasUser;
    try {
      saasUser = await syncWithSaaS(
        'POST',
        '',
        { name, email, password, role },
        ownerToken
      );
    } catch (syncError) {
      return res.status(502).json({
        message: `Erro de sincronização com servidor central: ${syncError.message}. Verifique a conexão.`,
        details: syncError.message,
      });
    }

    const user = new User({
      _id: saasUser._id, // Force ID sync
      name,
      email,
      password,
      role,
      tenantId: req.tenantId,
    });

    await user.save();

    res.status(201).json(user.toJSON());
  } catch (err) {
    console.error('Local Create User Error:', err.message);
    if (err.message.includes('já cadastrado') || err.code === 11000) {
      return res
        .status(400)
        .json({ message: 'Email já cadastrado no sistema local.' });
    }
    res
      .status(500)
      .json({ message: 'Erro interno ao salvar usuário: ' + err.message });
  }
});

// @route   GET api/users
router.get('/', protect, authorize('owner', 'manager'), async (req, res) => {
  try {
    const users = await User.find({ tenantId: req.tenantId })
      .select('-password')
      .sort({ name: 1 });
    res.json(users);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// @route   PUT api/users/profile
router.put('/profile', protect, async (req, res) => {
  const { name, email, password } = req.body;
  const token = req.headers.authorization
    ? req.headers.authorization.split(' ')[1]
    : req.cookies.token;

  try {
    const saasPayload = { name, email };
    if (password) saasPayload.password = password;

    try {
      await syncWithSaaS('PUT', `/${req.user.id}`, saasPayload, token);
    } catch (saasErr) {
      console.warn(
        'Aviso: Não foi possível sincronizar com o SaaS, atualizando apenas localmente.',
        saasErr.message
      );
    }

    let user = await User.findOne({ _id: req.user.id, tenantId: req.tenantId });

    if (!user) {
      user = new User({
        _id: req.user.id,
        tenantId: req.tenantId,
        name: name || req.user.name,
        email: email || req.user.email,
        role: req.user.role,
        password: password || 'integrated_account',
      });
    } else {
      user.name = name || user.name;
      user.email = email || user.email;
      if (password) {
        user.password = password;
      }
    }

    const updatedUser = await user.save();
    res.json(updatedUser.toJSON());
  } catch (err) {
    res
      .status(500)
      .json({ message: 'Erro ao atualizar perfil: ' + err.message });
  }
});

// @route   PUT api/users/:id
router.put('/:id', protect, authorize('owner'), async (req, res) => {
  const { name, email, password, role } = req.body;
  const ownerToken = req.headers.authorization
    ? req.headers.authorization.split(' ')[1]
    : req.cookies.token;

  if (!name || !email || !role) {
    return res
      .status(400)
      .json({ message: 'Nome, email e função são obrigatórios.' });
  }

  try {
    let user = await User.findOne({
      _id: req.params.id,
      tenantId: req.tenantId,
    });
    if (!user)
      return res.status(404).json({ message: 'Usuário não encontrado' });
    if (user.role === 'owner' && role !== 'owner')
      return res.status(400).json({
        message: 'A função do usuário "owner" não pode ser alterada.',
      });

    const saasPayload = { name, email, role };
    if (password) saasPayload.password = password;

    try {
      await syncWithSaaS('PUT', `/${req.params.id}`, saasPayload, ownerToken);
    } catch (syncErr) {
      return res
        .status(502)
        .json({
          message: 'Falha ao atualizar no servidor central. Tente novamente.',
        });
    }

    user.name = name;
    user.email = email;
    user.role = role;
    if (password) user.password = password;

    await user.save();
    res.json(user.toJSON());
  } catch (err) {
    res
      .status(500)
      .json({ message: 'Erro ao atualizar usuário: ' + err.message });
  }
});

// @route   DELETE api/users/:id
router.delete('/:id', protect, authorize('owner'), async (req, res) => {
  const ownerToken = req.headers.authorization
    ? req.headers.authorization.split(' ')[1]
    : req.cookies.token;
  try {
    const userToDelete = await User.findOne({
      _id: req.params.id,
      tenantId: req.tenantId,
    });
    if (!userToDelete)
      return res.status(404).json({ message: 'Usuário não encontrado' });
    if (userToDelete.role === 'owner')
      return res
        .status(400)
        .json({ message: 'O usuário "owner" não pode ser excluído.' });

    try {
      await syncWithSaaS('DELETE', `/${req.params.id}`, null, ownerToken);
    } catch (syncErr) {
      return res
        .status(502)
        .json({
          message: 'Falha ao excluir no servidor central. Acesso não revogado.',
        });
    }

    await User.findByIdAndDelete(req.params.id);
    res.status(200).json({ message: 'Usuário deletado com sucesso' });
  } catch (err) {
    res
      .status(500)
      .json({ message: 'Erro ao excluir usuário: ' + err.message });
  }
});

export default router;
