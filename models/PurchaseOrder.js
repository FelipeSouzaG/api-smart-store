
import mongoose from 'mongoose';
const { Schema } = mongoose;

const PurchaseItemSchema = new Schema({
    productId: { type: String, ref: 'Product', required: true },
    productName: { type: String, required: true },
    quantity: { type: Number, required: true },
    unitCost: { type: Number, required: true },
}, { _id: false });

const InstallmentSchema = new Schema({
    installmentNumber: Number,
    amount: Number,
    dueDate: Date,
}, { _id: false });

const PaymentDetailsSchema = new Schema({
    method: { type: String, required: true },
    paymentDate: Date,
    bank: String,
    installments: [InstallmentSchema],
}, { _id: false });

const SupplierInfoSchema = new Schema({
    name: String,
    cnpjCpf: String,
    contactPerson: String,
    phone: String,
}, { _id: false });

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
});

PurchaseOrderSchema.set('toJSON', {
    virtuals: true,
    transform: (doc, ret) => {
        ret.id = ret._id;
        delete ret._id;
        delete ret.__v;
        delete ret.tenantId;
    }
});

export default mongoose.model('PurchaseOrder', PurchaseOrderSchema);
