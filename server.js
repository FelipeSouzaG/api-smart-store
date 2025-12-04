import 'dotenv/config';
import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import mongoSanitize from 'express-mongo-sanitize';
import cookieParser from 'cookie-parser';

import productsRouter from './routes/products.js';
import servicesRouter from './routes/services.js';
import serviceOrdersRouter from './routes/serviceOrders.js';
import purchasesRouter from './routes/purchases.js';
import transactionsRouter from './routes/transactions.js';
import salesRouter from './routes/sales.js';
import insightsRouter from './routes/insights.js';
import authRouter from './routes/auth.js';
import usersRouter from './routes/users.js';
import customersRouter from './routes/customers.js';
import suppliersRouter from './routes/suppliers.js';
import settingsRouter from './routes/settings.js';

// Validação de Variáveis Críticas
const requiredEnvVars = ['JWT_SECRET', 'MONGODB_URI', 'SAAS_API_URL'];

if (process.env.NODE_ENV === 'production') {
  const missingVars = requiredEnvVars.filter((key) => !process.env[key]);
  if (missingVars.length > 0) {
    console.error(
      'FATAL ERROR: Missing required environment variables:',
      missingVars.join(', ')
    );
    process.exit(1);
  }
}

const app = express();
const PORT = process.env.PORT || 4001;

app.set('trust proxy', 1);

app.use(helmet());
app.use(cookieParser());

// CORS Configuration
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : [process.env.FLUXOCLEAN, process.env.SMARTSTORE].filter(Boolean);

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);

      if (
        allowedOrigins.indexOf(origin) !== -1 ||
        process.env.NODE_ENV !== 'production'
      ) {
        return callback(null, true);
      } else {
        return callback(new Error('Not allowed by CORS'), false);
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  })
);

app.use(express.json({ limit: '10kb' }));
app.use(mongoSanitize());

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Muitas requisições deste IP, tente novamente mais tarde.',
  keyGenerator: (req) => {
    return req.ip || req.headers['x-forwarded-for'] || 'unknown';
  },
});
app.use('/api', limiter);

const connectDB = async () => {
  if (!process.env.MONGODB_URI) return;
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Conectado ao banco SmartStore');
  } catch (err) {
    console.error('❌ MongoDB connection error:', err);
  }
};
connectDB();

app.get('/', (req, res) => {
  res.send('Smart Store API Running');
});

app.use('/api/auth', authRouter);
app.use('/api/users', usersRouter);
app.use('/api/products', productsRouter);
app.use('/api/services', servicesRouter);
app.use('/api/service-orders', serviceOrdersRouter);
app.use('/api/purchases', purchasesRouter);
app.use('/api/transactions', transactionsRouter);
app.use('/api/sales', salesRouter);
app.use('/api/insights', insightsRouter);
app.use('/api/customers', customersRouter);
app.use('/api/suppliers', suppliersRouter);
app.use('/api/settings', settingsRouter);

app.use((req, res, next) => {
  res.status(404).json({ message: 'Rota não encontrada.' });
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ message: 'Erro interno do servidor.' });
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor SmartStore rodando na porta ${PORT}`);
});
