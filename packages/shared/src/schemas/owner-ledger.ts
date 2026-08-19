// Owner-Ledger (M6b) — shared value-sets + Zod input schemas.
// Consumed by the API owner-ledger module and the finance calc helpers (later tasks).
// Pure shared package: NO DB, NO API, NO money math here — schemas + constants only.
// Money values travel as 2-dp decimal STRINGS to avoid float drift.

import { z } from "zod";

/**
 * `informational` (added 2026-07-30) is a DISPLAY-ONLY direction: the row appears on
 * the ledger to explain something, but is deliberately neither income nor expense and
 * carries no +/− sign.
 *
 * Why a new direction rather than reusing one: every money-critical consumer filters
 * with positive equality (`=== "income"` / `=== "expense"`), so a new value is excluded
 * from all of them by construction — payout totals, the tax summary, and crucially the
 * per-income-line management fee in owner-statement-sections.ts, which is aligned 1:1
 * with `rows.filter(r => r.direction === "income")`. Booking the letting commission as
 * income would have charged the owner a management fee on rent they never received.
 * `payout` could not be borrowed either — it already means a cash remittance and is
 * special-cased in owner-ledger.service.ts.
 *
 * Rows with this direction MUST also be `includeInPayout: false`.
 */
export const OWNER_LEDGER_DIRECTIONS = ["income", "expense", "payout", "informational"] as const;
export const OWNER_PAID_BY = ["kaen", "owner", "tenant", "developer", "other"] as const;
export const OWNER_PAYMENT_STATUSES = ["paid", "pending", "reimbursed", "partial", "waived", "cancelled"] as const;
export const OWNER_TAX_CATEGORIES = ["rental_expense", "capital_expense", "owner_personal", "check_with_tax_agent", "not_applicable"] as const;
// Union of user §7 ∪ Yannie's real tabs (locked decision #1). Income first, then expense, then payout.
export const OWNER_LEDGER_CATEGORIES = [
  // income (8)
  "rental_income", "aircond_income", "utility_income", "carpark_income",
  "utilities_reimbursement", "repair_reimbursement", "deposit_forfeiture", "other_income",
  // expense (~22)
  "management_fee", "maintenance_fee", "sinking_fund", "repair_maintenance", "utilities_tnb", "water", "aircond",
  "wifi", "indah_water", "assessment", "cukai_petak", "access_card", "quit_rent", "fire_insurance",
  "cleaning", "aircond_service", "plumbing", "electrical_repair", "furniture_appliance",
  "tenant_compensation", "agent_commission", "legal_fee", "stamp_duty", "other_expense",
  // payout (1)
  "owner_payout",
  // informational (1) — KAEN's first-month letting commission. NOT `agent_commission`,
  // which is the agent-sales domain (see .claude/docs/domain-glossary.md): same word,
  // different system. This one explains where the owner's first month's rent went.
  "letting_commission",
] as const;

export type OwnerLedgerDirection = (typeof OWNER_LEDGER_DIRECTIONS)[number];
export type OwnerPaidBy = (typeof OWNER_PAID_BY)[number];
export type OwnerPaymentStatus = (typeof OWNER_PAYMENT_STATUSES)[number];
export type OwnerTaxCategory = (typeof OWNER_TAX_CATEGORIES)[number];
export type OwnerLedgerCategory = (typeof OWNER_LEDGER_CATEGORIES)[number];

/**
 * Per-category defaults for Paid-By, tax treatment, and payout inclusion.
 * Used by the entry form (auto-fill + lock) and the sync engine (single source of truth).
 * - `paidByLocked`: operating categories are always KAEN-paid; statutory are defaulted but overridable.
 * - `includeInPayout`: true = deducted from the owner's running balance (KAEN paid on owner's behalf);
 *   false = owner-paid-direct or income (not deducted from the payout calc).
 * - `defaultTaxCategory`: pre-fill only; always editable by the owner/tax agent.
 *
 * Note: `tenant_compensation` and `other_expense` are not in the spec table but exist in the
 * category list. They are treated as operating (kaen, locked, rental_expense) as a safe default.
 */
export const OWNER_CATEGORY_DEFAULTS: Record<
  string,
  {
    defaultPaidBy: OwnerPaidBy;
    includeInPayout: boolean;
    defaultTaxCategory: OwnerTaxCategory;
    paidByLocked: boolean;
  }
> = {
  // ── Operating (KAEN always pays → locked, deducted from payout) ──────────────
  management_fee:     { defaultPaidBy: "kaen", includeInPayout: true, defaultTaxCategory: "rental_expense",  paidByLocked: true  },
  maintenance_fee:    { defaultPaidBy: "kaen", includeInPayout: true, defaultTaxCategory: "rental_expense",  paidByLocked: true  },
  sinking_fund:       { defaultPaidBy: "kaen", includeInPayout: true, defaultTaxCategory: "rental_expense",  paidByLocked: true  },
  repair_maintenance: { defaultPaidBy: "kaen", includeInPayout: true, defaultTaxCategory: "rental_expense",  paidByLocked: true  },
  utilities_tnb:      { defaultPaidBy: "kaen", includeInPayout: true, defaultTaxCategory: "rental_expense",  paidByLocked: true  },
  water:              { defaultPaidBy: "kaen", includeInPayout: true, defaultTaxCategory: "rental_expense",  paidByLocked: true  },
  indah_water:        { defaultPaidBy: "kaen", includeInPayout: true, defaultTaxCategory: "rental_expense",  paidByLocked: true  },
  wifi:               { defaultPaidBy: "kaen", includeInPayout: true, defaultTaxCategory: "rental_expense",  paidByLocked: true  },
  aircond:            { defaultPaidBy: "kaen", includeInPayout: true, defaultTaxCategory: "rental_expense",  paidByLocked: true  },
  cleaning:           { defaultPaidBy: "kaen", includeInPayout: true, defaultTaxCategory: "not_applicable",  paidByLocked: true  },
  aircond_service:    { defaultPaidBy: "kaen", includeInPayout: true, defaultTaxCategory: "rental_expense",  paidByLocked: true  },
  plumbing:           { defaultPaidBy: "kaen", includeInPayout: true, defaultTaxCategory: "rental_expense",  paidByLocked: true  },
  electrical_repair:  { defaultPaidBy: "kaen", includeInPayout: true, defaultTaxCategory: "rental_expense",  paidByLocked: true  },
  access_card:        { defaultPaidBy: "kaen", includeInPayout: true, defaultTaxCategory: "not_applicable",  paidByLocked: true  },
  furniture_appliance:{ defaultPaidBy: "kaen", includeInPayout: true, defaultTaxCategory: "capital_expense", paidByLocked: true  },
  // non-spec catch-alls (paidByLocked:false so overrides are possible)
  tenant_compensation:{ defaultPaidBy: "kaen", includeInPayout: true, defaultTaxCategory: "rental_expense",  paidByLocked: false },
  other_expense:      { defaultPaidBy: "kaen", includeInPayout: true, defaultTaxCategory: "rental_expense",  paidByLocked: false },

  // ── Statutory (varies per owner → defaulted kaen, overridable) ───────────────
  assessment:         { defaultPaidBy: "kaen", includeInPayout: true, defaultTaxCategory: "rental_expense",  paidByLocked: false },
  quit_rent:          { defaultPaidBy: "kaen", includeInPayout: true, defaultTaxCategory: "rental_expense",  paidByLocked: false },
  cukai_petak:        { defaultPaidBy: "kaen", includeInPayout: true, defaultTaxCategory: "rental_expense",  paidByLocked: false },
  fire_insurance:     { defaultPaidBy: "kaen", includeInPayout: true, defaultTaxCategory: "rental_expense",  paidByLocked: false },
  legal_fee:          { defaultPaidBy: "kaen", includeInPayout: true, defaultTaxCategory: "capital_expense", paidByLocked: false },
  stamp_duty:         { defaultPaidBy: "kaen", includeInPayout: true, defaultTaxCategory: "capital_expense", paidByLocked: false },
  agent_commission:   { defaultPaidBy: "kaen", includeInPayout: true, defaultTaxCategory: "rental_expense",  paidByLocked: false },

  // ── Income (KAEN collects on owner's behalf — not deducted from balance) ─────
  rental_income:            { defaultPaidBy: "kaen", includeInPayout: false, defaultTaxCategory: "not_applicable", paidByLocked: false },
  aircond_income:           { defaultPaidBy: "kaen", includeInPayout: false, defaultTaxCategory: "not_applicable", paidByLocked: false },
  utility_income:           { defaultPaidBy: "kaen", includeInPayout: false, defaultTaxCategory: "not_applicable", paidByLocked: false },
  carpark_income:           { defaultPaidBy: "kaen", includeInPayout: false, defaultTaxCategory: "not_applicable", paidByLocked: false },
  utilities_reimbursement:  { defaultPaidBy: "kaen", includeInPayout: false, defaultTaxCategory: "not_applicable", paidByLocked: false },
  repair_reimbursement:     { defaultPaidBy: "kaen", includeInPayout: false, defaultTaxCategory: "not_applicable", paidByLocked: false },
  deposit_forfeiture:       { defaultPaidBy: "kaen", includeInPayout: false, defaultTaxCategory: "not_applicable", paidByLocked: false },
  other_income:             { defaultPaidBy: "kaen", includeInPayout: false, defaultTaxCategory: "not_applicable", paidByLocked: false },

  // ── Payout (cash remittance KAEN → owner) ────────────────────────────────────
  owner_payout: { defaultPaidBy: "kaen", includeInPayout: false, defaultTaxCategory: "not_applicable", paidByLocked: true  },

  // ── Informational (explains a month; never moves money) ──────────────────────
  // includeInPayout MUST stay false: the owner never receives this rent, so it must
  // not add to the payout. The 8% SST they DO bear is booked separately as an
  // `other_expense` (letting_commission_sst) and is the only real deduction.
  letting_commission: { defaultPaidBy: "kaen", includeInPayout: false, defaultTaxCategory: "not_applicable", paidByLocked: true },
};

/**
 * Categories whose rows are display-only narrative — shown to explain a period, never
 * summed into income, expense, payout, or the management-fee base. ONE definition so
 * the portal ledger, the statement, the tax summary, the admin page and the PDF cannot
 * drift apart on what counts as money.
 */
export const OWNER_LEDGER_INFORMATIONAL_CATEGORIES: ReadonlySet<string> = new Set([
  "letting_commission",
]);

/** True when a ledger row is narrative only and must not be signed or totalled. */
export function isInformationalLedgerRow(row: { direction: string; category?: string }): boolean {
  return row.direction === "informational" || OWNER_LEDGER_INFORMATIONAL_CATEGORIES.has(row.category ?? "");
}

const decimalString = z.string().regex(/^\d+(\.\d{1,2})?$/, "expected a non-negative money value");
const monthString = z.string().regex(/^\d{4}-\d{2}$/, "expected YYYY-MM");
const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

const ownerLedgerShape = z.object({
  ownerPartyId: z.string().uuid(),
  propertyId: z.string().uuid(),
  apartmentId: z.string().uuid().nullable().optional(),
  listingId: z.string().uuid().nullable().optional(),
  tenancyId: z.string().uuid().nullable().optional(),
  statementMonth: monthString,
  transactionDate: dateString,
  direction: z.enum(OWNER_LEDGER_DIRECTIONS),
  category: z.enum(OWNER_LEDGER_CATEGORIES),
  description: z.string().max(500).nullable().optional(),
  remarks: z.string().max(500).nullable().optional(),
  amount: decimalString,
  sstAmount: decimalString.nullable().optional(),
  paidBy: z.enum(OWNER_PAID_BY),
  paymentStatus: z.enum(OWNER_PAYMENT_STATUSES).default("paid"),
  taxCategory: z.enum(OWNER_TAX_CATEGORIES).default("check_with_tax_agent"),
  attachmentKeys: z.array(z.string()).default([]),
});

export const ownerLedgerEntryInput = ownerLedgerShape
  // Payout-shaped rules: direction=payout ⇒ category must be owner_payout, paidBy must be kaen.
  .refine(
    (v) => v.direction !== "payout" || v.category === "owner_payout",
    { message: "payout entries must use category 'owner_payout'", path: ["category"] },
  )
  .refine(
    (v) => v.direction !== "payout" || v.paidBy === "kaen",
    { message: "payout entries must have paidBy 'kaen'", path: ["paidBy"] },
  );

// PATCH variant: all fields optional, no defaults (so absent fields are undefined),
// plus the optimistic-concurrency token.
// Zod 4 preserves `.default()` from the base shape through `.partial()`, which
// would make the "at least one mutable field" refine always pass.  We strip
// defaults on the three fields that carry them so absent fields stay undefined.
const ownerLedgerPatchShape = ownerLedgerShape
  .partial()
  .extend({
    paymentStatus: z.enum(OWNER_PAYMENT_STATUSES).optional(),
    taxCategory: z.enum(OWNER_TAX_CATEGORIES).optional(),
    attachmentKeys: z.array(z.string()).optional(),
    expectedUpdatedAt: z.string().datetime(),
  });

export const ownerLedgerEntryPatch = ownerLedgerPatchShape
  .refine(
    (v) => Object.keys(v).filter((k) => k !== "expectedUpdatedAt").some((k) => (v as Record<string, unknown>)[k] !== undefined),
    { message: "PATCH must change at least one field" },
  )
  // Payout-shaped rules on PATCH: if direction is being set to payout, enforce category + paidBy.
  .refine(
    (v) => v.direction !== "payout" || v.category === undefined || v.category === "owner_payout",
    { message: "payout entries must use category 'owner_payout'", path: ["category"] },
  )
  .refine(
    (v) => v.direction !== "payout" || v.paidBy === undefined || v.paidBy === "kaen",
    { message: "payout entries must have paidBy 'kaen'", path: ["paidBy"] },
  );

export const ownerLedgerListQuery = z.object({
  ownerPartyId: z.string().uuid().optional(),
  propertyId: z.string().uuid().optional(),
  /** P4 unit-first ledger: narrow the list to one apartment (additive). */
  apartmentId: z.string().uuid().optional(),
  month: monthString.optional(),
  fromMonth: monthString.optional(),
  toMonth: monthString.optional(),
  direction: z.enum(OWNER_LEDGER_DIRECTIONS).optional(),
  category: z.enum(OWNER_LEDGER_CATEGORIES).optional(),
  paidBy: z.enum(OWNER_PAID_BY).optional(),
  paymentStatus: z.enum(OWNER_PAYMENT_STATUSES).optional(),
  taxCategory: z.enum(OWNER_TAX_CATEGORIES).optional(),
  hasAttachment: z.enum(["true", "false"]).optional().transform((v) => (v == null ? undefined : v === "true")),
  limit: z.coerce.number().int().positive().max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const ownerLedgerSyncInput = z.object({ ownerPartyId: z.string().uuid(), month: monthString });
export const ownerLedgerRangeQuery = z.object({
  ownerPartyId: z.string().uuid().optional(),
  propertyId: z.string().uuid().optional(),
  fromMonth: monthString.optional(),
  toMonth: monthString.optional(),
});

export type OwnerLedgerEntryInput = z.infer<typeof ownerLedgerEntryInput>;
export type OwnerLedgerEntryPatch = z.infer<typeof ownerLedgerEntryPatch>;
export type OwnerLedgerListQuery = z.infer<typeof ownerLedgerListQuery>;
export type OwnerLedgerSyncInput = z.infer<typeof ownerLedgerSyncInput>;
export type OwnerLedgerRangeQuery = z.infer<typeof ownerLedgerRangeQuery>;
