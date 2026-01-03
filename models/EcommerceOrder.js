import mongoose from 'mongoose';
const { Schema } = mongoose;

const EcommerceItemSchema = new Schema(
  {
    productId: { type: String, required: true },
    productName: { type: String, required: true },
    quantity: { type: Number, required: true },
    unitPrice: { type: Number, required: true },
    image: String,
    type: { type: String, enum: ['product', 'service'], default: 'product' }, // Added type
  },
  { _id: false }
);

const AddressSchema = new Schema(
  {
    cep: { type: String, required: true },
    street: { type: String, required: true },
    number: { type: String, required: true },
    complement: String,
    neighborhood: { type: String, required: true },
    city: { type: String, required: true },
    state: { type: String, required: true },
  },
  { _id: false }
);

const ShippingInfoSchema = new Schema(
  {
    method: String, // Correios, Motoboy, Retirada
    trackingCode: String,
    cost: { type: Number, default: 0 },
    shippedAt: Date,
    deliveredAt: Date,
    notes: String,
  },
  { _id: false }
);

const EcommerceOrderSchema = new Schema({
  tenantId: { type: String, required: true, index: true },
  _id: { type: String, alias: 'id' }, // Custom ID: SC-2025120001
  customer: {
    name: { type: String, required: true },
    phone: { type: String, required: true },
    address: { type: AddressSchema, required: true },
  },
  items: [EcommerceItemSchema],
  total: { type: Number, required: true },
  status: {
    type: String,
    required: true,
    enum: ['PENDING', 'SENT', 'DELIVERED', 'CANCELLED'],
    default: 'PENDING',
  },
  shippingInfo: { type: ShippingInfoSchema, default: () => ({}) },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },

  // Links to core system when finalized
  relatedTicketId: { type: String, ref: 'TicketSale' }, // For Products
  relatedServiceOrderId: { type: String, ref: 'ServiceOrder' }, // For Services (Added)
  relatedCustomerId: { type: String, ref: 'Customer' },
});

EcommerceOrderSchema.index({ tenantId: 1, createdAt: -1 });

EcommerceOrderSchema.set('toJSON', {
  virtuals: true,
  transform: (doc, ret) => {
    ret.id = ret._id;
    delete ret._id;
    delete ret.__v;
    delete ret.tenantId;
  },
});

export default mongoose.model('EcommerceOrder', EcommerceOrderSchema);
