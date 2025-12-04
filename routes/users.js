import express from 'express';
import User from '../models/User.js';
import jwt from 'jsonwebtoken';
import { protect, authorize } from '../middleware/authMiddleware.js';

const router = express.Router();

// Configuration for SaaS Central API
const SAAS_API_URL = 'http://localhost:4000/api/auth/sub-users';

// Helper to sync with SaaS
const syncWithSaaS = async (method, endpoint, body, token) => {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`, // Pass the owner's token to authorize the action in SaaS
  };

  const response = await fetch(`${SAAS_API_URL}${endpoint}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(
      errorData.message || 'Erro na comunicação com o servidor central (SaaS).'
    );
  }

  return await response.json();
};

// @route   POST api/users/setup-owner
// @desc    Register the first user as 'owner' (Legacy/Offline fallback)
// @access  Public
router.post('/setup-owner', async (req, res) => {
  // This remains local-only or could be deprecated if strict SaaS is enforced.
  // Leaving as is for "First Run" logic if network is down, but ideally registration happens on SaaS.
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

    // Generate a local token for immediate use
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
// @desc    Register a new user (Syncs with SaaS)
// @access  Private (Owner only)
router.post('/', protect, authorize('owner'), async (req, res) => {
  const { name, email, password, role } = req.body;
  const ownerToken = req.headers.authorization.split(' ')[1];

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
    // 1. Create in SaaS Backend first (Source of Truth for Login)
    // This returns the generated _id from SaaS DB
    const saasUser = await syncWithSaaS(
      'POST',
      '',
      { name, email, password, role },
      ownerToken
    );

    // 2. Create in Local Tenant DB using the SAME _id
    // This ensures relationships (e.g. sales made by user) work across the system
    const user = new User({
      _id: saasUser._id, // Force ID sync
      name,
      email,
      password, // We store hash locally too for fallback/offline auth if needed later
      role,
      tenantId: req.tenantId,
    });

    await user.save();

    res.status(201).json(user.toJSON());
  } catch (err) {
    console.error(err.message);
    // Handle duplicate email error specifically
    if (err.message.includes('já cadastrado')) {
      return res.status(400).json({ message: err.message });
    }
    res.status(500).json({ message: 'Erro ao criar usuário: ' + err.message });
  }
});

// @route   GET api/users
// @desc    Get all users
// @access  Private (Owner only)
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
// @desc    Update logged-in user's own profile
// @access  Private (Any authenticated user)
router.put('/profile', protect, async (req, res) => {
  const { name, email, password } = req.body;
  const token = req.headers.authorization.split(' ')[1];

  try {
    // 1. Sync with SaaS (Primary Auth Source)
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

    // 2. Update Local (Or Create if missing - Fix for Owner)
    let user = await User.findOne({ _id: req.user.id, tenantId: req.tenantId });

    if (!user) {
      // Lazy Create if Owner profile is missing locally
      user = new User({
        _id: req.user.id,
        tenantId: req.tenantId,
        name: name || req.user.name,
        email: email || req.user.email,
        role: req.user.role,
        password: password || 'integrated_account',
      });
    } else {
      // Update existing
      user.name = name || user.name;
      user.email = email || user.email;
      if (password) {
        user.password = password; // Will be hashed by pre-save hook
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
// @desc    Update a user (Owner updating Sub-User)
// @access  Private (Owner)
router.put('/:id', protect, authorize('owner'), async (req, res) => {
  const { name, email, password, role } = req.body;
  const ownerToken = req.headers.authorization.split(' ')[1];

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
      return res
        .status(400)
        .json({
          message: 'A função do usuário "owner" não pode ser alterada.',
        });

    // 1. Sync with SaaS
    const saasPayload = { name, email, role };
    if (password) saasPayload.password = password;
    await syncWithSaaS('PUT', `/${req.params.id}`, saasPayload, ownerToken);

    // 2. Update Local
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
// @desc    Delete a user
// @access  Private (Owner)
router.delete('/:id', protect, authorize('owner'), async (req, res) => {
  const ownerToken = req.headers.authorization.split(' ')[1];
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

    // 1. Sync with SaaS (Delete central access)
    await syncWithSaaS('DELETE', `/${req.params.id}`, null, ownerToken);

    // 2. Delete Local
    await User.findByIdAndDelete(req.params.id);
    res.status(200).json({ message: 'Usuário deletado com sucesso' });
  } catch (err) {
    res
      .status(500)
      .json({ message: 'Erro ao excluir usuário: ' + err.message });
  }
});

export default router;
