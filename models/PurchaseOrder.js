import mongoose from 'mongoose';
const { Schema } = mongoose;

const PurchaseItemSchema = new Schema(
  {
    productId: { type: String, ref: 'Product', required: true },
    productName: { type: String, required: true },
    quantity: { type: Number, required: true },
    unitCost: { type: Number, required: true },
  },
  { _id: false }
);

const InstallmentSchema = new Schema(
  {
    installmentNumber: Number,
    amount: Number,
    dueDate: Date,
    status: { type: String, default: 'Pendente' }, // Added to track individual status
    paymentDate: Date, // Added to track when it was paid
  },
  { _id: false }
);

const PaymentDetailsSchema = new Schema(
  {
    method: { type: String, required: true },
    paymentDate: Date,
    bank: String,
    installments: [InstallmentSchema], // Array for detailed installments (e.g. Bank Slip)
    installmentCount: { type: Number }, // Number of installments (e.g. Credit Card)
    // New Fields for Financial Account Linking
    financialAccountId: String,
    paymentMethodId: String,
  },
  { _id: false }
);

const SupplierInfoSchema = new Schema(
  {
    name: String,
    cnpjCpf: String,
    contactPerson: String,
    phone: String,
  },
  { _id: false }
);

const PurchaseOrderSchema = new Schema({
  tenantId: { type: String, required: true, index: true }, // Isolation
  _id: { type: String, alias: 'id' },
  items: [PurchaseItemSchema],
  freightCost: { type: Number, default: 0 },
  otherCost: { type: Number, default: 0 },
  totalCost: { type: Number, required: true },
  paymentDetails: PaymentDetailsSchema,
  createdAt: { type: Date, default: Date.now },
  supplierInfo: SupplierInfoSchema,
  reference: String,
  status: { type: String, default: 'Pendente' },
});

PurchaseOrderSchema.set('toJSON', {
  virtuals: true,
  transform: (doc, ret) => {
    ret.id = ret._id;
    delete ret._id;
    delete ret.__v;
    delete ret.tenantId;
  },
});

export default mongoose.model('PurchaseOrder', PurchaseOrderSchema);
