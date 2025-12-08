
import CreditCardTransaction from '../models/CreditCardTransaction.js';
import CashTransaction from '../models/CashTransaction.js';
import FinancialAccount from '../models/FinancialAccount.js';
import { TransactionType, TransactionCategory, TransactionStatus } from '../types.js';

// Re-calculates the total Invoice amount for a specific Card and Due Date
// and updates (or creates/deletes) the single record in CashTransaction.
export const syncInvoiceRecord = async (tenantId, financialAccountId, paymentMethodId, dueDate) => {
    try {
        // 1. Calculate Total from CreditCardTransactions
        // We define the range for the "Due Date" day (ignoring time)
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

        // 2. Find existing Invoice Record in CashTransaction
        const invoiceQuery = {
            tenantId,
            financialAccountId,
            paymentMethodId,
            isInvoice: true,
            dueDate: { $gte: startOfDay, $lte: endOfDay }
        };

        if (totalAmount > 0) {
            // Get card name for description
            const account = await FinancialAccount.findOne({ _id: financialAccountId, tenantId });
            const method = account?.paymentMethods.find(m => m.id === paymentMethodId || (m._id && m._id.toString() === paymentMethodId));
            const cardName = method ? method.name : 'Cartão de Crédito';

            // Upsert Invoice Record
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
                    category: TransactionCategory.OTHER, // Or a specific 'INVOICE' category
                    dueDate: startOfDay, // Normalize date
                    timestamp: startOfDay, // Invoice competence is its due date usually
                    // Preserve status if it was already PAID, otherwise PENDING
                    $setOnInsert: { status: TransactionStatus.PENDING } 
                },
                { upsert: true, new: true }
            );
        } else {
            // If total is 0, remove the invoice record (it's empty)
            // But ONLY if it's pending. If paid, maybe keep it? Usually remove if empty.
            await CashTransaction.findOneAndDelete({
                ...invoiceQuery,
                status: TransactionStatus.PENDING // Only auto-delete if not paid
            });
        }

    } catch (error) {
        console.error("Error syncing invoice:", error);
        throw error;
    }
};
