import express from 'express';
const router = express.Router();
import StoreConfig from '../models/StoreConfig.js';
import { protect, authorize } from '../middleware/authMiddleware.js';

// Configuration for SaaS Central API
const SAAS_API_BASE = (
  process.env.SAAS_API_URL || 'http://localhost:4000/api'
).replace(/\/$/, '');

// Helper to sync with SaaS (Admin Routes)
const syncConfigWithSaaS = async (tenantId, data) => {
  const url = `${SAAS_API_BASE}/admin/tenants/${tenantId}/sync-store-config`;

  try {
    const isLocal =
      SAAS_API_BASE.includes('localhost') || SAAS_API_BASE.includes('.local.');
    const originalEnv = process.env.NODE_TLS_REJECT_UNAUTHORIZED;

    // Permite certificado auto-assinado em desenvolvimento
    if (isLocal) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    });

    // Restaura configuração de segurança
    if (isLocal) {
      if (originalEnv === undefined)
        delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = originalEnv;
    }

    if (!response.ok) {
      const errText = await response.text();
      console.warn(
        `⚠️ [SaaS Sync] Falha ao sincronizar (${response.status}): ${errText}`
      );
    } else {
      // Sucesso silencioso
    }
  } catch (error) {
    console.error(
      `❌ [SaaS Sync Error] Falha de conexão com ${SAAS_API_BASE}:`,
      error.message
    );
  }
};

// GET global settings (Scoped by Tenant)
router.get('/', protect, async (req, res) => {
  try {
    let config = await StoreConfig.findOne({ tenantId: req.tenantId });

    if (!config) {
      config = new StoreConfig({
        tenantId: req.tenantId,
        tenantName: req.tenantInfo?.tenantName || '',
        companyInfo: {
          name: req.tenantInfo?.companyName || '',
          cnpjCpf: req.tenantInfo?.document || '',
          email: req.user?.email || '',
          phone: '',
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

// Proxy para CEP com Fallback (ViaCEP -> BrasilAPI)
router.get('/cep/:cep', protect, async (req, res) => {
  const { cep } = req.params;

  if (!cep || !/^\d{8}$/.test(cep)) {
    return res
      .status(400)
      .json({ message: 'CEP inválido. Deve conter 8 números.' });
  }

  // Formata resposta do BrasilAPI para padrão ViaCEP
  const formatBrasilApi = (data) => ({
    logradouro: data.street,
    bairro: data.neighborhood,
    localidade: data.city,
    uf: data.state,
    cep: data.cep,
    erro: false,
  });

  try {
    // 1. Tenta ViaCEP
    const response = await fetch(`https://viacep.com.br/ws/${cep}/json/`);
    if (response.ok) {
      const data = await response.json();
      if (!data.erro) {
        return res.json(data);
      }
    }
  } catch (error) {
    console.warn(`[Proxy CEP] ViaCEP falhou para ${cep}, tentando fallback...`);
  }

  try {
    // 2. Fallback: BrasilAPI (Muitas vezes mais rápido e permissivo)
    const responseBackup = await fetch(
      `https://brasilapi.com.br/api/cep/v1/${cep}`
    );
    if (responseBackup.ok) {
      const dataBackup = await responseBackup.json();
      return res.json(formatBrasilApi(dataBackup));
    }
  } catch (error) {
    console.error(`[Proxy CEP] BrasilAPI falhou para ${cep}:`, error.message);
  }

  // Se chegou aqui, ambos falharam ou não encontraram
  return res
    .status(400)
    .json({ message: 'CEP não encontrado ou serviços indisponíveis.' });
});

// INTERNAL: Sincronização de Status (Bloqueio/Desbloqueio) via SaaS
router.post('/internal/sync-status', async (req, res) => {
  const { tenantId, status, validUntil } = req.body;

  if (!tenantId || !status) {
    return res.status(400).json({ message: 'Dados incompletos' });
  }

  try {
    const updateData = { subscriptionStatus: status };
    if (validUntil) {
      updateData.validUntil = new Date(validUntil);
    }

    const config = await StoreConfig.findOneAndUpdate(
      { tenantId },
      { $set: updateData },
      { new: true, upsert: false } // Não cria se não existir, pois loja deve ser iniciada pelo user
    );

    if (config) {
      // console.log(`✅ [Sync] Status da loja ${tenantId} atualizado para: ${status}`);
      res.json({ success: true, status: config.subscriptionStatus });
    } else {
      console.warn(
        `⚠️ [Sync] Loja não encontrada para tenant ${tenantId}. Ignorando.`
      );
      res.status(404).json({ message: 'Loja não configurada ainda.' });
    }
  } catch (err) {
    console.error('Erro na sincronização de status:', err);
    res.status(500).json({ message: err.message });
  }
});

// INTERNAL: Rota para atualização via SuperAdmin (API FluxoClean)
// Permite sincronizar o status do Google Business quando o serviço é concluído no painel administrativo
router.post('/internal/google-business', async (req, res) => {
  const { tenantId, googleBusiness } = req.body;

  if (!tenantId || !googleBusiness) {
    return res.status(400).json({ message: 'Dados incompletos' });
  }

  try {
    // Find by tenantId string
    let config = await StoreConfig.findOne({ tenantId });

    if (!config) {
      // Se não existir config (raro, mas possível se o usuário nunca logou), cria
      config = new StoreConfig({ tenantId });
    }

    // Conversão para objeto para garantir merge limpo se for subdocumento
    const currentGb = config.googleBusiness
      ? typeof config.googleBusiness.toObject === 'function'
        ? config.googleBusiness.toObject()
        : config.googleBusiness
      : {};

    // Atualização forçada
    config.set('googleBusiness', {
      ...currentGb,
      ...googleBusiness,
    });

    // Marca como modificado explicitamente
    config.markModified('googleBusiness');

    const savedConfig = await config.save();
    // console.log(`[Internal] Google Business atualizado para tenant ${tenantId}`);

    res.json({ success: true, googleBusiness: savedConfig.googleBusiness });
  } catch (err) {
    console.error('Erro na atualização interna:', err);
    res.status(500).json({ message: err.message });
  }
});

// PUT update global settings (Scoped by Tenant)
// Esta rota é usada tanto pelo Frontend (salvar configurações) quanto pelo SaaS (Seeding inicial)
router.put('/', protect, authorize('owner', 'manager'), async (req, res) => {
  try {
    let config = await StoreConfig.findOne({ tenantId: req.tenantId });

    // Preparar dados de atualização
    const { tenantId, legalAgreement, ...updates } = req.body;

    if (!config) {
      config = new StoreConfig({ tenantId: req.tenantId });
    }

    // Aplicar atualizações gerais (Nome da empresa, CNPJ, etc)
    Object.assign(config, updates);

    // Lógica de Auditoria Jurídica (Se o frontend enviou o aceite)
    if (legalAgreement && legalAgreement.accepted) {
      const clientIp = req.headers['x-forwarded-for'] || req.ip;
      const userAgent = req.headers['user-agent'];

      config.legalAgreement = {
        accepted: true,
        acceptedAt: new Date(),
        version: 'v1.0-2025',
        ipAddress:
          typeof clientIp === 'string' ? clientIp.split(',')[0] : clientIp,
        userAgent: userAgent,
      };

      config.isSetupComplete = true;

      // console.log(`[Legal] Contrato aceito por ${req.user.email}`);
    } else if (!config.legalAgreement?.accepted) {
      config.isSetupComplete = false;
    }

    await config.save();

    // --- SYNC WITH SAAS (Fire and Forget) ---
    const configObj = config.toObject();

    const syncData = {
      companyInfo: configObj.companyInfo,
      legalAgreement: configObj.legalAgreement,
      googleBusiness: configObj.googleBusiness,
      ecommercePolicies: configObj.ecommercePolicies,
    };

    syncConfigWithSaaS(req.tenantId, syncData);
    // ----------------------------------------

    res.json(config);
  } catch (err) {
    console.error('Settings Update Error:', err);
    res.status(400).json({ message: err.message });
  }
});

// PUT confirm Google Business Match OR Dismiss Prompt OR Mark Success as Shown
router.put(
  '/google-business',
  protect,
  authorize('owner', 'manager'),
  async (req, res) => {
    const { status, placeData, dismissed, successShown } = req.body;

    try {
      let config = await StoreConfig.findOne({ tenantId: req.tenantId });
      if (!config) return res.status(404).json({ message: 'Config not found' });

      if (dismissed !== undefined) {
        config.googleBusiness.dismissedPrompt = dismissed;
      }

      if (successShown !== undefined) {
        config.googleBusiness.successShown = successShown;
      }

      if (status === 'verified' && placeData) {
        config.googleBusiness = {
          ...config.googleBusiness,
          status: 'verified',
          placeId: placeData.placeId,
          name: placeData.name,
          address: placeData.address,
          rating: placeData.rating,
          mapsUri: placeData.mapsUri,
          websiteUri: placeData.websiteUri,
          verifiedAt: new Date(),
          dismissedPrompt: false,
        };
      } else if (status === 'not_found') {
        config.googleBusiness = {
          ...config.googleBusiness,
          status: 'not_found',
          verifiedAt: new Date(),
        };
      }

      await config.save();

      const syncData = {
        googleBusiness: config.googleBusiness,
      };

      syncConfigWithSaaS(req.tenantId, syncData);

      res.json(config.googleBusiness);
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

export default router;
