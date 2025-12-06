
import mongoose from 'mongoose';
const { Schema } = mongoose;

const CreditCardTransactionSchema = new Schema({
  tenantId: { type: String, required: true, index: true },
  description: { type: String, required: true },
  amount: { type: Number, required: true }, // Valor da parcela
  category: { type: String, required: true },
  timestamp: { type: Date, default: Date.now }, // Data da compra
  dueDate: { type: Date, required: true }, // Data de vencimento da fatura onde cai esta parcela
  
  // Linkages
  financialAccountId: { type: String, required: true }, // Conta (Banco)
  paymentMethodId: { type: String, required: true }, // Cartão específico
  
  // Installment Info
  installmentNumber: { type: Number, default: 1 },
  totalInstallments: { type: Number, default: 1 },
  
  // Origin
  source: { type: String, enum: ['manual', 'purchase', 'service_order'], default: 'manual' },
  referenceId: { type: String } // ID da Compra ou OS
}, { timestamps: true });

CreditCardTransactionSchema.index({ tenantId: 1, financialAccountId: 1, paymentMethodId: 1, dueDate: 1 });

CreditCardTransactionSchema.set('toJSON', {
  virtuals: true,
  transform: (doc, ret) => {
    ret.id = ret._id;
    delete ret._id;
    delete ret.__v;
    delete ret.tenantId;
  },
});

export default mongoose.model('CreditCardTransaction', CreditCardTransactionSchema);
