import express from 'express';
import Product from '../models/Product.js';
import Service from '../models/Service.js';
import EcommerceOrder from '../models/EcommerceOrder.js';
import { shopMiddleware } from '../middleware/shopMiddleware.js';

const router = express.Router();

// Aplica o middleware de identificação da loja em todas as rotas
router.use(shopMiddleware);

// @route   GET api/storefront/config
// @desc    Retorna dados públicos da loja (Nome, Cor, Logo, Contato, Políticas)
router.get('/config', async (req, res) => {
  try {
    const config = req.storeConfig;

    // Retorna apenas dados seguros/públicos
    const publicData = {
      name: config.companyInfo.name,
      phone: config.companyInfo.phone,
      email: config.companyInfo.email,
      address: config.companyInfo.address,
      logo: config.googleBusiness?.logo || null, // Se houver
      themeColor: '#4F46E5', // Poderia vir do banco no futuro
      bannerUrl: null, // Poderia vir do banco
      // Políticas Legais (Segurança B2C)
      ecommercePolicies: config.ecommercePolicies || {},
    };

    res.json(publicData);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// @route   GET api/storefront/products
// @desc    Lista produtos E SERVIÇOS disponíveis para venda online
router.get('/products', async (req, res) => {
  try {
    const { category, search } = req.query;

    // 1. Build Queries
    const productQuery = {
      tenantId: req.tenantId,
      stock: { $gt: 0 },
      publishToWeb: true,
    };

    const serviceQuery = {
      tenantId: req.tenantId,
      publishToWeb: true,
    };

    // 2. Handle Search (Text search in both)
    if (search) {
      const regex = { $regex: search, $options: 'i' };
      productQuery.name = regex;

      // For services, search in name, brand or model
      serviceQuery.$or = [{ name: regex }, { brand: regex }, { model: regex }];
    }

    // 3. Handle Category Filter
    let fetchProducts = true;
    let fetchServices = true;

    if (category) {
      if (category === 'Serviços') {
        fetchProducts = false;
      } else {
        // Se for uma categoria de produto específica, não busca serviços
        productQuery.category = category;
        fetchServices = false;
      }
    }

    // 4. Parallel Execution
    const promises = [];
    if (fetchProducts) {
      promises.push(
        Product.find(productQuery)
          .select(
            'name price category brand model description image ecommerceDetails'
          )
          .lean()
      );
    } else {
      promises.push(Promise.resolve([]));
    }

    if (fetchServices) {
      promises.push(
        Service.find(serviceQuery)
          .select('name brand model price image ecommerceDetails')
          .lean()
      );
    } else {
      promises.push(Promise.resolve([]));
    }

    const [productsRaw, servicesRaw] = await Promise.all(promises);

    // 5. Normalize and Combine
    const products = productsRaw.map((p) => ({ ...p, type: 'product' }));

    const services = servicesRaw.map((s) => ({
      ...s,
      id: s._id, // Normalize ID
      name: `${s.name} - ${s.brand} ${s.model}`, // Create display name
      category: 'Serviços', // Hardcode category for UI filtering
      type: 'service',
      stock: 999, // Infinite stock for services
    }));

    // Combine and Shuffle/Sort (Simple sort by name for now)
    const combined = [...products, ...services].sort((a, b) =>
      a.name.localeCompare(b.name)
    );

    res.json(combined);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// @route   GET api/storefront/products/:id
// @desc    Detalhes de um produto específico (ou serviço)
router.get('/products/:id', async (req, res) => {
  try {
    // Try finding in products first
    let item = await Product.findOne({
      _id: req.params.id,
      tenantId: req.tenantId,
      publishToWeb: true,
    }).lean();

    if (item) {
      item.type = 'product';
      return res.json(item);
    }

    // If not found, try services
    item = await Service.findOne({
      _id: req.params.id,
      tenantId: req.tenantId,
      publishToWeb: true,
    }).lean();

    if (item) {
      item.type = 'service';
      item.name = `${item.name} - ${item.brand} ${item.model}`; // Normalize name
      item.category = 'Serviços';
      return res.json(item);
    }

    return res.status(404).json({ message: 'Item não encontrado' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// @route   POST api/storefront/checkout
// @desc    Registra o pedido do E-commerce e retorna Link e ID
router.post('/checkout', async (req, res) => {
  try {
    const { items, customer } = req.body;
    const config = req.storeConfig;

    if (!items || items.length === 0) {
      return res.status(400).json({ message: 'Carrinho vazio.' });
    }

    let total = 0;
    const orderItems = [];

    for (const item of items) {
      // Determine collection based on type hint or fallback check
      let dbItem = null;
      let type = 'product';

      // Try finding in Product first
      dbItem = await Product.findOne({ _id: item.id, tenantId: req.tenantId });

      // If not found, try Service
      if (!dbItem) {
        dbItem = await Service.findOne({
          _id: item.id,
          tenantId: req.tenantId,
        });
        if (dbItem) type = 'service';
      }

      if (dbItem) {
        const subtotal = item.unitPrice * item.quantity;
        total += subtotal;

        // Normalize name for order record
        let productName = dbItem.name;
        if (type === 'service') {
          productName = `${dbItem.name} - ${dbItem.brand} ${dbItem.model}`;
        }

        orderItems.push({
          productId: dbItem.id,
          productName: productName,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          image: dbItem.image,
          type: type, // Explicitly store type for backend split logic
        });
      }
    }

    // 2. Gerar ID do Pedido (SC-AAAAMMSSSS)
    const now = new Date();
    const year = now.getFullYear();
    const month = (now.getMonth() + 1).toString().padStart(2, '0');
    const prefix = `SC-${year}${month}`;

    const count = await EcommerceOrder.countDocuments({
      tenantId: req.tenantId,
      _id: new RegExp(`^${prefix}`),
    });

    const sequence = (count + 1).toString().padStart(4, '0');
    const orderId = `${prefix}${sequence}`;

    // 3. Salvar Pedido
    const newOrder = new EcommerceOrder({
      tenantId: req.tenantId,
      _id: orderId,
      customer: {
        name: customer.name,
        phone: customer.phone,
        address: customer.address,
      },
      items: orderItems,
      total: total,
      status: 'PENDING',
    });

    await newOrder.save();

    // 4. Gerar Link WhatsApp (Formatado)
    if (config.companyInfo.phone) {
      let message = `*Olá! Acabei de fazer o pedido #${orderId} no site.*\n\n`;
      message += `*Cliente:* ${customer.name}\n`;
      message += `*Endereço:* ${customer.address.street}, ${customer.address.number} - ${customer.address.neighborhood}\n`;
      message += `*Cidade:* ${customer.address.city}/${customer.address.state}\n\n`;
      message += `*Itens do Pedido:*\n`;

      orderItems.forEach((item) => {
        const typeLabel = item.type === 'service' ? '[SERVIÇO]' : '';
        message += `▪️ ${typeLabel} ${item.quantity}x ${
          item.productName
        } (R$ ${item.unitPrice.toFixed(2)})\n`;
      });

      message += `\n*Total a Pagar: R$ ${total.toFixed(2)}*`;
      message += `\n\n_Aguardo instruções para pagamento e envio/agendamento. Obrigado!_`;

      const phoneClean = config.companyInfo.phone.replace(/\D/g, '');
      const whatsappLink = `https://wa.me/55${phoneClean}?text=${encodeURIComponent(
        message
      )}`;

      return res.json({
        success: true,
        orderId,
        whatsappLink,
        message: 'Pedido realizado com sucesso!',
      });
    }

    res.json({ success: true, orderId, message: 'Pedido registrado.' });
  } catch (err) {
    console.error('Checkout Error:', err);
    res.status(500).json({ message: err.message });
  }
});

export default router;
