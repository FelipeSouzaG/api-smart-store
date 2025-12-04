
import mongoose from 'mongoose';
const { Schema } = mongoose;

const SaleItemSchema = new Schema({
    item: { type: Object, required: true },
    quantity: { type: Number, required: true },
    unitPrice: { type: Number, required: true },
    unitCost: { type: Number, default: 0 },
    type: { type: String, required: true, enum: ['product', 'service'] },
    uniqueIdentifier: { type: String, required: false },
}, { _id: false });

const TicketSaleSchema = new Schema({
    tenantId: { type: String, required: true, index: true }, // Isolation
    _id: { type: String, alias: 'id' },
    items: [SaleItemSchema],
    total: { type: Number, required: true },
    totalCost: { type: Number, default: 0 },
    discount: { type: Number, default: 0 },
    paymentMethod: { type: String },
    timestamp: { type: Date, default: Date.now },
    customerName: String,
    customerWhatsapp: String,
    customerId: { type: String, ref: 'Customer' },
    saleHour: { type: Number, required: true },
    userId: { type: String, required: true },
    userName: { type: String, required: true },
});

TicketSaleSchema.set('toJSON', {
    virtuals: true,
    transform: (doc, ret) => {
        ret.id = ret._id;
        delete ret._id;
        delete ret.__v;
        delete ret.tenantId;
    }
});

export default mongoose.model('TicketSale', TicketSaleSchema);
