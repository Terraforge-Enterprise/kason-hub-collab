// packages/shared/src/schemas/owner-funding-request.ts
// Accounting-document redesign P7 (reshaped, 2026-07-23) — Owner Funding Request:
// a DELIBERATE admin-issued ask for the owner to fund KAEN (e.g. a big repair far
// exceeds the rent collected this month). NOT a status, NOT auto-derived: the
// already-carried-forward negative owner running balance stays silent + automatic
// (computeOwnerRunningBalance / computeAvailableOwnerPayableC / derivePeriodRemittanceStatus
// and all payout math are UNCHANGED). This record exists only when an admin
// explicitly decides KAEN needs the owner to pay NOW — amount/reason are
// admin-SUPPLIED, never auto-computed. It is NOT a BillingDocument / invoice /
// debit_note / receivable — KAEN is not EARNING this money, it's requesting the
// owner send money IN. Pure shared package: zod input only.

import { z } from "zod";

// ≤10 integer digits keeps a value inside the DB column bound DECIMAL(12,2) (10
// before the decimal), so an out-of-range amount is a clean 400 here, never a
// 500 at insert. Mirrors supplier-expense.ts's `money`.
const money = z
  .string()
  .regex(/^\d{1,10}(\.\d{1,2})?$/, "expected a non-negative money value within DECIMAL(12,2)");

export const ownerFundingRequestInput = z.object({
  ownerPartyId: z.string().uuid(),
  amount: money,
  reason: z.string().min(1).max(500),
  propertyId: z.string().uuid().nullable().optional(),
});
export type OwnerFundingRequestInput = z.infer<typeof ownerFundingRequestInput>;
