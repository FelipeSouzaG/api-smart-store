
import mongoose from 'mongoose';
const { Schema } = mongoose;

const ServiceSchema = new Schema({
    tenantId: { type: String, required: true, index: true }, // Isolation
    name: { type: String, required: true },
    brand: { type: String, required: true },
    model: { type: String, required: true },
    price: { type: Number, required: true },
    partCost: { type: Number, required: true },
    serviceCost: { type: Number, required: true },
    shippingCost: { type: Number, required: true },
});

ServiceSchema.set('toJSON', {
    virtuals: true,
    transform: (doc, ret) => {
        ret.id = ret._id;
        delete ret._id;
        delete ret.__v;
        delete ret.tenantId;
    }
});

export default mongoose.model('Service', ServiceSchema);
