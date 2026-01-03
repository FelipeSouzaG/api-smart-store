import mongoose from 'mongoose';
const { Schema } = mongoose;

const SupplierSchema = new Schema({
  tenantId: { type: String, required: true, index: true }, // Isolation
  cnpjCpf: { type: String, required: true }, // Document is now a field, not _id
  name: { type: String, required: true },
  contactPerson: String,
  phone: { type: String, required: true },
});

// Ensure CNPJ/CPF is unique ONLY within the same tenant
SupplierSchema.index({ tenantId: 1, cnpjCpf: 1 }, { unique: true });

SupplierSchema.set('toJSON', {
  virtuals: true,
  transform: (doc, ret) => {
    ret.id = ret._id;
    delete ret._id;
    delete ret.__v;
    delete ret.tenantId;
  },
});

export default mongoose.model('Supplier', SupplierSchema);
