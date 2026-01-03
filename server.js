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
import storefrontRouter from './routes/storefront.js';
import ecommerceOrdersRouter from './routes/ecommerceOrders.js';
import systemRouter from './routes/system.js';
import subscriptionRouter from './routes/subscription.js';

const app = express();
const PORT = process.env.PORT || 4001;

app.set('trust proxy', 1);

app.use(helmet());
app.use(cookieParser());

app.use(
  cors({
    origin: function (origin, callback) {
      const allowedOrigins = process.env.ALLOWED_ORIGINS
        ? process.env.ALLOWED_ORIGINS.split(',')
        : [];

      if (
        !origin ||
        allowedOrigins.indexOf(origin) !== -1 ||
        origin.endsWith('.fluxoclean.com.br') ||
        origin.includes('localhost')
      ) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true,
  })
);

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(mongoSanitize());

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Muitas requisições deste IP, tente novamente mais tarde.',
});
app.use('/api', limiter);

const storefrontLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

const connectDB = async () => {
  if (!process.env.MONGODB_URI) return;
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Banco Mongo Smart Store Conectado');
  } catch (err) {
    console.error('MongoDB connection error:', err);
  }
};
connectDB();

app.get('/', (req, res) => {
  res.send('Smart Store API Running');
});

// Rotas Privadas (Dashboard)
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
app.use('/api/ecommerce-orders', ecommerceOrdersRouter);
app.use('/api/system', systemRouter);
app.use('/api/subscription', subscriptionRouter);

// Rotas Públicas (E-commerce)
app.use('/api/storefront', storefrontLimiter, storefrontRouter);

app.use((req, res, next) => {
  res.status(404).json({ message: 'Rota não encontrada.' });
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ message: 'Erro interno do servidor.' });
});

app.listen(PORT, () => {
  console.log(`Servidor Smart-Store Online na porta ${PORT}`);
});
