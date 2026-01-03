import mongoose from 'mongoose';
const { Schema } = mongoose;

const CustomerSchema = new Schema({
  tenantId: { type: String, required: true, index: true }, // Isolation
  name: { type: String, required: true },
  phone: { type: String, required: true }, // Phone is now a specific field, not the _id
  cnpjCpf: { type: String },
});

// Ensure Phone is unique ONLY within the same tenant
CustomerSchema.index({ tenantId: 1, phone: 1 }, { unique: true });

CustomerSchema.set('toJSON', {
  virtuals: true,
  transform: (doc, ret) => {
    ret.id = ret._id;
    delete ret._id;
    delete ret.__v;
    delete ret.tenantId;
  },
});

export default mongoose.model('Customer', CustomerSchema);
