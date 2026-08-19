// Static mock fixtures for the invoice-adjustments design preview
// (docs/superpowers/plans/2026-07-20-invoice-adjustments.md, PHASE PREVIEW).
//
// The canonical scenario (spec D6 / §6): IVTEN-0002, BONG HONG YI, Kensho
// Residence 10-03. Electricity RM400 + Water RM123 (invoice total RM523,
// already fully paid). CNTEN-0001 −RM23 against Water. DNTEN-0001 +RM50
// against Electricity. Final: adjusted RM550, paid RM523, balance RM27.
//
// Every value here conforms to the REAL DTO shapes in
// packages/shared/src/schemas/billing-documents.ts so the actual production
// components (DocumentsTable, DocumentDetailDrawer, LineItemsTab, PaymentsTab,
// AdjustmentsTab, ActivityTab) render them unmodified — no preview-only
// component forks. A local QueryClient is seeded with these
// fixtures at the exact react-query cache keys the real hooks
// (useBillingDocument / useAuditTimeline) read, so the components never hit
// the network in this preview.
import type { QueryClient } from "@tanstack/react-query";
import type { BillingDocumentDetail, BillingDocumentListItem, BillingDocumentLineDto } from "@kason/shared";

const PARTY = {
  partyId: "party-bong-hong-yi",
  partyName: "BONG HONG YI",
  unitCode: "10-03",
  propertyName: "Kensho Residence",
  counterpartyType: "tenant" as const,
};

// ── Register-level documents (BillingDocumentListItem) ─────────────────────

/**
 * The FINAL canonical state — both notes issued. Used by the Line
 * items/Payments/Adjustments/Activity tab states (2-5): adjusted RM550, paid
 * RM523 (unchanged — no extra cash collected), balance RM27.
 */
export const INVOICE_FINAL: BillingDocumentListItem = {
  id: "doc-ivten-0002",
  docType: "invoice",
  documentNumber: "IVTEN-0002",
  seriesCode: "IVTEN",
  status: "partially_settled",
  documentStatus: "ISSUED",
  taxStatus: "NOT_REQUIRED",
  settlementStatus: "PARTIALLY_PAID",
  derivedPaymentStatus: "PARTIALLY_PAID",
  adjustmentStatus: "CREDIT_AND_DEBIT_NOTES_ISSUED",
  isReBilled: false,
  adjustedTotal: "550.00",
  pendingVerificationCount: 0,
  issuedAt: "2026-07-01T09:00:00.000Z",
  billingMonth: "2026-07-01",
  ...PARTY,
  total: "523.00",
  originalDocumentNumber: null,
  paymentId: null,
};

/**
 * Intermediate snapshot — DN issued, CN NOT yet issued (state 10, "paid →
 * outstanding after a DN"). Original 523 was fully paid; the +50 DN reopens a
 * balance the tenant now owes.
 */
export const INVOICE_DN_ONLY: BillingDocumentListItem = {
  ...INVOICE_FINAL,
  id: "doc-ivten-0002-dn-only",
  adjustmentStatus: "DEBIT_NOTE_ISSUED",
  adjustedTotal: "573.00",
  pendingVerificationCount: 0,
};

/**
 * Intermediate snapshot — CN issued, DN NOT yet issued (state 11, "paid →
 * credit balance after a CN"). Original 523 was fully paid; the −23 CN makes
 * the invoice OVERPAID by RM23 (a credit balance), never a negative charge
 * balance (spec invariant).
 */
export const INVOICE_CN_ONLY: BillingDocumentListItem = {
  ...INVOICE_FINAL,
  id: "doc-ivten-0002-cn-only",
  status: "settled",
  settlementStatus: "OVERPAID",
  derivedPaymentStatus: "OVERPAID",
  adjustmentStatus: "CREDIT_NOTE_ISSUED",
  adjustedTotal: "500.00",
  pendingVerificationCount: 0,
};

export const CN_NOTE: BillingDocumentListItem = {
  id: "doc-cnten-0001",
  docType: "credit_note",
  documentNumber: "CNTEN-0001",
  seriesCode: "CNTEN",
  status: "issued",
  documentStatus: "ISSUED",
  taxStatus: "NOT_REQUIRED",
  settlementStatus: "UNPAID",
  derivedPaymentStatus: "UNPAID",
  adjustmentStatus: "NONE",
  isReBilled: false,
  adjustedTotal: "23.00",
  pendingVerificationCount: 0,
  issuedAt: "2026-07-05T10:00:00.000Z",
  billingMonth: "2026-07-01",
  ...PARTY,
  total: "23.00",
  originalDocumentNumber: "IVTEN-0002",
  paymentId: null,
};

export const DN_NOTE: BillingDocumentListItem = {
  id: "doc-dnten-0001",
  docType: "debit_note",
  documentNumber: "DNTEN-0001",
  seriesCode: "DNTEN",
  status: "issued",
  documentStatus: "ISSUED",
  taxStatus: "NOT_REQUIRED",
  settlementStatus: "UNPAID",
  derivedPaymentStatus: "UNPAID",
  adjustmentStatus: "NONE",
  isReBilled: false,
  adjustedTotal: "50.00",
  pendingVerificationCount: 0,
  issuedAt: "2026-07-08T11:00:00.000Z",
  billingMonth: "2026-07-01",
  ...PARTY,
  total: "50.00",
  originalDocumentNumber: "IVTEN-0002",
  paymentId: null,
};

/** A plain receipt row, for register variety (state 1's mixed register). */
export const RECEIPT_ITEM: BillingDocumentListItem = {
  id: "doc-rcten-0004",
  docType: "receipt",
  documentNumber: "RCTEN-0004",
  seriesCode: "RCTEN",
  status: "settled",
  documentStatus: "ISSUED",
  taxStatus: "NOT_REQUIRED",
  settlementStatus: "PAID",
  derivedPaymentStatus: "PAID",
  adjustmentStatus: "NONE",
  isReBilled: false,
  adjustedTotal: "523.00",
  pendingVerificationCount: 0,
  issuedAt: "2026-07-02T14:05:00.000Z",
  billingMonth: "2026-07-01",
  ...PARTY,
  total: "523.00",
  originalDocumentNumber: null,
  paymentId: "payment-1",
};

/** Newest-first, as the real register returns. */
export const REGISTER_ITEMS: BillingDocumentListItem[] = [DN_NOTE, CN_NOTE, RECEIPT_ITEM, INVOICE_FINAL];

// ── Line items (BillingDocumentLineDto) ─────────────────────────────────────

function line(overrides: Partial<BillingDocumentLineDto> & Pick<BillingDocumentLineDto, "id" | "description">): BillingDocumentLineDto {
  return {
    chargeId: null,
    amount: "0.00",
    sstRate: "0",
    sstAmount: "0.00",
    categoryName: "Utilities",
    unitCode: null,
    paid: "0.00",
    outstanding: "0.00",
    originalAmount: "0.00",
    debitAdjustmentAmount: "0.00",
    creditAdjustmentAmount: "0.00",
    netAdjustmentAmount: "0.00",
    adjustedAmount: "0.00",
    adjustedSstAmount: "0.00",
    allocationBasis: "exact",
    adjustments: [],
    attachments: [],
    isTax: false,
    taxParentChargeId: null,
    ...overrides,
  };
}

// FINAL state lines — both notes applied. NOTE (documented, not a bug): the
// per-line `outstanding` (Electricity 50.00 + Water 0.00 clamped = 50.00) does
// NOT sum to the document-level `balance` (27.00) below. `outstanding` is a
// per-CHARGE figure clamped ≥0 for display (Water's charge is overpaid by the
// CN but a charge balance can never go negative); `balance` is the
// DOCUMENT-level net (adjusted 550 − paid 523 = 27) computed BEFORE that
// per-charge clamp. Both are correct at their own granularity — see the UX
// doc's "status behaviour" section.
const ELECTRICITY_LINE_FINAL = line({
  id: "line-electricity",
  chargeId: "charge-electricity",
  description: "Electricity",
  amount: "400.00",
  paid: "400.00",
  outstanding: "50.00",
  originalAmount: "400.00",
  debitAdjustmentAmount: "50.00",
  netAdjustmentAmount: "50.00",
  adjustedAmount: "450.00",
  adjustments: [{ noteId: DN_NOTE.id, docType: "debit_note", documentNumber: DN_NOTE.documentNumber, amountCents: 5000 }],
});
const WATER_LINE_FINAL = line({
  id: "line-water",
  chargeId: "charge-water",
  description: "Water",
  amount: "123.00",
  paid: "123.00",
  outstanding: "0.00",
  originalAmount: "123.00",
  creditAdjustmentAmount: "23.00",
  netAdjustmentAmount: "-23.00",
  adjustedAmount: "100.00",
  adjustments: [{ noteId: CN_NOTE.id, docType: "credit_note", documentNumber: CN_NOTE.documentNumber, amountCents: 2300 }],
});

const ELECTRICITY_LINE_DN_ONLY = line({ ...ELECTRICITY_LINE_FINAL });
const WATER_LINE_UNCHANGED_A = line({
  id: "line-water",
  chargeId: "charge-water",
  description: "Water",
  amount: "123.00",
  paid: "123.00",
  outstanding: "0.00",
  originalAmount: "123.00",
  adjustedAmount: "123.00",
});

const ELECTRICITY_LINE_UNCHANGED_B = line({
  id: "line-electricity",
  chargeId: "charge-electricity",
  description: "Electricity",
  amount: "400.00",
  paid: "400.00",
  outstanding: "0.00",
  originalAmount: "400.00",
  adjustedAmount: "400.00",
});
const WATER_LINE_CN_ONLY = line({ ...WATER_LINE_FINAL });

const CN_LINE = line({
  id: "line-cn-water",
  chargeId: "charge-water",
  description: "Water — correction",
  amount: "23.00",
  categoryName: "Utilities",
  originalAmount: "23.00",
  adjustedAmount: "23.00",
});

const DN_LINE = line({
  id: "line-dn-electricity",
  chargeId: "charge-electricity",
  description: "Electricity — correction",
  amount: "50.00",
  categoryName: "Utilities",
  outstanding: "50.00",
  originalAmount: "50.00",
  adjustedAmount: "50.00",
});

// ── Detail DTOs (BillingDocumentDetail) ─────────────────────────────────────

const RELATED_CN = { id: CN_NOTE.id, docType: CN_NOTE.docType, documentNumber: CN_NOTE.documentNumber, status: "issued" as const };
const RELATED_DN = { id: DN_NOTE.id, docType: DN_NOTE.docType, documentNumber: DN_NOTE.documentNumber, status: "issued" as const };
const RELATED_INVOICE = { id: INVOICE_FINAL.id, docType: INVOICE_FINAL.docType, documentNumber: INVOICE_FINAL.documentNumber, status: "partially_settled" as const };

export const INVOICE_FINAL_DETAIL: BillingDocumentDetail = {
  ...INVOICE_FINAL,
  subtotal: "523.00",
  sstAmount: "0.00",
  creditAmount: null,
  debitNoteTotal: "50.00",
  creditNoteTotal: "23.00",
  amountPaid: "523.00",
  balance: "27.00",
  reason: null,
  statementInvoiceId: null,
  hasPdf: true,
  lines: [ELECTRICITY_LINE_FINAL, WATER_LINE_FINAL],
  relatedDocuments: [RELATED_CN, RELATED_DN],
};

export const INVOICE_DN_ONLY_DETAIL: BillingDocumentDetail = {
  ...INVOICE_DN_ONLY,
  subtotal: "523.00",
  sstAmount: "0.00",
  creditAmount: null,
  debitNoteTotal: "50.00",
  creditNoteTotal: "0.00",
  amountPaid: "523.00",
  balance: "50.00",
  reason: null,
  statementInvoiceId: null,
  hasPdf: true,
  lines: [ELECTRICITY_LINE_DN_ONLY, WATER_LINE_UNCHANGED_A],
  relatedDocuments: [RELATED_DN],
};

export const INVOICE_CN_ONLY_DETAIL: BillingDocumentDetail = {
  ...INVOICE_CN_ONLY,
  subtotal: "523.00",
  sstAmount: "0.00",
  creditAmount: null,
  debitNoteTotal: "0.00",
  creditNoteTotal: "23.00",
  amountPaid: "523.00",
  balance: "0.00",
  reason: null,
  statementInvoiceId: null,
  hasPdf: true,
  lines: [ELECTRICITY_LINE_UNCHANGED_B, WATER_LINE_CN_ONLY],
  relatedDocuments: [RELATED_CN],
};

export const CN_NOTE_DETAIL: BillingDocumentDetail = {
  ...CN_NOTE,
  subtotal: "23.00",
  sstAmount: "0.00",
  creditAmount: null,
  debitNoteTotal: "0.00",
  creditNoteTotal: "0.00",
  amountPaid: "0.00",
  balance: "0.00",
  reason: "Water meter over-read in June — corrected per manual re-read on 5 Jul.",
  statementInvoiceId: null,
  hasPdf: true,
  lines: [CN_LINE],
  relatedDocuments: [RELATED_INVOICE],
};

export const DN_NOTE_DETAIL: BillingDocumentDetail = {
  ...DN_NOTE,
  subtotal: "50.00",
  sstAmount: "0.00",
  creditAmount: null,
  debitNoteTotal: "0.00",
  creditNoteTotal: "0.00",
  amountPaid: "0.00",
  balance: "50.00",
  reason: "Electricity consumption under-billed for June — additional units confirmed via TNB statement.",
  statementInvoiceId: null,
  hasPdf: true,
  lines: [DN_LINE],
  relatedDocuments: [RELATED_INVOICE],
};

// ── Audit timeline (Activity tab, spec §7-A9) ───────────────────────────────
// Each entry is keyed against the OWNING document's entityId — a CN/DN-issued
// event lives on the note's own id, not the invoice's, exactly as the real
// audit log records it (credit-notes.service.ts `entityId: cn.id`).

type AuditRow = {
  id: string;
  actorUserId: string;
  actorName: string | null;
  actorRole: string;
  action: string;
  entityType: string;
  entityId: string;
  entityName: string | null;
  createdAt: string;
};

const AUDIT_BY_ENTITY: Record<string, AuditRow[]> = {
  [INVOICE_FINAL.id]: [
    {
      id: "audit-invoice-issued",
      actorUserId: "user-sarah",
      actorName: "Sarah (Manager)",
      actorRole: "manager",
      action: "Invoice issued",
      entityType: "BillingDocument",
      entityId: INVOICE_FINAL.id,
      entityName: INVOICE_FINAL.documentNumber,
      createdAt: "2026-07-01T09:00:00.000Z",
    },
    {
      id: "audit-payment-recorded",
      actorUserId: "user-sarah",
      actorName: "Sarah (Manager)",
      actorRole: "manager",
      action: "Payment recorded — RM523.00",
      entityType: "BillingDocument",
      entityId: INVOICE_FINAL.id,
      entityName: INVOICE_FINAL.documentNumber,
      createdAt: "2026-07-02T14:05:00.000Z",
    },
  ],
  [CN_NOTE.id]: [
    {
      id: "audit-cn-issued",
      actorUserId: "user-sarah",
      actorName: "Sarah (Manager)",
      actorRole: "manager",
      action: "Credit note issued — RM23.00 against Water",
      entityType: "BillingDocument",
      entityId: CN_NOTE.id,
      entityName: CN_NOTE.documentNumber,
      createdAt: "2026-07-05T10:00:00.000Z",
    },
  ],
  [DN_NOTE.id]: [
    {
      id: "audit-dn-issued",
      actorUserId: "user-sarah",
      actorName: "Sarah (Manager)",
      actorRole: "manager",
      action: "Debit note issued — RM50.00 against Electricity",
      entityType: "BillingDocument",
      entityId: DN_NOTE.id,
      entityName: DN_NOTE.documentNumber,
      createdAt: "2026-07-08T11:00:00.000Z",
    },
  ],
};

// ── Seeding ──────────────────────────────────────────────────────────────

/**
 * Seeds a react-query QueryClient with every fixture at the EXACT cache keys
 * the real hooks read (`useBillingDocument`, `useAuditTimeline` — see
 * apps/web/src/api/billing-documents.ts and apps/web/src/api/audit-log.ts).
 * Paired with `staleTime: Infinity` + `retry: false` on that client (set by
 * the caller), this means the unmodified production components render from
 * these fixtures without ever calling the network.
 */
export function seedPreviewQueryClient(qc: QueryClient): void {
  const details: BillingDocumentDetail[] = [
    INVOICE_FINAL_DETAIL,
    INVOICE_DN_ONLY_DETAIL,
    INVOICE_CN_ONLY_DETAIL,
    CN_NOTE_DETAIL,
    DN_NOTE_DETAIL,
  ];
  for (const detail of details) {
    qc.setQueryData(["billing-documents", "detail", detail.id], { data: detail });
  }
  for (const [entityId, rows] of Object.entries(AUDIT_BY_ENTITY)) {
    qc.setQueryData(["audit-log", "entity", entityId], { rows, total: rows.length, page: 1, pageSize: 50 });
  }
}
