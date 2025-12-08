
import CreditCardTransaction from '../models/CreditCardTransaction.js';
import CashTransaction from '../models/CashTransaction.js';
import FinancialAccount from '../models/FinancialAccount.js';
import { TransactionType, TransactionCategory, TransactionStatus } from '../types.js';

// Re-calculates the total Invoice amount for a specific Card and Due Date
// Now aggregates BOTH CreditCardTransaction (from Purchases/OS) AND CashTransaction (Manual Costs)
export const syncInvoiceRecord = async (tenantId, financialAccountId, paymentMethodId, dueDate) => {
    try {
        // We define the range for the "Due Date" day (ignoring time)
        const startOfDay = new Date(dueDate);
        startOfDay.setUTCHours(0, 0, 0, 0);
        const endOfDay = new Date(dueDate);
        endOfDay.setUTCHours(23, 59, 59, 999);

        // 1. Calculate Total from Legacy/Auto CreditCardTransactions (Purchases/OS)
        const ccResult = await CreditCardTransaction.aggregate([
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
        const ccTotal = ccResult.length > 0 ? ccResult[0].total : 0;

        // 2. Calculate Total from Unified CashTransactions (Manual Costs)
        // We need to unwind installments and match specific due date
        const cashResult = await CashTransaction.aggregate([
            {
                $match: {
                    tenantId,
                    financialAccountId,
                    paymentMethodId,
                    isInvoice: false, // Don't sum the invoices themselves!
                    // Optimization: Only look for docs that MIGHT have installments in this range
                    // But standard match is safer
                }
            },
            { $unwind: "$installments" },
            {
                $match: {
                    "installments.dueDate": { $gte: startOfDay, $lte: endOfDay }
                }
            },
            {
                $group: {
                    _id: null,
                    total: { $sum: "$installments.amount" }
                }
            }
        ]);
        const cashTotal = cashResult.length > 0 ? cashResult[0].total : 0;

        const totalAmount = ccTotal + cashTotal;

        // 3. Find existing Invoice Record in CashTransaction
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
                    category: TransactionCategory.OTHER, 
                    dueDate: startOfDay, 
                    timestamp: startOfDay, 
                    // Preserve status if it was already PAID, otherwise PENDING
                    $setOnInsert: { status: TransactionStatus.PENDING } 
                },
                { upsert: true, new: true }
            );
        } else {
            // If total is 0, remove the invoice record if it's pending
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
