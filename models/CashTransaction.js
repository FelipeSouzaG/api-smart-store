
import mongoose from 'mongoose';
const { Schema } = mongoose;

const InstallmentSchema = new Schema({
  number: Number,
  amount: Number,
  dueDate: Date,
  paymentDate: Date,
  status: { type: String, default: 'Pendente' }
}, { _id: false });

const CashTransactionSchema = new Schema({
  tenantId: { type: String, required: true, index: true },
  description: { type: String, required: true },
  amount: { type: Number, required: true },
  type: { type: String, required: true },
  category: { type: String, required: true },
  status: { type: String, required: true },
  timestamp: { type: Date, default: Date.now }, // Data de Lançamento / Competência
  dueDate: Date, // Data de Vencimento (do registro pai ou única)
  paymentDate: Date, // Data da Baixa (do registro pai ou única)
  serviceOrderId: String,
  purchaseId: String,
  saleId: String,
  // Financial Links
  financialAccountId: String,
  paymentMethodId: String,
  // Flags & Complex Structures
  isInvoice: { type: Boolean, default: false }, // Indica consolidado de cartão
  installments: [InstallmentSchema] // Array de parcelas para custos parcelados (Boletos/Bancos)
});

CashTransactionSchema.set('toJSON', {
  virtuals: true,
  transform: (doc, ret) => {
    ret.id = ret._id;
    delete ret._id;
    delete ret.__v;
    delete ret.tenantId;
  },
});

export default mongoose.model('CashTransaction', CashTransactionSchema);
