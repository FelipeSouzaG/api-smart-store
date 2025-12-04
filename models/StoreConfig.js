import mongoose from 'mongoose';
const { Schema } = mongoose;

const CompanyAddressSchema = new Schema(
  {
    cep: { type: String, default: '' },
    street: { type: String, default: '' },
    number: { type: String, default: '' },
    neighborhood: { type: String, default: '' },
    city: { type: String, default: '' },
    state: { type: String, default: '' },
    complement: String,
  },
  { _id: false }
);

const CompanyInfoSchema = new Schema(
  {
    name: { type: String, default: '' },
    cnpjCpf: { type: String, default: '' },
    phone: { type: String, default: '' },
    email: { type: String, default: '' },
    address: { type: CompanyAddressSchema, default: () => ({}) },
  },
  { _id: false }
);

const StockThresholdsSchema = new Schema(
  {
    riskMin: { type: Number, default: 1 },
    riskMax: { type: Number, default: 15 },
    safetyMax: { type: Number, default: 45 },
  },
  { _id: false }
);

const StoreConfigSchema = new Schema(
  {
    tenantId: { type: String, required: true, index: true, unique: true }, // One config per tenant

    // Flag indicating if the owner has completed the initial setup wizard
    isSetupComplete: { type: Boolean, default: false },

    // Basic Goals
    predictedAvgMargin: { type: Number, default: 40 },
    netProfit: { type: Number, default: 5000 },
    inventoryTurnoverGoal: { type: Number, default: 1.5 },

    // Taxation
    effectiveTaxRate: { type: Number, default: 4.0 },

    // Fees
    feePix: { type: Number, default: 0 },
    feeDebit: { type: Number, default: 1.5 },
    feeCreditSight: { type: Number, default: 3.0 },
    feeCreditInstallment: { type: Number, default: 12.0 },

    // Policies
    minContributionMargin: { type: Number, default: 20.0 },
    fixedCostAllocation: { type: Number, default: 15.0 },
    autoApplyDiscount: { type: Boolean, default: true }, // Default to true for backward compatibility

    // Inventory Rules
    turnoverPeriod: { type: String, default: 'Mensal (30 dias)' },
    stockThresholds: { type: StockThresholdsSchema, default: () => ({}) },

    // Incentives
    discountSafety: { type: Number, default: 0 },
    discountRisk: { type: Number, default: 5 },
    discountExcess: { type: Number, default: 15 },

    // Company Info
    companyInfo: { type: CompanyInfoSchema, default: () => ({}) },
  },
  { timestamps: true }
);

StoreConfigSchema.set('toJSON', {
  virtuals: true,
  transform: (doc, ret) => {
    ret.id = ret._id;
    delete ret._id;
    delete ret.__v;
    delete ret.tenantId;
  },
});

export default mongoose.model('StoreConfig', StoreConfigSchema);
