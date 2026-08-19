// Recompute a Charge.status from its outstanding balance after an allocation
// is applied or reversed. `posted` is the canonical active-unpaid status
// (charges are created `posted` in billing.service.ts). Sub-cent slack
// guards against Decimal/float rounding noise.
export function chargeStatusForOutstanding(
  outstanding: number,
  amount: number,
): "paid" | "partially_paid" | "posted" {
  if (outstanding <= 0.005) return "paid";
  if (outstanding >= amount - 0.005) return "posted";
  return "partially_paid";
}
