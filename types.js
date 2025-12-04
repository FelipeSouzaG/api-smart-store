// This file provides JavaScript-compatible enums for the backend.

export const UserRole = {
  OWNER: 'owner',
  MANAGER: 'manager',
  TECHNICIAN: 'technician',
};

export const ProductCategory = {
  CELLPHONE: 'Celular',
  ACCESSORY: 'Acessório de Celular',
  ELECTRONIC: 'Eletrônico',
  OTHER: 'Outro',
};

export const ServiceBrand = {
  APPLE: 'Apple',
  SAMSUNG: 'Samsung',
  MOTOROLA: 'Motorola',
  XIAOMI: 'Xiaomi',
  OTHER: 'Outra',
};

export const TransactionStatus = {
  PENDING: 'Pendente',
  PAID: 'Pago',
};

export const TransactionType = {
  INCOME: 'income',
  EXPENSE: 'expense',
};

export const TransactionCategory = {
  RENT: 'Aluguel',
  WATER: 'Água',
  ELECTRICITY: 'Luz',
  INTERNET: 'Internet',
  TAXES: 'IPTU/Impostos',
  SALARY: 'Salário',
  PRODUCT_PURCHASE: 'Compra de Produto',
  SERVICE_REVENUE: 'Faturamento de Serviço',
  SALES_REVENUE: 'Faturamento de Venda',
  SERVICE_COST: 'Custo de Serviço',
  OTHER: 'Outros',
};

export const ServiceOrderStatus = {
  PENDING: 'Pendente',
  COMPLETED: 'Concluído',
};

export const PaymentMethod = {
  PIX: 'Pix',
  CREDIT_CARD: 'Cartão de Crédito',
  CREDIT_CARD_SIGHT: 'Crédito à Vista',
  CREDIT_CARD_INSTALLMENT: 'Crédito Parcelado',
  BANK_TRANSFER: 'Transferência Bancária',
  CASH: 'Dinheiro',
  DEBIT_CARD: 'Cartão de Débito',
  BANK_SLIP: 'Boleto Bancário',
};

export const Bank = {
  ITAU: 'Itaú',
  INTER: 'Inter',
  CAIXA: 'Caixa',
  OTHER: 'Outros',
};
