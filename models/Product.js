import mongoose from 'mongoose';
const { Schema } = mongoose;

const EcommerceDetailsSchema = new Schema(
  {
    priceSold: { type: Number, required: true }, // Preço Parcelado
    priceCash: { type: Number, required: true }, // Preço a Vista
    installmentCount: { type: Number, default: 12 }, // Max Parcelas
  },
  { _id: false }
);

const ProductSchema = new Schema({
  tenantId: { type: String, required: true, index: true }, // Tenant Isolation
  _id: { type: String, alias: 'id' },
  barcode: { type: String, required: true }, // Removed global unique constraint, unique per tenant handled in logic
  name: { type: String, required: true },
  price: { type: Number, required: true },
  cost: { type: Number, required: true, default: 0 },
  stock: { type: Number, required: true, default: 0 },
  lastSold: { type: Date, default: null },
  location: String,
  category: { type: String, required: true },
  brand: { type: String, required: true },
  model: { type: String, required: true },
  requiresUniqueIdentifier: { type: Boolean, default: false },
  publishToWeb: { type: Boolean, default: false }, // Default FALSE para controle manual
  image: { type: String }, // Base64 Compressed Image string
  ecommerceDetails: { type: EcommerceDetailsSchema }, // NEW
});

// Composite index to ensure barcode is unique PER TENANT
ProductSchema.index({ tenantId: 1, barcode: 1 }, { unique: true });

ProductSchema.set('toJSON', {
  virtuals: true,
  transform: (doc, ret) => {
    ret.id = ret._id;
    delete ret._id;
    delete ret.__v;
    delete ret.tenantId; // Security: Don't expose tenantId to frontend
  },
});

export default mongoose.model('Product', ProductSchema);
