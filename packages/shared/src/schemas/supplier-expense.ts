// packages/shared/src/schemas/supplier-expense.ts
// Accounting-document redesign P3 — the internal "Expense" record (EXP- series):
// a supplier/property cost recorded ONCE, then ALLOCATED across who ultimately
// bears it. Pure shared package: value-sets + zod inputs + pure invariants only.
// Money travels as 2-dp decimal STRINGS (repo convention); invariants run in cents.

import { z } from "zod";

// Who ultimately BEARS one cost allocation. A single supplier expense may carry
// several allocations with different bearers — that IS the UI "Shared" case (>1
// distinct bearer). So the persisted per-allocation value-set is the three
// concrete bearers; "shared" is an input concept that fans out to these.
export const BORNE_BY = ["tenant", "owner", "kaen"] as const;
export type BorneBy = (typeof BORNE_BY)[number];

// Each bearer routes to a distinct downstream fate (wired in later phases):
//   tenant → Expense Bill (EB-, P4) recovered from the tenant
//   owner  → owner-ledger deduction (P5), netted out of the owner payout
//   kaen   → KAEN operating-expense ledger (P6), the agency's own P&L
export const BORNE_BY_FATE = {
  tenant: "expense_bill",
  owner: "owner_ledger_deduction",
  kaen: "kaen_opex",
} as const satisfies Record<BorneBy, string>;
export type BorneByFate = (typeof BORNE_BY_FATE)[BorneBy];

export function borneByFate(borneBy: BorneBy): BorneByFate {
  return BORNE_BY_FATE[borneBy];
}

// ≤10 integer digits keeps a value inside the DB column bound DECIMAL(12,2) (10 before
// the decimal), so an out-of-range amount is a clean 400 here, never a 500 at insert.
const money = z.string().regex(/^\d{1,10}(\.\d{1,2})?$/, "expected a non-negative money value within DECIMAL(12,2)");
const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
  .refine((s) => {
    // Shape != validity (review panel 2026-07-22): reject rollover dates
    // (2025-02-29 -> Mar 1) and NaN variants (2026-13-45) so a bad date is a
    // clean 400 here, never a silently-wrong accounting period or a 500 at insert.
    const [y, m, d] = s.split("-").map(Number);
    const t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
  }, "expected a real calendar date (YYYY-MM-DD)");

// ── Pure split invariant (cents; no float drift) ────────────────────────────
/** Parse a regex-validated money string to integer cents (no parseFloat drift). */
export function toCentsStrict(value: string): number {
  const [whole, frac = ""] = value.split(".");
  return Number(whole) * 100 + Number((frac + "00").slice(0, 2));
}

export function sumAllocationCents(allocations: { amount: string }[]): number {
  return allocations.reduce((s, a) => s + toCentsStrict(a.amount), 0);
}

/** The sum of allocation amounts MUST equal the supplier expense total — an expense is
 * never partially or over allocated. Enforced by supplierExpenseInput's refine at CREATE.
 * P4/P5 MANDATE (review panel 2026-07-22): ANY non-create allocation writer (a PATCH, a
 * void-and-reallocate, a repair script) MUST re-assert this before persisting — otherwise a
 * mis-split silently routes only part of the cost, over/under-paying the owner. */
export function isFullyAllocated(totalAmount: string, allocations: { amount: string }[]): boolean {
  return sumAllocationCents(allocations) === toCentsStrict(totalAmount);
}

// ── Zod inputs ──────────────────────────────────────────────────────────────
export const expenseAllocationInput = z.object({
  borneBy: z.enum(BORNE_BY),
  amount: money,
  // Concrete party the cost lands on (tenant/owner allocations); null for kaen opex.
  partyId: z.string().uuid().nullable().optional(),
  tenancyId: z.string().uuid().nullable().optional(),
  chargeCategoryId: z.string().uuid().nullable().optional(),
  description: z.string().max(500).nullable().optional(),
});
export type ExpenseAllocationInput = z.infer<typeof expenseAllocationInput>;

export const supplierExpenseInput = z
  .object({
    supplierName: z.string().min(1).max(200),
    supplierRef: z.string().max(120).nullable().optional(),
    expenseDate: dateString,
    totalAmount: money,
    propertyId: z.string().uuid().nullable().optional(),
    apartmentId: z.string().uuid().nullable().optional(),
    unitId: z.string().uuid().nullable().optional(),
    description: z.string().max(500).nullable().optional(),
    allocations: z.array(expenseAllocationInput).min(1).max(50),
  })
  .refine((v) => isFullyAllocated(v.totalAmount, v.allocations), {
    message: "allocations must sum to the expense total",
    path: ["allocations"],
  });
export type SupplierExpenseInput = z.infer<typeof supplierExpenseInput>;
