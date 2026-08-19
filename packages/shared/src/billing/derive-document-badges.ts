// packages/shared/src/billing/derive-document-badges.ts
//
// Pure, total derivation of a billing document's three ORTHOGONAL display axes —
// lifecycle, payment status, adjustment status — plus the adjusted-amount figures.
// Single source of truth for BOTH the API read layer (list + detail DTOs) and the
// frontend badge picker, so the register and the detail drawer can never disagree.
//
// TWO MONEY BASES, kept separate on purpose:
//  • PAYMENT status is REUSED from the system's SST-EXCLUSIVE settlement computation
//    (the persisted `settlementStatus`, which status.service.ts derives from the
//    charges — the basis payments actually settle). It is NEVER re-derived from the
//    SST-INCLUSIVE document total (SST is a document-level field, not a charge, so
//    comparing an SST-inclusive total against SST-exclusive payments mis-reads every
//    SST-bearing invoice). FULLY_CREDITED is derived from the ADJUSTED amount netting
//    to zero (active charge-backed credit notes cover the whole bill) — NOT the legacy
//    `offset` flag, which is set on the whole document when ANY single charge is
//    credited, so a partially-credited grouped invoice is `offset` yet still owes.
//  • ADJUSTMENT display (adjusted amount + Debit/Credit note totals) is SST-INCLUSIVE
//    (document `total` − note `total`), so a full credit note nets to 0. The caller
//    passes only CHARGE-BACKED notes — overpayment credit notes (credit owed to the
//    payer, settling no charge) are excluded, so they never reduce the receivable.
//
// Never throws: unknown enum values fall back.

export type DocumentLifecycle = "DRAFT" | "ISSUED" | "CANCELLED" | "SUPERSEDED" | "VOIDED";
export type DerivedPaymentStatus =
  | "UNPAID"
  | "PARTIALLY_PAID"
  | "PAID"
  | "OVERPAID"
  | "FULLY_CREDITED";
export type AdjustmentStatus =
  | "NONE"
  | "CREDIT_NOTE_ISSUED"
  | "DEBIT_NOTE_ISSUED"
  | "CREDIT_AND_DEBIT_NOTES_ISSUED"
  | "FULLY_CREDITED";

/** An ACTIVE, CHARGE-BACKED adjustment note. `amountCents` is the note's SST-inclusive total. */
export type ActiveNote = { docType: "credit_note" | "debit_note"; amountCents: number };

export type DeriveBadgesInput = {
  /** BillingDocument.documentStatus (DRAFT|ISSUED|CANCELLED|SUPERSEDED). */
  documentStatus: string;
  /** True when a CANCELLED/SUPERSEDED document carries a supersededByDocumentId (a re-Bill). */
  isReBilled: boolean;
  /** Persisted settlementStatus (UNPAID|PARTIALLY_PAID|PAID|OVERPAID) — SST-exclusive, charge-basis. */
  settlementStatus: string;
  /** The document's own total, in cents (SST-INCLUSIVE) — the display basis. */
  originalTotalCents: number;
  /** Active, charge-backed CN/DN with SST-inclusive totals. Overpayment CNs are pre-excluded by the caller. */
  activeNotes: ActiveNote[];
};

export type DerivedBadges = {
  lifecycle: DocumentLifecycle;
  paymentStatus: DerivedPaymentStatus;
  adjustmentStatus: AdjustmentStatus;
  /** SST-inclusive display figures. */
  debitNoteCents: number;
  creditNoteCents: number;
  adjustedCents: number;
};

const LIFECYCLES = new Set<string>(["DRAFT", "ISSUED", "CANCELLED", "SUPERSEDED", "VOIDED"]);
const SETTLEMENT_VALUES = new Set<string>(["UNPAID", "PARTIALLY_PAID", "PAID", "OVERPAID"]);

export function deriveDocumentBadges(input: DeriveBadgesInput): DerivedBadges {
  const lifecycle: DocumentLifecycle = LIFECYCLES.has(input.documentStatus)
    ? (input.documentStatus as DocumentLifecycle)
    : "ISSUED";

  // Adjustment display — SST-inclusive note totals; charge-backed notes only (caller-filtered).
  let debitNoteCents = 0;
  let creditNoteCents = 0;
  for (const n of input.activeNotes) {
    if (n.docType === "debit_note") debitNoteCents += Math.max(0, n.amountCents);
    else if (n.docType === "credit_note") creditNoteCents += Math.max(0, n.amountCents);
  }
  const adjustedCents = Math.max(0, input.originalTotalCents + debitNoteCents - creditNoteCents);

  // Payment axis. FULLY_CREDITED ⟺ active charge-backed credit notes net the bill to zero (adjusted 0)
  // — NOT the legacy `offset` flag (set on the whole doc when ANY one charge is credited, so a
  // partially-credited grouped invoice is `offset` yet still owes). Otherwise reuse the SST-exclusive
  // settlementStatus (the basis payments settle); never recompute from the SST-inclusive total.
  let paymentStatus: DerivedPaymentStatus;
  if (adjustedCents === 0 && creditNoteCents > 0) paymentStatus = "FULLY_CREDITED";
  else if (SETTLEMENT_VALUES.has(input.settlementStatus))
    paymentStatus = input.settlementStatus as DerivedPaymentStatus;
  else paymentStatus = "UNPAID";

  let adjustmentStatus: AdjustmentStatus;
  if (paymentStatus === "FULLY_CREDITED") adjustmentStatus = "FULLY_CREDITED";
  else if (debitNoteCents > 0 && creditNoteCents > 0) adjustmentStatus = "CREDIT_AND_DEBIT_NOTES_ISSUED";
  else if (creditNoteCents > 0) adjustmentStatus = "CREDIT_NOTE_ISSUED";
  else if (debitNoteCents > 0) adjustmentStatus = "DEBIT_NOTE_ISSUED";
  else adjustmentStatus = "NONE";

  return { lifecycle, paymentStatus, adjustmentStatus, debitNoteCents, creditNoteCents, adjustedCents };
}
