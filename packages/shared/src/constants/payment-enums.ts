// Enum vocabulary for admin payment recording (spec B6). These lists cover
// every value system flows already WRITE today: "fpx" (portal FPX initiate),
// "credit_note" method + "credit_application" type (CN auto-apply payments),
// and the legacy form defaults ("bank_transfer" / "rental_payment").
// Legacy free-text rows remain readable — reads never validate against these.
export const PAYMENT_METHODS = [
  "bank_transfer",
  "cash",
  "fpx",
  "cheque",
  "card",
  "credit_note",
  "other",
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_TYPES = [
  "rental_payment",
  "deposit",
  "utility_payment",
  "credit_application",
  "other",
] as const;
export type PaymentType = (typeof PAYMENT_TYPES)[number];
