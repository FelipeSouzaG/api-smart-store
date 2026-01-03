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

const FinancialSettingsSchema = new Schema(
  {
    useBank: { type: Boolean, default: false },
    useCredit: { type: Boolean, default: false },
    cardClosingDay: { type: Number, default: 1 },
    cardDueDay: { type: Number, default: 10 },
  },
  { _id: false }
);

const GoogleBusinessSchema = new Schema(
  {
    status: {
      type: String,
      enum: ['unverified', 'verified', 'not_found'],
      default: 'unverified',
    },
    placeId: { type: String },
    name: { type: String },
    address: { type: String },
    rating: { type: Number },
    mapsUri: { type: String },
    websiteUri: { type: String },
    verifiedAt: { type: Date },
    dismissedPrompt: { type: Boolean, default: false }, // Flag para não mostrar o modal automático se o usuário recusar
    successShown: { type: Boolean, default: false }, // NOVA FLAG: Indica se o modal de "Sucesso/Vitória" já foi visto
    hasExternalEcommerce: { type: Boolean, default: false }, // NOVA FLAG: Indica se o site informado já é um e-commerce
  },
  { _id: false }
);

// Schema de Auditoria Jurídica (Empreendedor x FluxoClean)
const LegalAgreementSchema = new Schema(
  {
    accepted: { type: Boolean, default: false },
    acceptedAt: { type: Date },
    version: { type: String }, // Ex: "v1.0-2025"
    ipAddress: { type: String },
    userAgent: { type: String },
  },
  { _id: false }
);

// NOVOS CAMPOS: Políticas do E-commerce (Empreendedor x Cliente Final)
const EcommercePoliciesSchema = new Schema(
  {
    refundPolicy: { type: String, default: '' }, // Trocas e Devoluções
    privacyPolicy: { type: String, default: '' }, // Privacidade e Dados
    shippingPolicy: { type: String, default: '' }, // Frete e Entrega
    legalTerms: { type: String, default: '' }, // Termos de Uso
    configured: { type: Boolean, default: false }, // Se o lojista já configurou
    updatedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const StoreConfigSchema = new Schema(
  {
    tenantId: { type: String, required: true, index: true, unique: true }, // One config per tenant
    tenantName: { type: String, default: '' }, // Slug
    customDomain: { type: String, unique: true, sparse: true }, // Domain override for Single Tenant

    // Flag indicating if the owner has completed the initial setup wizard
    isSetupComplete: { type: Boolean, default: false },

    // --- STATUS MIRRORING (SaaS -> Store) ---
    // Controls access to the storefront based on payment status
    subscriptionStatus: {
      type: String,
      enum: ['active', 'trial', 'blocked', 'expired', 'pending_verification'],
      default: 'active',
    },
    validUntil: { type: Date }, // Fail-safe date check
    // ----------------------------------------

    // Basic Goals
    predictedAvgMargin: { type: Number, default: 40 },
    netProfit: { type: Number, default: 5000 },
    inventoryTurnoverGoal: { type: Number, default: 1.5 },

    // Taxation
    effectiveTaxRate: { type: Number, default: 4.0 },

    // Fees
    feePix: { type: Number, default: 0 },
    feeDebit: { type: Number, default: 1.0 },
    feeCreditSight: { type: Number, default: 2.0 },
    feeCreditInstallment: { type: Number, default: 10.0 },

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

    // Financial Settings (Payment Configs)
    financialSettings: { type: FinancialSettingsSchema, default: () => ({}) },

    // Google Business & Growth Data
    googleBusiness: { type: GoogleBusinessSchema, default: () => ({}) },

    // Legal Audit Trail
    legalAgreement: { type: LegalAgreementSchema, default: () => ({}) },

    // Ecommerce Legal Configs (B2C)
    ecommercePolicies: { type: EcommercePoliciesSchema, default: () => ({}) },
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
