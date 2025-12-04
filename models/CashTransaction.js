import mongoose from 'mongoose';
const { Schema } = mongoose;

const CashTransactionSchema = new Schema({
  tenantId: { type: String, required: true, index: true },
  description: { type: String, required: true },
  amount: { type: Number, required: true },
  type: { type: String, required: true },
  category: { type: String, required: true },
  status: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
  dueDate: Date,
  serviceOrderId: String,
  purchaseId: String,
  saleId: String,
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
