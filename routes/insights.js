import express from 'express';
import { GoogleGenAI } from '@google/genai';
import { protect } from '../middleware/authMiddleware.js';
import StoreConfig from '../models/StoreConfig.js';
const router = express.Router();

// Inicializa o cliente Gemini com a chave de API do ambiente (conforme regras estritas)
// Nota: Em produção, certifique-se que API_KEY está definida no .env
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

/**
 * Função dedicada para consultar a Google Places API (Text Search New)
 * Retorna LISTA de candidatos para o usuário escolher.
 */
const searchGooglePlaces = async (name, addressData) => {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;

  if (!apiKey) {
    console.warn('⚠️ GOOGLE_MAPS_API_KEY não encontrada.');
    return [];
  }

  // Busca ampla: Nome + Bairro + Cidade
  const query = `${name} ${addressData.neighborhood || ''} ${
    addressData.city || ''
  }`;
  const url = 'https://places.googleapis.com/v1/places:searchText';

  try {
    console.log(`🗺️ Consultando Google Places (Lista): "${query}"`);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        // Incluindo websiteUri para análise de e-commerce
        'X-Goog-FieldMask':
          'places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.googleMapsUri,places.websiteUri,places.id',
      },
      body: JSON.stringify({ textQuery: query }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(
        `❌ Erro Google Maps API (${response.status}): ${errorBody}`
      );
      return [];
    }

    const data = await response.json();

    if (data.places && data.places.length > 0) {
      return data.places.map((place) => ({
        placeId: place.id,
        name: place.displayName ? place.displayName.text : 'Sem nome',
        address: place.formattedAddress || '',
        rating: place.rating || 0,
        userRatingCount: place.userRatingCount || 0,
        mapsUri: place.googleMapsUri,
        websiteUri: place.websiteUri || null,
      }));
    }

    return [];
  } catch (error) {
    console.error('❌ Exceção na requisição Google Places:', error.message);
    return [];
  }
};

// @route   POST api/insights
// @desc    Gera insights estratégicos com Gemini baseados nos KPIs
// @access  Private
router.post('/', protect, async (req, res) => {
  try {
    const { kpis } = req.body;
    if (!kpis)
      return res
        .status(400)
        .json({ message: 'Dados de KPI são obrigatórios.' });

    const model = 'gemini-3-flash-preview';

    // Prompt Ajustado: Tom Neutro, Prático e Educativo (Sem metáforas)
    const prompt = `
            Atue como um analista financeiro prático, focado em ajudar pequenos empreendedores.
            Analise os dados da loja "${
              kpis.goals?.companyInfo?.name || 'da Empresa'
            }" com as seguintes informações:

            SITUAÇÃO FINANCEIRA (Caixa Real):
            - Saldo em Dinheiro Hoje: R$ ${kpis.cashBalance?.toFixed(2) || '0'}
            - Dinheiro que Entrou (Recebimentos): R$ ${
              kpis.totalInflows?.toFixed(2) || '0'
            }
            - Dinheiro que Saiu (Pagamentos): R$ ${
              kpis.totalOutflows?.toFixed(2) || '0'
            }

            RESULTADO OPERACIONAL (Econômico/DRE):
            - Lucro das Vendas: R$ ${kpis.currentNetProfit?.toFixed(2) || '0'}
            - Total Vendido: R$ ${
              kpis.currentRevenue?.toFixed(2) || '0'
            } (Meta: R$ ${kpis.totalRevenueGoal?.toFixed(2) || '0'})
            - Custos Fixos Pagos: R$ ${kpis.fixedCosts?.toFixed(2) || '0'}
            - Margem de Contribuição: ${
              kpis.currentAvgContributionMargin?.toFixed(1) || '0'
            }% (Esperado: ${kpis.goals?.predictedAvgMargin || 'N/A'}%)
            
            DADOS DE ESTOQUE:
            - Giro Projetado: ${
              kpis.projectedInventoryTurnover?.toFixed(2) || '0'
            }x
            - Produtos em Falta: ${kpis.stockLevelSummary?.ruptura || 0}
            - Produtos Parados: ${kpis.stockLevelSummary?.excesso || 0}

            TAREFA:
            Escreva um diagnóstico curto e objetivo.
            Crucial: Explique a diferença entre o resultado operacional (Lucro) e o dinheiro disponível (Caixa).
            - Use linguagem simples e neutra. Evite termos técnicos difíceis, metáforas ou ditados populares.
            - Se o Lucro é positivo mas o Caixa é negativo, explique que o dinheiro foi usado para pagar contas ou comprar estoque antes da venda.
            - Se o Caixa é positivo mas o Lucro é baixo, explique que pode ser dinheiro de vendas antigas ou empréstimos, e não lucro real da operação atual.

            FORMATO DA RESPOSTA:
            1. 📊 Análise do Caixa vs. Lucro: (Explicação clara da situação financeira atual).
            2. ✅ O que está bom: (Um ponto positivo nos dados).
            3. 💡 O que fazer agora: (3 ações práticas e diretas para melhorar nesta semana).
        `;

    const response = await ai.models.generateContent({
      model: model,
      contents: prompt,
      config: {
        temperature: 0.5, // Reduzido para ser mais objetivo e menos criativo/figurado
        maxOutputTokens: 8192,
      },
    });

    const text = response.text;

    if (!text) {
      throw new Error('Gemini não retornou texto.');
    }

    res.json({ insights: text });
  } catch (error) {
    console.error('Erro ao gerar insights com Gemini:', error);
    res
      .status(500)
      .json({ message: 'Erro ao processar inteligência artificial.' });
  }
});

// @route   POST api/insights/growth-check
// Retorna LISTA de candidatos ou status salvo
router.post('/growth-check', protect, async (req, res) => {
  try {
    const configData = await StoreConfig.findOne({ tenantId: req.tenantId });
    if (
      !configData ||
      !configData.companyInfo ||
      !configData.companyInfo.name
    ) {
      return res.status(400).json({ message: 'Dados da empresa incompletos.' });
    }

    // OTIMIZAÇÃO: Se já tem status definido, retorna sem gastar API do Google
    if (configData.googleBusiness) {
      if (configData.googleBusiness.status === 'verified') {
        return res.json({
          status: 'verified',
          data: configData.googleBusiness,
        });
      }
      if (configData.googleBusiness.status === 'not_found') {
        return res.json({
          status: 'not_found',
          data: null,
        });
      }
    }

    const { name, address } = configData.companyInfo;

    // Busca candidatos reais na API apenas se for 'unverified'
    const candidates = await searchGooglePlaces(name, address);

    res.json({
      status: 'unverified',
      candidates: candidates,
      searchedQuery: `${name} - ${address.neighborhood}, ${address.city}`,
    });
  } catch (error) {
    console.warn('⚠️ Growth Check Error:', error.message);
    res.status(500).json({ message: 'Erro ao buscar dados do Google.' });
  }
});

export default router;
