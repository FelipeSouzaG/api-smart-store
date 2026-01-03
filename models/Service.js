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

const ServiceSchema = new Schema({
  tenantId: { type: String, required: true, index: true }, // Isolation
  name: { type: String, required: true }, // Tipo (ex: Troca de Tela)
  brand: { type: String, required: true },
  model: { type: String, required: true },
  price: { type: Number, required: true }, // Preço Balcão
  partCost: { type: Number, required: true },
  serviceCost: { type: Number, required: true },
  shippingCost: { type: Number, required: true },
  // E-commerce Fields
  publishToWeb: { type: Boolean, default: false },
  image: { type: String }, // Base64
  ecommerceDetails: { type: EcommerceDetailsSchema },
});

ServiceSchema.set('toJSON', {
  virtuals: true,
  transform: (doc, ret) => {
    ret.id = ret._id;
    delete ret._id;
    delete ret.__v;
    delete ret.tenantId;
  },
});

export default mongoose.model('Service', ServiceSchema);
