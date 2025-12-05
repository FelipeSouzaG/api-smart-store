
import jwt from 'jsonwebtoken';
import User from '../models/User.js';

const getJwtSecret = () => {
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET is missing in environment variables.');
  }
  return process.env.JWT_SECRET;
};

export const protect = async (req, res, next) => {
  let token;

  const csrfHeader = req.headers['x-requested-with'];

  const isBearerAuth =
    req.headers.authorization && req.headers.authorization.startsWith('Bearer');

  if (!isBearerAuth && (!csrfHeader || csrfHeader !== 'XMLHttpRequest')) {
    if (req.cookies && req.cookies.token) {
      return res
        .status(403)
        .json({ message: 'Falha de segurança CSRF: Cabeçalho ausente.' });
    }
  }

  try {
    if (req.cookies && req.cookies.token) {
      token = req.cookies.token;
    } else if (isBearerAuth) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      return res
        .status(401)
        .json({ message: 'Não autorizado, nenhum token fornecido.' });
    }

    const decoded = jwt.verify(token, getJwtSecret());

    if (!decoded.tenantId) {
      return res
        .status(401)
        .json({ message: 'Token inválido: Violação de isolamento.' });
    }

    req.tenantId = decoded.tenantId;
    req.tenantInfo = {
      companyName: decoded.companyName,
      document: decoded.document,
      tenantName: decoded.tenantName, // Extracted slug
    };

    req.user = await User.findOne({
      _id: decoded.userId,
      tenantId: req.tenantId,
    }).select('-password');

    if (!req.user) {
      req.user = {
        id: decoded.userId,
        role: decoded.role,
        tenantId: decoded.tenantId,
        name: decoded.name || 'Usuário',
        email: decoded.email || '',
      };
    }

    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res
        .status(401)
        .json({ message: 'Falha de Segurança: Token inválido.' });
    }

    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        message: 'Sua sessão expirou. Por favor, faça login novamente.',
      });
    }

    res.status(401).json({ message: 'Não autorizado.' });
  }
};

export const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({
        message: `Acesso negado. A função '${req.user.role}' não tem permissão.`,
      });
    }
    next();
  };
};
