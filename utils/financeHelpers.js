import mongoose from 'mongoose';
import CreditCardTransaction from '../models/CreditCardTransaction.js';
import CashTransaction from '../models/CashTransaction.js';
import StoreConfig from '../models/StoreConfig.js';
import {
  TransactionType,
  TransactionCategory,
  TransactionStatus,
} from '../types.js';

// Re-calculates the total Invoice amount for a specific Card and Due Date
export const syncInvoiceRecord = async (
  tenantId,
  financialAccountId,
  paymentMethodId,
  dueDate
) => {
  try {
    if (financialAccountId !== 'credit-main') return;

    const startOfDay = new Date(dueDate);
    startOfDay.setUTCHours(0, 0, 0, 0);
    const endOfDay = new Date(dueDate);
    endOfDay.setUTCHours(23, 59, 59, 999);

    const result = await CreditCardTransaction.aggregate([
      {
        $match: {
          tenantId,
          financialAccountId,
          dueDate: { $gte: startOfDay, $lte: endOfDay },
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: '$amount' },
          categories: { $addToSet: '$category' },
        },
      },
    ]);

    const totalAmount = result.length > 0 ? result[0].total : 0;
    const distinctCategories = result.length > 0 ? result[0].categories : [];

    let finalCategory = TransactionCategory.OTHER;
    if (distinctCategories.length === 1) {
      finalCategory = distinctCategories[0];
    } else if (distinctCategories.length > 1) {
      finalCategory = TransactionCategory.OTHER;
    }

    const invoiceQuery = {
      tenantId,
      financialAccountId: 'credit-main',
      isInvoice: true,
      dueDate: { $gte: startOfDay, $lte: endOfDay },
    };

    let invoiceStatus = 'Open';
    const config = await StoreConfig.findOne({ tenantId });
    const closingDay = config?.financialSettings?.cardClosingDay || 1;
    const dueDay = config?.financialSettings?.cardDueDay || 10;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const invoiceDueDate = new Date(dueDate);
    let targetClosingDate = new Date(invoiceDueDate);
    targetClosingDate.setDate(closingDay);

    if (dueDay < closingDay) {
      targetClosingDate.setMonth(targetClosingDate.getMonth() - 1);
    }

    if (today >= targetClosingDate) {
      invoiceStatus = 'Closed';
    }

    if (totalAmount > 0) {
      await CashTransaction.findOneAndUpdate(
        invoiceQuery,
        {
          $set: {
            description: `Fatura Cartão - Venc: ${startOfDay.toLocaleDateString(
              'pt-BR',
              { timeZone: 'UTC' }
            )}`,
            amount: totalAmount,
            type: TransactionType.EXPENSE,
            category: finalCategory,
            invoiceStatus: invoiceStatus,
            paymentMethodId: 'credit-card-default',
          },
          $setOnInsert: {
            status: TransactionStatus.PENDING,
            timestamp: startOfDay,
            dueDate: startOfDay,
            paymentDate: null,
          },
        },
        { upsert: true, new: true }
      );
    } else {
      await CashTransaction.findOneAndDelete(invoiceQuery);
    }
  } catch (error) {
    console.error('Error syncing invoice:', error);
    throw error;
  }
};

export const processInvoiceStatus = async (tenantId) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const pendingInvoices = await CashTransaction.find({
      tenantId,
      isInvoice: true,
      status: TransactionStatus.PENDING,
      invoiceStatus: 'Open',
    });

    if (pendingInvoices.length === 0) return;

    const config = await StoreConfig.findOne({ tenantId });
    const closingDay = config?.financialSettings?.cardClosingDay || 1;
    const dueDay = config?.financialSettings?.cardDueDay || 10;

    for (const inv of pendingInvoices) {
      const dueDate = new Date(inv.dueDate);
      let targetClosingDate = new Date(dueDate);
      targetClosingDate.setDate(closingDay);

      if (dueDay < closingDay) {
        targetClosingDate.setMonth(targetClosingDate.getMonth() - 1);
      }

      if (today >= targetClosingDate) {
        inv.invoiceStatus = 'Closed';
        await inv.save();
      }
    }
  } catch (error) {
    console.error('Error processing invoice status:', error);
  }
};

// --- SOURCE OF TRUTH SYNCHRONIZER (Cash -> Purchase/OS) ---
export const updateOriginStatus = async (tenantId, originType, originId) => {
  try {
    const query = { tenantId };
    if (originType === 'purchase') query.purchaseId = originId;
    if (originType === 'service_order') query.serviceOrderId = originId;

    const cashTransactions = await CashTransaction.find(query);
    const ccTransactions = await CreditCardTransaction.find({
      tenantId,
      referenceId: originId,
      source: originType,
    });

    let allPaid = true;
    let hasTransactions =
      cashTransactions.length > 0 || ccTransactions.length > 0;

    if (!hasTransactions) return;

    // Check Cash Transactions
    for (const tx of cashTransactions) {
      if (tx.installments && tx.installments.length > 0) {
        if (
          tx.installments.some((inst) => inst.status !== TransactionStatus.PAID)
        ) {
          allPaid = false;
          break;
        }
      } else {
        if (tx.status !== TransactionStatus.PAID) {
          allPaid = false;
          break;
        }
      }
    }

    // Check CC Transactions ( installments generated by Purchases/OS )
    if (allPaid && ccTransactions.length > 0) {
      if (ccTransactions.some((t) => t.status !== TransactionStatus.PAID)) {
        allPaid = false;
      }
    }

    const newStatus = allPaid
      ? TransactionStatus.PAID
      : TransactionStatus.PENDING;

    if (originType === 'purchase') {
      await mongoose
        .model('PurchaseOrder')
        .findOneAndUpdate(
          { _id: originId, tenantId },
          { $set: { status: newStatus } }
        );
    } else if (originType === 'service_order') {
      // Logic for OS status could be different, but focusing on financial consistency:
      // OS usually transitions to 'Concluído' manually, but we can track if it's paid.
    }
  } catch (error) {
    console.error(`Error syncing origin ${originType}`, error);
  }
};
