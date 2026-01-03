import StoreConfig from '../models/StoreConfig.js';

export const shopMiddleware = async (req, res, next) => {
  try {
    // O Frontend Next.js envia o domínio/slug neste header customizado
    const domain = req.headers['x-tenant-domain'];

    if (!domain) {
      return res
        .status(400)
        .json({ message: 'Domínio da loja não identificado.' });
    }

    // Busca a configuração da loja pelo slug (tenantName) ou domínio personalizado
    let config = await StoreConfig.findOne({
      $or: [{ tenantName: domain }, { customDomain: domain }],
    });

    // Fallback: Tenta extrair o slug se o domínio for um subdomínio técnico (ex: .local.fluxoclean.com.br)
    if (!config) {
      // Remove portas se houver (ex: host:3000) e divide
      const cleanDomain = domain.split(':')[0];
      const parts = cleanDomain.split('.');

      if (parts.length >= 1) {
        let potentialSlug = parts[0];

        // Remove sufixo específico de desenvolvimento/teste se presente no proxy reverso
        // Ex: "outlet-barreiro-smart-commerce" -> "outlet-barreiro"
        if (potentialSlug.endsWith('-smart-commerce')) {
          potentialSlug = potentialSlug.replace('-smart-commerce', '');
        }

        // Tenta buscar novamente apenas pelo primeiro segmento (slug limpo)
        config = await StoreConfig.findOne({ tenantName: potentialSlug });
      }
    }

    if (!config) {
      console.warn(
        `[ShopMiddleware] Loja não encontrada para o domínio: ${domain}`
      );
      return res.status(404).json({ message: 'Loja não encontrada.' });
    }

    // --- STATUS GUARD CLAUSE (BLOQUEIO) ---
    // 1. Check Explicit Status
    if (
      config.subscriptionStatus === 'blocked' ||
      config.subscriptionStatus === 'expired'
    ) {
      console.warn(
        `[ShopMiddleware] Loja BLOQUEADA por status: ${config.tenantName}`
      );
      return res.status(402).json({
        message:
          'Esta loja encontra-se temporariamente indisponível. Por favor, entre em contato com o administrador.',
      });
    }

    // 2. Check Expiration Date (Fail-safe se o cron do SaaS falhar)
    if (config.validUntil) {
      const now = new Date();
      const validUntil = new Date(config.validUntil);
      // Add a small grace period (e.g., end of the day) if needed, but strict is safer for now.
      if (now > validUntil) {
        console.warn(
          `[ShopMiddleware] Loja BLOQUEADA por validade (${validUntil.toISOString()}): ${
            config.tenantName
          }`
        );
        return res.status(402).json({
          message:
            'Esta loja encontra-se temporariamente indisponível. Por favor, entre em contato com o administrador.',
        });
      }
    }
    // --------------------------------------

    // Injeta o ID do tenant na requisição para que as rotas filtrem os produtos corretamente
    req.tenantId = config.tenantId;
    req.storeConfig = config;

    next();
  } catch (error) {
    console.error('Shop Middleware Error:', error);
    res.status(500).json({ message: 'Erro interno ao identificar loja.' });
  }
};
