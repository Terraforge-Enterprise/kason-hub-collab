// packages/shared/src/schemas/charge-categories.ts
// Accounting-documents P1 (spec 2026-07-02 §4.1) — ChargeCategory registry +
// DocumentSeries value-sets, zod inputs, and DTO shapes shared API ↔ web.
// Pure shared package: schemas + constants only. Money/SST rates travel as
// decimal STRINGS (repo convention).

import { z } from "zod";
import { OWNER_LEDGER_CATEGORIES } from "./owner-ledger";

export const CATEGORY_FAMILIES = ["tenant_income", "owner_income", "pay_back_landlord"] as const;
export type CategoryFamily = (typeof CATEGORY_FAMILIES)[number];

/** All BillingDocument docTypes (P2 adds receipt; OEA adds owner_expense_advice;
 * CATEGORY_DOC_TYPES stays invoice/debit_note).
 *
 * MONEY-CRITICAL: `owner_expense_advice` MUST NOT be added to the invoice/debit_note
 * allowlist in owner-ledger.sync.ts's `chargeIdsAlreadyInvoiced`. That guard treats a
 * charge with a live line on an ISSUED invoice/debit_note as already-invoiced and skips
 * its Source-6 payout deduction. An OEA is EVIDENCE of a deduction, not a receivable —
 * putting it in that allowlist makes the deduction stop booking SILENTLY, with KAEN
 * absorbing the owner's expense and no error anywhere. */
export const BILLING_DOC_TYPES = [
  "invoice", "debit_note", "credit_note", "refund_note", "receipt", "owner_expense_advice",
  // Proforma spec R1/R2 (2026-08-10). A PROVISIONAL request for payment, not a
  // receivable: the bills grid issues it in place of a tenant invoice, freely replaces
  // it, and mints a REAL `invoice` from its lines only when money actually arrives.
  //
  // MONEY-CRITICAL, same shape as the owner_expense_advice warning above but inverted:
  // `proforma` must be WITHHELD from every docType money allowlist (the spec inventories
  // fourteen). The receivable already lives on Charge; a proforma is a dated snapshot
  // carrying zero money weight. Adding it to an allowlist makes the proforma AND the
  // invoice graduated from it both count the same charges — double-booking the owner
  // ledger, double-counting the tenant balance, or letting a credit note be raised
  // against a provisional document. isNonReceivableDocType("proforma") is the single
  // guard that keeps settlement from ever being derived on one.
  "proforma",
] as const;
export type BillingDocType = (typeof BILLING_DOC_TYPES)[number];

/** Categories route only to invoice/debit_note — CN/RN are never category-routed (spec §4.1). */
export const CATEGORY_DOC_TYPES = ["invoice", "debit_note"] as const;
export type CategoryDocType = (typeof CATEGORY_DOC_TYPES)[number];

/** Bills-grid category classification (profit vs expense side) — bills-grid category-classification feature. */
export const PROFIT_EXPENSE = ["profit", "expense"] as const;
export type ProfitExpense = (typeof PROFIT_EXPENSE)[number];

/**
 * Which side of a bills-grid expense sheet a category belongs to.
 *
 * The bills-grid expense drawer opens per bearer (owner sheet / tenant sheet) and its
 * Category picker previously listed EVERY active category, so an OWNER expense line
 * offered "Subsidy (tenant)" — a tenant-side code. This is the single mapping both the
 * picker filter and the settings Add-category form read, so the two can never disagree
 * about which side a family sits on.
 *
 * A Record (not a pair of arrays) on purpose: adding a bearer becomes a type error at
 * every consumer instead of a silently-empty list (repo lock-step-drift convention).
 *
 * `pay_back_landlord` is deliberately unreachable from here. It routes deposits/rent to
 * DEP/RB debit notes via isSystem codes that auto-post flows resolve BY CODE — it is not
 * a freeform bucket a grid expense line (or an admin-created category) should land in.
 */
export const BEARER_CATEGORY_FAMILY: Record<"tenant" | "owner", CategoryFamily> = {
  tenant: "tenant_income",
  owner: "owner_income",
};

/**
 * Active categories offerable on a bearer's expense sheet, PLUS whatever the row already
 * holds. `keepIds` is what stops the filter from being a money bug: a line saved before
 * this filter existed (or under the other bearer) still carries an off-side categoryId,
 * and dropping that option would render the <select> blank — reading as "No category"
 * while state still held the old id, and silently re-classifying the line on the next save.
 */
export function categoriesForBearer<T extends { id: string; family: CategoryFamily }>(
  categories: readonly T[],
  bearer: "tenant" | "owner",
  keepIds: readonly (string | null | undefined)[] = [],
): T[] {
  const family = BEARER_CATEGORY_FAMILY[bearer];
  const keep = new Set(keepIds.filter((id): id is string => !!id));
  return categories.filter((c) => c.family === family || keep.has(c.id));
}

const sstRateString = z.string().regex(/^\d{1,3}(\.\d{1,2})?$/, "expected a percentage like 8 or 8.00");
const codeString = z.string().min(2).max(64).regex(/^[a-z0-9_]+$/, "lowercase snake_case only");

export const createChargeCategoryInput = z.object({
  code: codeString,
  name: z.string().min(2).max(120),
  family: z.enum(CATEGORY_FAMILIES),
  docType: z.enum(CATEGORY_DOC_TYPES),
  seriesId: z.string().uuid(),
  defaultSstRate: sstRateString.optional(),
  eInvoiceEligible: z.boolean().optional(),
  ledgerCategory: z.enum(OWNER_LEDGER_CATEGORIES).nullable().optional(),
  sortOrder: z.number().int().min(0).optional(),
  description: z.string().max(500).nullable().optional(),
  // Settable at CREATE (was PATCH-only): the settings Add-category form asks for the
  // bills-grid P&L side up front, and a create-then-PATCH round trip would leave the
  // category briefly unclassified — visible in the picker with no P&L side.
  profitExpense: z.enum(PROFIT_EXPENSE).nullable().optional(),
});

// PATCH variant: all fields optional except the optimistic-concurrency token.
// `code` is deliberately NOT patchable — it is the stable machine key auto-post
// flows resolve by (rename via `name` only).
export const updateChargeCategoryInput = z
  .object({
    name: z.string().min(2).max(120).optional(),
    family: z.enum(CATEGORY_FAMILIES).optional(),
    docType: z.enum(CATEGORY_DOC_TYPES).optional(),
    seriesId: z.string().uuid().optional(),
    defaultSstRate: sstRateString.optional(),
    eInvoiceEligible: z.boolean().optional(),
    ledgerCategory: z.enum(OWNER_LEDGER_CATEGORIES).nullable().optional(),
    active: z.boolean().optional(),
    sortOrder: z.number().int().min(0).optional(),
    description: z.string().max(500).nullable().optional(),
    profitExpense: z.enum(PROFIT_EXPENSE).nullable().optional(),
    expectedUpdatedAt: z.string().datetime(),
  })
  .refine(
    (v) => Object.keys(v).filter((k) => k !== "expectedUpdatedAt").some((k) => (v as Record<string, unknown>)[k] !== undefined),
    { message: "PATCH must change at least one field" },
  );

export const updateDocumentSeriesInput = z
  .object({
    prefix: z.string().min(1).max(16).optional(),
    padding: z.number().int().min(1).max(10).optional(),
    includeYear: z.boolean().optional(),
    active: z.boolean().optional(),
    expectedUpdatedAt: z.string().datetime(),
  })
  .refine(
    (v) => Object.keys(v).filter((k) => k !== "expectedUpdatedAt").some((k) => (v as Record<string, unknown>)[k] !== undefined),
    { message: "PATCH must change at least one field" },
  );

export type CreateChargeCategoryInput = z.infer<typeof createChargeCategoryInput>;
export type UpdateChargeCategoryInput = z.infer<typeof updateChargeCategoryInput>;
export type UpdateDocumentSeriesInput = z.infer<typeof updateDocumentSeriesInput>;

export type ChargeCategoryDto = {
  id: string;
  code: string;
  name: string;
  family: CategoryFamily;
  docType: CategoryDocType;
  seriesId: string;
  seriesCode: string;
  defaultSstRate: string;
  eInvoiceEligible: boolean;
  ledgerCategory: string | null;
  isSystem: boolean;
  active: boolean;
  sortOrder: number;
  description: string | null;
  profitExpense: (typeof PROFIT_EXPENSE)[number] | null;
  updatedAt: string;
};

export type DocumentSeriesDto = {
  id: string;
  code: string;
  prefix: string;
  padding: number;
  includeYear: boolean;
  active: boolean;
  updatedAt: string;
};
