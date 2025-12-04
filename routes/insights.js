import express from 'express';
import { GoogleGenAI } from '@google/genai';
import { protect, authorize } from '../middleware/authMiddleware.js';
const router = express.Router();

const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;

const generateWithRetry = async (ai, model, prompt, retries = MAX_RETRIES) => {
  let attempt = 0;
  while (attempt < retries) {
    try {
      const response = await ai.models.generateContent({
        model: model,
        contents: prompt,
      });
      return response;
    } catch (error) {
      attempt++;
      if ((error.status === 503 || error.status === 429) && attempt < retries) {
        const backoffTime = INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, backoffTime));
      } else {
        throw error;
      }
    }
  }
  throw new Error('Max retries reached. Gemini API is still unavailable.');
};

router.post('/', protect, authorize('owner', 'manager'), async (req, res) => {
  const { kpis } = req.body;

  if (!kpis) {
    return res.status(400).json({ message: 'KPI data is required.' });
  }

  if (!process.env.API_KEY) {
    return res
      .status(500)
      .json({ message: 'A chave de API do Gemini não está configurada.' });
  }

  try {
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

    const prompt = `
        Você é um analista de dados e consultor de negócios sênior para uma loja de varejo. Sua tarefa é analisar os KPIs do mês e gerar um relatório conciso e acionável em português.

        **Instruções de Formato e Tom:**
        - Seja direto, objetivo e use um tom profissional.
        - Use markdown para formatação.
        - Organize a resposta em 3 seções claras: "🚨 Alertas e Anomalias", "📈 Recomendações de Ações", e "💰 Impacto no Resultado".
        - Use bullet points (com emojis) para as recomendações.

        **Análise Requerida:**

        1.  **Alertas e Anomalias:**
            - Identifique os riscos mais urgentes.
            - Analise o 'Nível de Estoque': Avise sobre a quantidade de produtos em 'Ruptura' e 'Risco de Ruptura'.
            - Analise os 'Produtos com Menor Giro': Destaque se há muitos produtos parados, representando capital imobilizado.
            - Analise a 'Margem de Contribuição': Compare a margem atual com a meta. Se estiver abaixo, isso é um alerta.
            - Verifique se a 'Projeção de Faturamento' está abaixo da meta.

        2.  **Recomendações de Ações:**
            - Com base nos alertas, forneça sugestões claras.
            - **Sugestão de Compras:** Se houver produtos em 'Risco de Ruptura' que também estão no 'Top 10 Mais Vendidos', recomende a compra imediata.
            - **Recomendação de Promoções:** Para os 'Produtos com Menor Giro', sugira ações específicas (ex: "Crie um combo...", "Ofereça um desconto de X%...").
            - **Ações para Atingir a Meta:** Se a projeção de faturamento estiver abaixo da meta, calcule a diferença e sugira como os 'Picos de Venda' podem ser replicados ou como o ticket médio pode ser aumentado.

        3.  **Impacto no Resultado:**
            - Conclua com uma análise do cenário geral.
            - Compare a 'Projeção de Faturamento' com o 'Ponto de Equilíbrio' e a 'Meta de Faturamento'.
            - Projete o 'Lucro Líquido' com base na previsão atual e compare com o objetivo. Deixe claro se o resultado está no caminho certo para atingir a meta de lucro.

        **DADOS PARA ANÁLISE:**

        **Financeiro:**
        - Meta de Faturamento: R$ ${kpis.totalRevenueGoal.toFixed(2)}
        - Projeção de Faturamento: R$ ${kpis.monthlyForecast.toFixed(2)}
        - Ponto de Equilíbrio: R$ ${kpis.breakEvenPoint.toFixed(2)}
        - Objetivo de Lucro Líquido: R$ ${kpis.goals.netProfit.toFixed(2)}
        - Margem de Contribuição Atual: ${kpis.currentAvgContributionMargin.toFixed(
          2
        )}% (Meta: ${kpis.goals.predictedAvgMargin}%)

        **Estoque:**
        - Meta de Giro de Estoque: ${kpis.goals.inventoryTurnoverGoal.toFixed(
          2
        )}
        - Giro de Estoque Projetado: ${kpis.projectedInventoryTurnover.toFixed(
          2
        )}
        - Nível de Estoque (Contagem de produtos):
          - Ruptura: ${kpis.stockLevelSummary.ruptura}
          - Risco de Ruptura (1-7 dias): ${kpis.stockLevelSummary.risco}
          - Segurança (8-30 dias): ${kpis.stockLevelSummary.seguranca}
          - Excesso (>30 dias): ${kpis.stockLevelSummary.excesso}
        
        **Desempenho de Produtos e Vendas:**
        - Top 10 Produtos Mais Vendidos: ${JSON.stringify(
          kpis.top10SoldProducts.map((p) => p.name)
        )}
        - Top 10 Produtos com Menor Giro: ${JSON.stringify(
          kpis.lowestTurnoverProducts.map((p) => ({
            name: p.name,
            stock: p.currentStock,
          }))
        )}
        - Top 5 Picos de Venda (Data e Valor): ${JSON.stringify(
          kpis.topSalesDays
        )}
        `;

    let response;
    try {
      response = await generateWithRetry(ai, 'gemini-2.5-flash', prompt);
    } catch (primaryError) {
      try {
        response = await generateWithRetry(
          ai,
          'gemini-flash-lite-latest',
          prompt
        );
      } catch (fallbackError) {
        throw primaryError;
      }
    }

    res.json({ insights: response.text });
  } catch (error) {
    console.error('Error fetching insights:', error.message);

    let userMessage = 'Não foi possível gerar os insights de IA no momento.';

    if (error.status === 503) {
      userMessage =
        'O serviço de IA está temporariamente indisponível. Tente novamente em alguns instantes.';
    } else if (error.status === 429) {
      userMessage =
        'O limite de uso da Inteligência Artificial foi atingido temporariamente.';
    }

    res.status(error.status || 500).json({ message: userMessage });
  }
});

export default router;
