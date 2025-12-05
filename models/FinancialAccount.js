import mongoose from 'mongoose';
const { Schema } = mongoose;

const ReceivingRuleSchema = new Schema(
  {
    type: { type: String, required: true }, // Pix, Debit, Credit
    installmentsMin: { type: Number, default: 1 },
    installmentsMax: { type: Number, default: 1 },
    taxRate: { type: Number, required: true, default: 0 }, // %
    daysToReceive: { type: Number, default: 0 }, // D+0, D+1, D+30
  },
  { _id: true }
);

const PaymentMethodSchema = new Schema(
  {
    name: { type: String, required: true }, // e.g., "Crédito Inter", "Pix Inter"
    type: {
      type: String,
      required: true,
      enum: ['Pix', 'Debit', 'Boleto', 'Credit'],
    },
    closingDay: { type: Number }, // Dia de fechamento da fatura (para Cartão de Crédito)
    dueDay: { type: Number }, // Dia de vencimento da fatura
  },
  { _id: true }
);

const FinancialAccountSchema = new Schema(
  {
    tenantId: { type: String, required: true, index: true },
    bankName: { type: String, required: true }, // e.g., Inter, Nubank, Itaú
    balance: { type: Number, default: 0 }, // Saldo atual (calculado)
    receivingRules: [ReceivingRuleSchema],
    paymentMethods: [PaymentMethodSchema],
    isDefault: { type: Boolean, default: false },
  },
  { timestamps: true }
);

FinancialAccountSchema.set('toJSON', {
  virtuals: true,
  transform: (doc, ret) => {
    ret.id = ret._id;
    delete ret._id;
    delete ret.__v;
    delete ret.tenantId;
  },
});

export default mongoose.model('FinancialAccount', FinancialAccountSchema);
