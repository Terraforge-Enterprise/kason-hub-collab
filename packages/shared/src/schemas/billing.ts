import { z } from "zod";
import { PAYMENT_METHODS, PAYMENT_TYPES } from "../constants/payment-enums";

// Query-string boolean: z.coerce.boolean() would turn the string "false"
// into true (Boolean("false") === true), so parse the literals explicitly.
const queryBool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

export const createChargeSchema = z.object({
  chargeNumber: z.string().min(1),
  tenancyId: z.string().uuid().optional().or(z.literal("")),
  unitId: z.string().uuid().optional().or(z.literal("")),
  partyId: z.string().uuid(),
  chargeType: z.string().min(1),
  // ChargeCategory id (accounting-docs P1). Optional at the SCHEMA level so
  // flag-dark clients keep working; createChargeService enforces presence
  // (400 CATEGORY_REQUIRED) only when ENABLE_PHASE2_BILLING_DOCS is on.
  categoryId: z.string().uuid().optional(),
  description: z.string().optional(),
  dueDate: z.string().min(1),
  amount: z.string().min(1),
  currency: z.string().default("MYR"),
});

// ── Charges & Payments redesign (2026-07-04 spec) ────────────────────────────
// Month params are BARE "YYYY-MM" everywhere in the v2 endpoints (the
// documents API is strict ^\d{4}-\d{2}$ and silently 400s on "-01" — pin the
// same contract here so clients never mix the two).
export const monthParamSchema = z.string().regex(/^\d{4}-\d{2}$/, "must be YYYY-MM");

// Charges register pagination (spec §4.8 gap) + v2 server-side filters
// (charges-payments redesign §3.4). page/pageSize keep NO defaults —
// presence/absence stays the pagination switch. All filters optional; the
// no-filter no-pagination call remains byte-identical to the legacy response.
export const listChargesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
  partyId: z.string().uuid().optional(),
  outstandingOnly: queryBool.optional(),
  status: z.string().optional(),
  unitId: z.string().uuid().optional(),
  categoryId: z.string().uuid().optional(),
  counterparty: z.enum(["tenant", "owner"]).optional(),
  month: monthParamSchema.optional(),
  q: z.string().optional(),
  // Spec 1 (Phase 1): admin filter for charges blocked from issuance by fail-closed classification.
  economicClassificationStatus: z.enum(["NEEDS_ECONOMIC_CLASSIFICATION"]).optional(),
});
export type ListChargesQuery = z.infer<typeof listChargesQuerySchema>;

// Spec 1 (Phase 1, R26): set/correct a charge's authoritative economic classification.
// Route restricts this to UNISSUED charges; issued charges use the audited correction path.
export const patchEconomicTreatmentInput = z
  .object({
    commercialPurpose: z.enum(["RENT", "UTILITY", "CARPARK", "SERVICE", "MANAGEMENT_FEE", "OTHER_OWNER_COLLECTION"]).optional(),
    fundedBy: z.enum(["owner", "manager", "tenant_direct", "tenant_funded", "third_party"]).optional(),
    revenueRecognition: z.enum(["manager_revenue", "owner_funds", "recovery_of_advance", "third_party_collection", "none"]).optional(),
    settlementRecipient: z.enum(["manager", "owner", "third_party", "none"]).optional(),
    nonBillable: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: "at least one field is required" });
export type PatchEconomicTreatmentInput = z.infer<typeof patchEconomicTreatmentInput>;

export const postChargeSchema = z.object({
  chargeId: z.string().uuid(),
});

// P3 (spec §4.3): paid charges fork three ways — recorded-in-error (revert the
// payment first), hold-as-credit (CN credit balance), or refund (Refund Note).
// DEPRECATED (R1): superseded by CORRECTION_STRATEGIES below. Kept for ONE
// release as a wire-compatible alias so existing callers keep working
// (hold_credit → CREDIT_ADJUSTMENT, refund → REFUND).
export const PAID_HANDLING_OPTIONS = ["error_revert_first", "hold_credit", "refund"] as const;
export type PaidHandling = (typeof PAID_HANDLING_OPTIONS)[number];

// R1 correction state-machine: an explicit strategy replaces the old
// `error_revert_first` default (which 409'd, forcing the operator to un-record a
// real payment). CREDIT/DEBIT keep the allocation (adjustment doc);
// CANCEL_AND_REPLACE moves the allocation onto a replacement charge; REFUND
// returns the money. Consumed by the service gate + Tasks 7/8/11.
export const CORRECTION_STRATEGIES = [
  "CREDIT_ADJUSTMENT",
  "DEBIT_ADJUSTMENT",
  "CANCEL_AND_REPLACE",
  "REFUND",
] as const;
export type CorrectionStrategy = (typeof CORRECTION_STRATEGIES)[number];

export const refundDetailsSchema = z.object({
  amount: z.string().regex(/^\d+(\.\d{1,2})?$/, "must be a decimal string with up to 2dp"),
  method: z.string().min(1),
  bankRef: z.string().optional(),
  proofKey: z.string().optional(),
  refundedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD"), // ISO date (YYYY-MM-DD)
});
export type RefundDetailsInput = z.infer<typeof refundDetailsSchema>;

// R1: a replacement charge's lines for the CANCEL_AND_REPLACE strategy. Optional
// + additive here; Task 8 wires the enforcement (min-1 lines, category resolve).
const replacementLineSchema = z.object({
  categoryId: z.string().uuid(),
  description: z.string().min(1),
  amount: z.string().regex(/^\d+(\.\d{1,2})?$/, "must be a decimal string with up to 2dp"),
});

// A correction "wants a refund" when the caller asked for REFUND via either the
// R1 strategy or the deprecated paidHandling alias. Keeps the superRefine
// contract identical for both wire shapes during the one-release overlap.
const wantsRefund = (data: { strategy?: CorrectionStrategy; paidHandling?: PaidHandling }) =>
  data.strategy === "REFUND" || data.paidHandling === "refund";

export const voidChargeSchema = z
  .object({
    chargeId: z.string().uuid(),
    reason: z.string().min(3),
    // R1 correction strategy (replaces the paidHandling fork). Optional +
    // additive: flag-dark clients never send it.
    strategy: z.enum(CORRECTION_STRATEGIES).optional(),
    // CANCEL_AND_REPLACE replacement lines (Task 8 enforces relevance).
    replacement: z.object({ lines: z.array(replacementLineSchema).min(1) }).optional(),
    // DEBIT_ADJUSTMENT only (R2, Task 11): the amount the receivable is raised by.
    // Optional + additive; the service enforces > 0 (400 ADJUSTMENT_AMOUNT_INVALID)
    // and mints a Debit Note of this magnitude. Ignored by every other strategy.
    adjustmentAmount: z.string().regex(/^\d+(\.\d{1,2})?$/, "must be a decimal string with up to 2dp").optional(),
    // DEBIT_ADJUSTMENT only (R2, Task 11): caller-supplied idempotency token that
    // dedupes a true retry of the SAME adjustment (keys the DN + the outstanding
    // increment, so a replay increments outstanding EXACTLY once). Absent, the
    // service derives a key from charge+amount.
    idempotencyKey: z.string().uuid().optional(),
    // DEPRECATED (R1) — one-release alias. Optional + additive: flag-dark clients
    // never send these; the flag-dark service path ignores them, so master
    // behaviour is unchanged. hold_credit → CREDIT_ADJUSTMENT, refund → REFUND.
    paidHandling: z.enum(PAID_HANDLING_OPTIONS).optional(),
    refund: refundDetailsSchema.optional(),
  })
  // Cross-field: refund details are only meaningful (and only allowed) when the
  // correction is a REFUND (via strategy OR the deprecated paidHandling alias);
  // conversely a REFUND always needs the details.
  .superRefine((data, ctx) => {
    if (data.refund !== undefined && !wantsRefund(data)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["refund"],
        message: "refund details require the REFUND strategy (or paidHandling 'refund')",
      });
    }
    if (wantsRefund(data) && data.refund === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["refund"],
        message: "refund details are required for the REFUND strategy (or paidHandling 'refund')",
      });
    }
  });

// Shared body for the utility-bill / owner-statement / statement-line void
// endpoints once ENABLE_PHASE2_BILLING_DOCS is on (reason mandatory, min 3).
export const voidReasonBody = z.object({ reason: z.string().min(3) });
export type VoidReasonInput = z.infer<typeof voidReasonBody>;

export const createPaymentSchema = z.object({
  paymentNumber: z.string().min(1),
  partyId: z.string().uuid(),
  paymentType: z.string().min(1),
  paymentMethod: z.string().min(1),
  amount: z.string().min(1),
  currency: z.string().default("MYR"),
  receivedAt: z.string().min(1),
  referenceNote: z.string().optional(),
  externalReference: z.string().optional(),
});

export const allocatePaymentSchema = z.object({
  paymentId: z.string().uuid(),
  chargeId: z.string().uuid(),
  allocatedAmount: z.string().min(1),
});

export const updatePaymentStatusSchema = z.object({
  paymentId: z.string().uuid(),
  status: z.enum(["void", "refunded"]),
  note: z.string().optional(),
});

const allocationLineSchema = z.object({
  chargeId: z.string().uuid(),
  allocatedAmount: z.string().min(1),
  prorateRatio: z.string().optional(),
});

export const allocatePaymentBatchSchema = z.object({
  paymentId: z.string().uuid(),
  idempotencyKey: z.string().uuid(),
  allocations: z.array(allocationLineSchema).min(1).max(50),
});

export const postPaymentSchema = z.object({
  paymentId: z.string().uuid(),
});

// Refusing a tenant-submitted transfer slip. The reason is MANDATORY and shown
// verbatim to the tenant — a rejection with no reason leaves them able only to
// re-submit the same slip that was just refused, which is how a support ticket
// is born. min(3) blocks the reflexive "." / "no"; max(500) matches the
// `notes` cap on the submit side.
export const rejectPaymentSchema = z.object({
  paymentId: z.string().uuid(),
  reason: z.string().trim().min(3, "Tell the tenant why, so they can fix it and re-submit").max(500),
});

// Resolving a payment parked in `needs_reconciliation` — the gateway confirmed
// it, but a human had already cancelled it (or the gateway had already failed
// it), so it could not be applied automatically.
//
// `settle` hands it back to the ordinary settle path; `dismiss` closes it as
// genuinely not received. The reason is MANDATORY and longer-minimum than a slip
// rejection's: this is a person overriding an automated decision about money the
// payer's bank has most likely already taken, and it is the entry an auditor
// will ask to see the justification for. It is kept on the audit row, never
// shown to the tenant.
export const resolveReconciliationSchema = z.object({
  paymentId: z.string().uuid(),
  action: z.enum(["settle", "dismiss"]),
  reason: z
    .string()
    .trim()
    .min(10, "Say what you checked and what you found — this is kept for the audit trail")
    .max(500),
});

export const reverseAllocationSchema = z.object({
  paymentId: z.string().uuid(),
  allocationId: z.string().uuid(),
  reason: z.string().min(3).default("(unspecified)"),
  idempotencyKey: z.string().uuid().optional(), // service generates one if absent (deprecation path)
  amount: z.string().regex(/^\d+(\.\d{1,2})?$/, "must be a decimal string").optional(), // absent = full allocatedAmount
});

export const listPaymentsQuerySchema = z.object({
  status: z.string().optional(),
  partyId: z.string().uuid().optional(),
  method: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  hasUnallocated: z.coerce.boolean().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).default(50),
});

export const chargesGroupedQuerySchema = z.object({
  month: monthParamSchema,
  groupBy: z.enum(["unit", "statement"]),
});

export const chargesSummaryQuerySchema = z.object({ month: monthParamSchema });
export const paymentsSummaryQuerySchema = z.object({ month: monthParamSchema });

// Atomic record+allocate (spec B3). NO top-level amount: the payment amount is
// derived server-side as Σ(allocations.allocatedAmount) so it always foots.
// idempotencyKey covers the WHOLE operation (create + allocations).
export const recordAndAllocatePaymentSchema = z.object({
  paymentNumber: z.string().min(1),
  partyId: z.string().uuid(),
  paymentType: z.enum(PAYMENT_TYPES),
  paymentMethod: z.enum(PAYMENT_METHODS),
  currency: z.string().default("MYR"),
  receivedAt: z.string().min(1),
  referenceNote: z.string().optional(),
  externalReference: z.string().optional(),
  idempotencyKey: z.string().uuid(),
  // Transfer-slip / proof-of-payment storage keys (R10). Server-minted by the
  // slip-upload route; persisted on Payment.attachmentKeys. Optional + additive.
  attachmentKeys: z.array(z.string().min(1)).max(20).optional(),
  allocations: z.array(allocationLineSchema).min(1).max(50),
});
export type RecordAndAllocateInput = z.infer<typeof recordAndAllocatePaymentSchema>;

// Invoice-scoped "Record payment" (manual bank transfer received outside the app).
// Payer + method are DERIVED server-side from the document, so they are not in the
// payload. The payment amount is Σ(allocations) (never a client total). A transfer
// slip is MANDATORY (attachmentKeys min 1) — enforced here so a bypassed client
// cannot record a slip-less bank transfer. Every allocation must target a charge on
// THIS invoice (checked in the service against the document's lines).
export const recordInvoicePaymentSchema = z.object({
  documentId: z.string().uuid(),
  paymentNumber: z.string().min(1),
  receivedAt: z.string().min(1),
  referenceNote: z.string().optional(),
  externalReference: z.string().optional(),
  idempotencyKey: z.string().uuid(),
  attachmentKeys: z.array(z.string().min(1)).min(1).max(20),
  allocations: z.array(allocationLineSchema).min(1).max(50),
});
export type RecordInvoicePaymentInput = z.infer<typeof recordInvoicePaymentSchema>;
