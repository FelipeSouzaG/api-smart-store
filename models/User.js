
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const UserSchema = new mongoose.Schema({
    tenantId: { type: String, required: true, index: true }, // Tenant Isolation
    name: { type: String, required: true },
    email: { type: String, required: true, lowercase: true }, // Unique per tenant handled by index
    password: { type: String, required: true },
    role: { type: String, required: true, enum: ['owner', 'manager', 'technician'] },
});

// Ensure email is unique PER TENANT (or globally if you prefer, but per tenant allows same email in diff companies)
UserSchema.index({ tenantId: 1, email: 1 }, { unique: true });

// Hash password before saving
UserSchema.pre('save', async function(next) {
    if (!this.isModified('password')) {
        return next();
    }
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
});

UserSchema.methods.comparePassword = async function(candidatePassword) {
    return await bcrypt.compare(candidatePassword, this.password);
};

UserSchema.set('toJSON', {
    virtuals: true,
    transform: (doc, ret) => {
        ret.id = ret._id;
        delete ret._id;
        delete ret.password;
        delete ret.__v;
        delete ret.tenantId;
    }
});

export default mongoose.model('User', UserSchema);
