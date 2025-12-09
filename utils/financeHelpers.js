
import CreditCardTransaction from '../models/CreditCardTransaction.js';
import CashTransaction from '../models/CashTransaction.js';
import PurchaseOrder from '../models/PurchaseOrder.js';
import ServiceOrder from '../models/ServiceOrder.js';
import FinancialAccount from '../models/FinancialAccount.js';
import { TransactionType, TransactionCategory, TransactionStatus, ServiceOrderStatus } from '../types.js';

// Re-calculates the total Invoice amount for a specific Card and Due Date
// and updates (or creates/deletes) the single record in CashTransaction.
export const syncInvoiceRecord = async (tenantId, financialAccountId, paymentMethodId, dueDate) => {
    try {
        const startOfDay = new Date(dueDate);
        startOfDay.setUTCHours(0, 0, 0, 0);
        const endOfDay = new Date(dueDate);
        endOfDay.setUTCHours(23, 59, 59, 999);

        const result = await CreditCardTransaction.aggregate([
            {
                $match: {
                    tenantId,
                    financialAccountId,
                    paymentMethodId,
                    dueDate: { $gte: startOfDay, $lte: endOfDay }
                }
            },
            {
                $group: {
                    _id: null,
                    total: { $sum: "$amount" }
                }
            }
        ]);

        const totalAmount = result.length > 0 ? result[0].total : 0;

        const invoiceQuery = {
            tenantId,
            financialAccountId,
            paymentMethodId,
            isInvoice: true,
            dueDate: { $gte: startOfDay, $lte: endOfDay }
        };

        if (totalAmount > 0) {
            const account = await FinancialAccount.findOne({ _id: financialAccountId, tenantId });
            const method = account?.paymentMethods.find(m => m.id === paymentMethodId || (m._id && m._id.toString() === paymentMethodId));
            const cardName = method ? method.name : 'Cartão de Crédito';

            await CashTransaction.findOneAndUpdate(
                invoiceQuery,
                {
                    tenantId,
                    financialAccountId,
                    paymentMethodId,
                    isInvoice: true,
                    description: `Fatura ${cardName}`,
                    amount: totalAmount,
                    type: TransactionType.EXPENSE,
                    category: TransactionCategory.OTHER,
                    dueDate: startOfDay,
                    timestamp: startOfDay,
                    $setOnInsert: { status: TransactionStatus.PENDING } 
                },
                { upsert: true, new: true }
            );
        } else {
            await CashTransaction.findOneAndDelete({
                ...invoiceQuery,
                status: TransactionStatus.PENDING 
            });
        }

    } catch (error) {
        console.error("Error syncing invoice:", error);
        throw error;
    }
};

// --- SYNC REVERSO (Caixa -> Compra/OS) ---

export const updateOriginStatus = async (tenantId, originType, originId) => {
    try {
        // 1. Buscar todas as transações financeiras vinculadas a esta origem
        const query = { tenantId };
        if (originType === 'purchase') query.purchaseId = originId;
        if (originType === 'service_order') query.serviceOrderId = originId;

        const transactions = await CashTransaction.find(query);
        
        // Se não houver transações (ex: tudo deletado), não fazemos nada ou poderíamos marcar como pendente/cancelado
        // Mas para compras, se não há transações no caixa, pode ser que seja Cartão de Crédito (tabela separada).
        if (transactions.length === 0) return;

        // 2. Verificar Status Geral
        // Se TODAS as transações vinculadas estiverem PAGAS, a origem é PAGA.
        // Se UMA estiver PENDENTE (Reaberta), a origem volta a ser PENDENTE.
        const allPaid = transactions.every(t => t.status === TransactionStatus.PAID);

        // 3. Atualizar a Origem
        if (originType === 'purchase') {
            const purchase = await PurchaseOrder.findOne({ _id: originId, tenantId });
            if (purchase) {
                // Ignorar compras via Cartão de Crédito (pois o status delas é gerido pela fatura/compra inicial)
                // Focamos em sincronizar Boleto, Caixa e Bancos (Débito/Pix/Transf)
                const isCredit = ['Cartão de Crédito', 'Crédito à Vista', 'Crédito Parcelado'].includes(purchase.paymentDetails.method);
                
                if (!isCredit) {
                    if (allPaid) {
                        // Se tudo pago, define data de pagamento (Status: Pago)
                        if (!purchase.paymentDetails.paymentDate) {
                            purchase.paymentDetails.paymentDate = new Date();
                        }
                    } else {
                        // Se algo pendente (ex: reabriu no caixa), limpa data (Status: Pendente)
                        purchase.paymentDetails.paymentDate = null;
                    }
                    
                    // Força atualização do subdocumento pois Mongoose as vezes não detecta mudanças profundas
                    purchase.markModified('paymentDetails');
                    await purchase.save();
                }
            }
        } else if (originType === 'service_order') {
            // Lógica para OS (se necessário no futuro)
            // Geralmente OS concluída não volta a pendente só por causa do financeiro, 
            // mas o financeiro reflete se o valor foi recebido ou não.
        }

    } catch (error) {
        console.error(`Erro ao sincronizar origem (${originType} #${originId}):`, error);
    }
};
