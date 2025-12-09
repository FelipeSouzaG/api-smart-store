
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
        
        // Se não houver transações (ex: tudo deletado ou pago via cartão que não gera cash individual imediato), 
        // talvez não devamos alterar, mas se for boleto, verificamos.
        if (transactions.length === 0) return;

        // 2. Verificar Status Geral
        const allPaid = transactions.every(t => t.status === TransactionStatus.PAID);
        const newStatus = allPaid ? TransactionStatus.PAID : TransactionStatus.PENDING;

        // 3. Atualizar a Origem
        if (originType === 'purchase') {
            const purchase = await PurchaseOrder.findOne({ _id: originId, tenantId });
            if (purchase) {
                // Atualiza status do cabeçalho
                // Mapeia TransactionStatus para o status usado em Purchase (que usa os mesmos enums ou string)
                // Se a compra foi via Cartão, ela já nasce Paga na origem geralmente, 
                // mas se foi Boleto, essa sincronia é vital.
                
                // Só atualizamos se houver mudança para evitar loops ou overwrites desnecessários
                // E preservamos dados de cartão se existirem
                if (purchase.paymentDetails.method !== 'Cartão de Crédito' && 
                    purchase.paymentDetails.method !== 'Crédito Parcelado' && 
                    purchase.paymentDetails.method !== 'Crédito à Vista') {
                        
                    // Atualiza status dentro de paymentDetails (campo virtual ou paymentDate se pago)
                    if (allPaid && !purchase.paymentDetails.paymentDate) {
                        purchase.paymentDetails.paymentDate = new Date(); // Marca data de hoje como quitação
                        // Em algumas implementações o status fica solto no objeto, vamos garantir consistência se houver campo status
                    } else if (!allPaid) {
                        purchase.paymentDetails.paymentDate = null;
                    }
                    
                    // Se você tiver um campo de status explícito na raiz do PurchaseOrder, atualize-o aqui
                    // Exemplo hipotético se existisse purchase.status = newStatus;
                    await purchase.save();
                }
            }
        } else if (originType === 'service_order') {
            // OS tem lógica mais complexa (Completed vs Pending), mas o financeiro refere-se ao CUSTO da OS ou RECEITA?
            // CashTransaction com serviceOrderId pode ser RECEITA (pagamento do cliente) ou DESPESA (peça).
            // A função updateOriginStatus deve saber o que está atualizando.
            // Geralmente, alterar o status de pagamento da Receita da OS não reabre a OS (status operacional), 
            // mas define se ela está "Quitada".
            // Para este sistema, focamos na consistência financeira.
        }

    } catch (error) {
        console.error(`Erro ao sincronizar origem (${originType} #${originId}):`, error);
    }
};
