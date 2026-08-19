// Phase-2 owner remittance / offset / reversal / idempotency — shared Zod request schemas.
// Plan: docs/superpowers/plans/2026-07-20-rent-reclassification-phase2-remittance-offset.md
// (Task 4; Task 6/7/8/9 request shapes; GC2 integer cents; GC6 idempotency; GC10 currency).
//
// Consumed by the API owner-remittance routes (parse) and service (fingerprint via
// ../finance/owner-remittance.ts). Pure shared package: NO DB, NO API, NO money math here.
// Money values travel as 2-dp decimal STRINGS validated > 0 — integer-cents conversion
// happens at the Task-5 service boundary (GC2), not here.
//
// Allocation arrays cap at 50 entries — matches the established house convention for
// this exact "atomic record+allocate" shape (billing.ts's allocatePaymentBatchSchema /
// recordAndAllocatePaymentSchema / recordInvoicePaymentSchema all use .min(1).max(50)).

import { z } from "zod";
import { SUPPORTED_CURRENCIES } from "../constants/currencies";

// OWNER_REMITTANCE = ordinary remittance, MUST be fully allocated (R9) — enforced in the
// Task-6 service (REMITTANCE_NOT_FULLY_ALLOCATED is a 409 business guard, not a schema
// concern; it needs a DB-computed available-payable comparison, so it can't live here).
// PRE_STATEMENT_REMITTANCE = may be under-allocated at creation; Task 7's
// remittanceAllocateSchema tops up its allocations later.
export const REMITTANCE_SETTLEMENT_KINDS = ["OWNER_REMITTANCE", "PRE_STATEMENT_REMITTANCE"] as const;
export type RemittanceSettlementKind = (typeof REMITTANCE_SETTLEMENT_KINDS)[number];

// Real remittances only (schema.prisma:2602 comment) — offsets carry no paymentMethod.
// Deliberately NOT the broader shared PAYMENT_METHODS enum (constants/payment-enums.ts),
// which includes "fpx" / "card" / "credit_note" — channels that don't apply to KAEN
// paying an owner out of pocket.
export const REMITTANCE_PAYMENT_METHODS = ["bank_transfer", "cash", "cheque", "other"] as const;
export type RemittancePaymentMethod = (typeof REMITTANCE_PAYMENT_METHODS)[number];

// A POSITIVE money value with exactly 1-2 decimal places (e.g. "150.00", "150.5"). Every
// amount field these schemas guard (remittance `amount`, `allocatedAmount`) must be > 0 by
// domain (GC2 traceability row; ZERO_OR_NEGATIVE is the service-level mirror of this at the
// cents boundary). No leading '+', no leading '.', no scientific notation, no whitespace —
// the regex anchors the whole string so "1e10", " 5.00", "5.000", "5." all fail.
//
// DEFERRED (adversarial-audit B25): the integer-digit count is unbounded (`\d+`, no max),
// matching `toCents` (utils/money-cents.ts) and every sibling decimalString in this
// codebase (owner-billing.ts, owner-ledger.ts) — none of which cap magnitude either. A
// many-digit string would still overflow `OwnerLedgerEntry.amount Decimal(12,2)` (max 10
// integer digits) downstream. NOT fixed here: capping only this ONE schema would make it
// inconsistent with every sibling doing the identical job: a systemic fix belongs in
// `toCents` itself (the actual GC2 cents-conversion boundary), not duplicated per-schema.
const positiveDecimalString = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/, "expected a 2-decimal-place money value")
  .refine((v) => Number(v) > 0, "amount must be greater than 0");

// A REAL calendar date (no time-of-day) — OwnerLedgerEntry.transactionDate/statementMonth
// are `@db.Date` columns; the reversal's effectiveDate determines ITS OWN recognition
// period (progress.md WATCH-T9), so this must stay a plain date, never a full ISO
// datetime. Zod's native `.date()` (also used in schemas/{bills-grid,inventory}.ts)
// validates actual calendar validity (e.g. rejects "2026-02-30"), not just YYYY-MM-DD
// shape — stronger than a hand-rolled shape-only regex for no extra cost.
const dateString = z.string().date();

// Optional free text (bankReference / proofKey / memo) — non-empty when present, capped at
// 500 chars matching owner-ledger.ts's description/remarks convention for this same
// OwnerLedgerEntry-adjacent schema family (adversarial-audit B37).
const freeTextField = z.string().min(1).max(500).optional();

// DEFERRED (adversarial-audit B33): no uniqueness check on ownerStatementPeriodId across
// an allocations array (or billingDocumentLineId across lineAllocations, below) — two
// lines targeting the SAME period/charge currently pass. This is a genuine unstated
// product decision (reject as a duplicate vs. treat as a legitimate top-up in the same
// request), not specified anywhere in the plan/spec, so it is intentionally left
// unresolved here rather than guessed — a schema-layer `.superRefine` uniqueness check
// would be cheap to add (no DB read needed) once the desired behavior is confirmed.
const remittanceAllocationLineSchema = z.object({
  ownerStatementPeriodId: z.string().uuid(),
  allocatedAmount: positiveDecimalString,
});

// Task 6: POST /owner-remittances. NO proofStatus field — that's DERIVED server-side from
// paymentMethod+proofKey (R8: bank_transfer with no proofKey ⇒ PROOF_PENDING, never
// rejected), so it never appears in the request.
export const remittanceCreateSchema = z.object({
  ownerPartyId: z.string().uuid(),
  amount: positiveDecimalString,
  effectiveDate: dateString,
  settlementKind: z.enum(REMITTANCE_SETTLEMENT_KINDS),
  paymentMethod: z.enum(REMITTANCE_PAYMENT_METHODS),
  bankReference: freeTextField,
  proofKey: freeTextField,
  memo: freeTextField,
  currency: z.enum(SUPPORTED_CURRENCIES),
  allocations: z.array(remittanceAllocationLineSchema).min(1, "at least one allocation is required").max(50),
  idempotencyKey: z.string().uuid(),
});
export type RemittanceCreateInput = z.infer<typeof remittanceCreateSchema>;

// Task 7: POST /owner-remittances/:id/allocate — adds allocations to an existing
// PRE_STATEMENT_REMITTANCE. `entryId` comes from the URL path param, not the body.
// Reuses the same allocation-line shape as remittanceCreateSchema (ownerStatementPeriodId
// + allocatedAmount); the Σ(existing+new) ≤ entry amountC guard (ALLOCATION_EXCEEDS_UNALLOCATED)
// needs a DB read of the entry's existing allocations, so it is a Task-5/7 service guard,
// not a schema concern.
export const remittanceAllocateSchema = z.object({
  allocations: z.array(remittanceAllocationLineSchema).min(1, "at least one allocation is required").max(50),
  idempotencyKey: z.string().uuid(),
});
export type RemittanceAllocateInput = z.infer<typeof remittanceAllocateSchema>;

const offsetLineAllocationSchema = z.object({
  billingDocumentLineId: z.string().uuid(),
  allocatedAmount: positiveDecimalString,
});

// Task 8: POST /owner-receivable-offsets — non-cash settlement of IVOWN lines. NO
// top-level `amount` (mirrors recordAndAllocatePaymentSchema, billing.ts:229-231): the
// offset total is derived server-side as Σ(lineAllocations.allocatedAmount) so it always
// foots. NO settlementKind (fixed at OWNER_RECEIVABLE_OFFSET by the endpoint itself) and
// NO paymentMethod (schema.prisma:2602 — "null for offsets").
export const offsetCreateSchema = z.object({
  ownerPartyId: z.string().uuid(),
  effectiveDate: dateString,
  currency: z.enum(SUPPORTED_CURRENCIES),
  lineAllocations: z.array(offsetLineAllocationSchema).min(1, "at least one line allocation is required").max(50),
  memo: freeTextField,
  idempotencyKey: z.string().uuid(),
});
export type OffsetCreateInput = z.infer<typeof offsetCreateSchema>;

// Task 9: POST /owner-remittances/:id/reverse AND POST /owner-receivable-offsets/:id/reverse
// — ONE shared shape for both (append-only, net-zero reversal; GC5). `entryId` comes from
// the URL path param. The reversal amount is always the FULL original amount (never a
// client-supplied partial), so there is no amount field here. `reason` follows the
// dominant house convention for an audited money-mutating action (min 3 — see
// packages/shared/src/schemas/{parties,billing,commissions,billing-documents}.ts).
export const reverseSchema = z.object({
  reason: z.string().min(3),
  idempotencyKey: z.string().uuid(),
});
export type ReverseInput = z.infer<typeof reverseSchema>;
