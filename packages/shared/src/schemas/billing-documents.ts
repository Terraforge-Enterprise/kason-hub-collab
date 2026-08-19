// packages/shared/src/schemas/billing-documents.ts
// DTOs + query schema for the immutable BillingDocument register (spec §4.1/§4.2).
// Money travels as 2-dp decimal STRINGS (Prisma.Decimal.toString()).
import { z } from "zod";
import { BILLING_DOC_TYPES, type BillingDocType } from "./charge-categories";
import type { AdjustmentStatus, DerivedPaymentStatus } from "../billing/derive-document-badges";

// Query-string boolean: z.coerce.boolean() turns "false" into true, so parse the
// literals explicitly. Absent → undefined (filter not applied).
const queryBool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1")
  .optional();

export const BILLING_DOCUMENT_STATUSES = [
  "issued",
  "partially_settled",
  "settled",
  "offset",
] as const;
export type BillingDocumentStatus = (typeof BILLING_DOCUMENT_STATUSES)[number];

// R6: the three orthogonal status axes persisted on BillingDocument (Task 1).
// Exposed additively in the read DTOs; the legacy `status` field is retained
// through the transition (R10).
export const DOCUMENT_STATUSES = ["DRAFT", "ISSUED", "CANCELLED", "SUPERSEDED"] as const;
export const TAX_STATUSES = [
  "NOT_REQUIRED",
  "NOT_SUBMITTED",
  "SUBMITTED",
  "VALID",
  "INVALID",
  "CANCELLED",
] as const;
export const SETTLEMENT_STATUSES = ["UNPAID", "PARTIALLY_PAID", "PAID", "OVERPAID"] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];
export type TaxStatus = (typeof TAX_STATUSES)[number];
export type SettlementStatus = (typeof SETTLEMENT_STATUSES)[number];

export const listBillingDocumentsQuery = z.object({
  docType: z.enum(BILLING_DOC_TYPES).optional(),
  /** Multi-docType filter as a CSV (e.g. "invoice,debit_note"). Powers registers
   * that span several docTypes: the Invoices register lists tenant/owner invoices
   * AND the rent/utility/aircond debit notes (DEP series) — those are equally bills
   * owed by the counterparty, just routed to a debit_note under the pay_back_landlord
   * accounting family. When present it SUPERSEDES `docType`. Absent or empty → ignored.
   * Invalid members still 400 (genuinely bad param). */
  docTypes: z
    .string()
    .optional()
    .transform((v) => {
      const parts = (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      return parts.length ? parts : undefined;
    })
    .pipe(z.array(z.enum(BILLING_DOC_TYPES)).min(1).optional()),
  /** Register opt-in: only PRIMARY documents (originalDocumentId IS NULL). Excludes
   * correction/adjustment notes that layer on a parent — notably DEBIT_ADJUSTMENT
   * debit notes (series DN) which reuse the parent invoice's charge and are NOT an
   * independent bill. Primary invoices, cancel-and-replace REPLACEMENT invoices, and
   * primary DEP rent/utility debit notes all keep originalDocumentId null, so no real
   * bill is hidden. */
  primaryOnly: queryBool,
  /** Register opt-in: exclude CANCELLED / SUPERSEDED documents (re-Bill supersessions,
   * cancelled docs) — the Invoices register lists only live bills, never dead ones
   * that still carry a stale legacy `status` and would show inert pay/correct actions. */
  activeOnly: queryBool,
  seriesId: z.string().uuid().optional(),
  partyId: z.string().uuid().optional(),
  apartmentId: z.string().uuid().optional(),
  /** Billing month — "YYYY-MM". */
  month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  status: z.enum(BILLING_DOCUMENT_STATUSES).optional(),
  /** Counterparty side — powers the Tenant / Owner tabs. */
  counterpartyType: z.enum(["tenant", "owner"]).optional(),
  /** Filter to one property (BillingDocument.propertyId). */
  propertyId: z.string().uuid().optional(),
  /** Issued-date range, inclusive — "YYYY-MM-DD". */
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** Contains-match on documentNumber OR the counterparty's display name / phone. */
  q: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type ListBillingDocumentsQuery = z.infer<typeof listBillingDocumentsQuery>;

export type BillingDocumentListItem = {
  id: string;
  docType: BillingDocType;
  documentNumber: string;
  seriesCode: string;
  status: BillingDocumentStatus;
  /** R6 axes (Task 1) — orthogonal to the legacy `status`, exposed additively. */
  documentStatus: DocumentStatus;
  taxStatus: TaxStatus;
  settlementStatus: SettlementStatus;
  /** Derived-on-read (billing-document-status-model) — orthogonal display axes computed
   * from the linked CN/DN + posted payments. The register/detail badge picker reads
   * THESE, not the stale persisted `settlementStatus`. */
  derivedPaymentStatus: DerivedPaymentStatus;
  adjustmentStatus: AdjustmentStatus;
  /** True when this is a re-Billed / superseded original (carries a supersededByDocumentId). */
  isReBilled: boolean;
  /** Original total + active DN − active CN, floored at 0, 2-dp string. */
  adjustedTotal: string;
  /**
   * How many tenant-submitted payments against this document's charges are
   * still awaiting an admin's verification — the register's red dot.
   *
   * Counts DISTINCT payments, not allocations: one submitted transfer usually
   * settles several charges on the same invoice, and counting allocations would
   * badge a single slip as "3".
   *
   * ⚠️ NOT a money figure and never additive to `adjustedTotal`. An unverified
   * payment settles nothing (see rejectPaymentTx / cash-allocation.ts), so a
   * document can read Unpaid with a non-zero count — that combination is the
   * whole point, not a bug.
   */
  pendingVerificationCount: number;
  /** ISO datetime. */
  issuedAt: string;
  /** ISO date (first of month) or null. */
  billingMonth: string | null;
  counterpartyType: "tenant" | "owner";
  partyId: string;
  partyName: string;
  unitCode: string | null;
  /** Property name resolved from the doc's propertyId or, failing that, the
   * linked unit's apartment→property. Null when the doc carries no unit/property
   * (e.g. a manual invoice raised without a unit). */
  propertyName: string | null;
  /** 2-dp decimal string. */
  total: string;
  originalDocumentNumber?: string | null;
  /** R9 (Task 12) — the Payment this receipt was issued for (P2 R13). Null on
   * non-receipt docs and on legacy receipts predating the link. Powers the
   * Receipts-row "Void payment" action (PUT /payments/:paymentId/status). */
  paymentId?: string | null;
};

export type BillingDocumentLineDto = {
  id: string;
  /** Null for overpayment-CN lines (R12a) — the line settles no charge. */
  chargeId: string | null;
  description: string;
  amount: string;
  sstRate: string;
  sstAmount: string;
  /** "—" when the line carries no category (R12a). */
  categoryName: string;
  /** Which unit this line is FOR, resolved server-side via
   * chargeId → Charge.unitId → Listing.apartment.unitCode. Null for a
   * charge-less line (R12a) or a charge carrying no unitId.
   *
   * Why it exists: a COMBINED owner statement mints ONE document spanning every
   * unit, so the document-level `unitCode` on BillingDocumentListItem is null by
   * design — leaving the reader unable to tell which management-fee line belongs
   * to which unit. This is the per-LINE answer the document level cannot give. */
  unitCode: string | null;
  /** Cash collected against this line, 2-dp string. "0.00" for a charge-less line.
   * Derived per-line: the line's charge paid total (Σ posted allocations − reversals)
   * PRORATED across the charge's lines by amount, so the parts foot to the charge
   * total. Exact for a 1:1 line↔charge invoice; a fair split for a pooled charge
   * itemised across lines (meter path). */
  paid: string;
  /** Still owed on this line, 2-dp string — the line's charge outstanding prorated the
   * same way as `paid`. "0.00" for a charge-less line. Σ(line outstanding) over a
   * charge equals that charge's outstanding. */
  outstanding: string;
  // --- Phase 2.1: line-level, SERVER-DERIVED adjustment fields (all money moves
  // attributed at CHARGE granularity, prorated across a charge's display lines
  // exactly like `paid`/`outstanding` above; the FE must never compute money). ---
  /** Alias of `amount` — the line's own amount before any note adjustment. */
  originalAmount: string;
  /** Sum of ACTIVE (documentStatus ISSUED) charge-backed debit_note note-line
   * amounts whose chargeId equals this line's charge, PRORATED across that
   * charge's display lines by line amount. "0.00" for a charge-less line or when
   * no such notes exist. */
  debitAdjustmentAmount: string;
  /** Same as `debitAdjustmentAmount` but for credit_note notes. */
  creditAdjustmentAmount: string;
  /** debitAdjustmentAmount − creditAdjustmentAmount. May be negative (signed
   * 2-dp string, e.g. "-23.00"). */
  netAdjustmentAmount: string;
  /** originalAmount + netAdjustmentAmount. */
  adjustedAmount: string;
  /** `sstAmount` after active notes — Σ(active DN note-line sstAmount) −
   * Σ(active CN note-line sstAmount) for this line's charge, prorated the same way,
   * clamped at 0. Equals `sstAmount` when the charge carries no notes.
   *
   * A note on an SST-bearing charge declares its OWN tax (issueDocumentTx derives it
   * from the line's sstRate and puts it in the document's sstAmount/total), so the
   * SST column must move with the note or a half-credited RM 1.00 line goes on
   * printing the full RM 0.08. RENDER this, not `sstAmount`. */
  adjustedSstAmount: string;
  /** "exact" when this line's charge backs exactly ONE line on this document
   * (1:1) or chargeId is null; "prorated" when the charge is itemised across
   * multiple display lines on this document (meter path). */
  allocationBasis: "exact" | "prorated";
  /** One entry per active charge-backed note touching this line's charge,
   * `amountCents` prorated to THIS line (integer cents). Empty when none. */
  adjustments: { noteId: string; docType: "credit_note" | "debit_note"; documentNumber: string; amountCents: number }[];
  /** Attachments from the source GridExpense (bill-expenses R6). `[]` for
   * non-expense lines and when the feature flag is off. */
  attachments: { id: string; filename: string }[];
  /** True when this line's `amount` IS tax that a SIBLING line already contributed
   * via its own `sstRate` — the SST sibling Charge `mintExpenseChargesTx` mints so
   * the tax has a row a payment can settle. Excluded from `subtotal` at mint.
   *
   * Renderers MUST fold it away (`foldTaxLines`). The consumers that ALLOCATE against
   * a line — the Record-Payment form, correct-invoice — MUST keep it, or the tax
   * becomes unpayable again. The CN/DN target picker is the one in between: it uses
   * `adjustmentTargetLines`, which drops only the siblings the server already moves
   * on its own (`createChargeAdjustmentService`) and keeps every orphan. */
  isTax: boolean;
  /** `Charge.parentChargeId` of a tax line — the base charge it taxes, so a renderer
   * can pair the two without parsing charge numbers. Null on every non-tax line. */
  taxParentChargeId: string | null;
};

export type BillingDocumentDetail = BillingDocumentListItem & {
  subtotal: string;
  sstAmount: string;
  creditAmount: string | null;
  /** Active debit-note / credit-note line totals for the adjusted-amount breakdown, 2-dp strings. */
  debitNoteTotal: string;
  creditNoteTotal: string;
  /** Cash collected against this document's charges — Σ(posted PaymentAllocation)
   * − Σ(reversals), 2-dp string. Payment cash only; credit-note offsets are shown
   * separately via `creditAmount`. */
  amountPaid: string;
  /** Outstanding still owed — Σ(charge.outstandingAmount) over this document's
   * charges, 2-dp string. Derived from the SAME source the settlement pill reads,
   * so `balance` "0.00" ⟺ settlementStatus PAID (can never contradict the pill).
   * SST-exclusive, mirroring the settlement model. */
  balance: string;
  reason: string | null;
  statementInvoiceId: string | null;
  /** True when a PDF has been rendered (pdfKey present). GET /:id/pdf renders on demand either way. */
  hasPdf: boolean;
  lines: BillingDocumentLineDto[];
  relatedDocuments: { id: string; docType: BillingDocType; documentNumber: string; status: BillingDocumentStatus }[];
};

// P3: manual "Apply credit" escape hatch (POST /billing-documents/:id/apply-credit)
export const applyCreditInput = z.object({
  chargeId: z.string().uuid(),
  amount: z.string().min(1),
});
export type ApplyCreditInput = z.infer<typeof applyCreditInput>;

// P4: manual overpayment Credit Note (POST /billing-documents/credit-notes).
// Lines may be charge-less / category-less (R12a). creditAmount defaults to the
// CN total (fully spendable).
export const createCreditNoteInput = z.object({
  originalDocumentId: z.string().uuid(),
  partyId: z.string().uuid(),
  counterpartyType: z.enum(["tenant", "owner"]),
  lines: z
    .array(
      z.object({
        description: z.string().min(1),
        amount: z.string().min(1),
        chargeId: z.string().uuid().optional(),
        categoryId: z.string().uuid().optional(),
      }),
    )
    .min(1)
    .max(50),
  creditAmount: z.string().optional(),
  reason: z.string().min(1),
  idempotencyKey: z.string().uuid(),
});
export type CreateCreditNoteInput = z.infer<typeof createCreditNoteInput>;

// Phase 3.1: charge-scoped CREATE credit/debit note (partial amounts), tenant-only
// (POST /billing-documents/charge-adjustments). Amount format (positive, max 2dp)
// and every structured rejection code are validated in the service, not here —
// mirrors applyCreditInput/createCreditNoteInput's `amount: z.string().min(1)`.
export const chargeAdjustmentInput = z.object({
  chargeId: z.string().uuid(),
  kind: z.enum(["credit", "debit"]),
  amount: z.string().min(1),
  reason: z.string().min(1),
  description: z.string().min(1).max(500).optional(),
  idempotencyKey: z.string().min(1).optional(),
});
export type ChargeAdjustmentInput = z.infer<typeof chargeAdjustmentInput>;

// Phase 4.1: VOID a charge-scoped credit/debit note (POST
// /billing-documents/:id/void), tenant-only, safe-default BLOCK. `:id` (the
// note's BillingDocument id) travels as the route param, not in the body —
// mirrors applyCreditInput's shape (id is a path param there too). Every
// structured rejection code is validated in the service, not here.
export const voidChargeAdjustmentInput = z.object({
  reason: z.string().min(1),
  idempotencyKey: z.string().min(1).optional(),
});
export type VoidChargeAdjustmentInput = z.infer<typeof voidChargeAdjustmentInput>;
