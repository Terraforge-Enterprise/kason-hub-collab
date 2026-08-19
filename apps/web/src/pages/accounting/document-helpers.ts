// Pure presentation helpers for the accounting Documents register. Kept in a
// .ts (no components) so react-refresh stays happy — mirrors format.ts. Consumed
// by document-shared.tsx (table) and document-detail-drawer.tsx.
import type { BillingDocType, BillingDocumentListItem } from "@kason/shared";
import { formatRM } from "@/components/format";

export type PillTone = "slate" | "sky" | "emerald" | "amber" | "rose";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-07-01" (first-of-month ISO date) → "Jul 2026". Null-safe. */
export function formatBillingMonth(iso?: string | null): string {
  if (!iso) return "—";
  const [y, m] = iso.split("-");
  const mi = Number(m) - 1;
  return MONTHS[mi] ? `${MONTHS[mi]} ${y}` : iso;
}

/** docType → human label. Falls back to the raw value for unknown types. */
export function docTypeLabel(docType: string): string {
  switch (docType) {
    case "invoice":
      return "Invoice";
    case "receipt":
      return "Receipt";
    case "debit_note":
      return "Debit Note";
    case "credit_note":
      return "Credit Note";
    case "refund_note":
      return "Refund Note";
    case "owner_expense_advice":
      return "Owner Expense Advice";
    case "proforma":
      return "Proforma Invoice";
    default:
      return docType;
  }
}

/** Series-prefix → customer-facing KIND label, for the series whose customer identity
 * differs from their internal docType. RB docs (+ legacy IVREN; internal docType debit_note/invoice)
 * read "Rental Bill"; EB docs (internal docType "invoice" — a tenant expense RECOVERY, NOT
 * KAEN service revenue) read "Expense Bill" and must never read "Invoice" (redesign P2/P4).
 * Matched on the series segment before the first "-", so "RBX-"/"IVRENX-"/"EBX-" do NOT match. */
const SERIES_KIND_LABEL: Record<string, string> = {
  RB: "Rental Bill",
  IVREN: "Rental Bill", // legacy alias: pre-rename docs keep their immutable IVREN- numbers → still "Rental Bill"
  EB: "Expense Bill",
  OEA: "Owner Expense Advice",
  // Move-in deposits (DEPO series, internal docType debit_note). Kept off the shared
  // DEP series so this label cannot leak onto utility/aircond debit notes.
  DEPO: "Rental Deposits",
};

/** Customer-facing document KIND label. A series with its own identity (SERIES_KIND_LABEL)
 * wins over the internal docType; every other doc falls back to docTypeLabel. */
export function documentKindLabel(docType: string, documentNumber?: string | null): string {
  const seriesPrefix = documentNumber ? documentNumber.split("-", 1)[0] : undefined;
  if (seriesPrefix && SERIES_KIND_LABEL[seriesPrefix]) return SERIES_KIND_LABEL[seriesPrefix];
  return docTypeLabel(docType);
}

export type Pill = { label: string; tone: PillTone };

/**
 * The status pills for a document — a PRIMARY badge (document lifecycle dominates,
 * else the derived payment state) plus an OPTIONAL SECONDARY adjustment badge when
 * active credit/debit notes exist. Reads the derived axes (`derivedPaymentStatus` /
 * `adjustmentStatus` / `isReBilled`); a legacy payload lacking them falls back to the
 * persisted `settlementStatus` for the primary and shows no secondary. Never throws.
 *
 * Labels ("B"): full-credit → "Closed · Fully credited"; re-Billed original →
 * "Voided · Re-Billed"; plain void → "Voided".
 */
export function statusMeta(
  d: Pick<BillingDocumentListItem, "docType" | "documentStatus" | "settlementStatus"> &
    Partial<Pick<BillingDocumentListItem, "derivedPaymentStatus" | "adjustmentStatus" | "isReBilled">>,
): { primary: Pill; secondary?: Pill } {
  // Lifecycle dominates the primary badge.
  if (d.documentStatus === "DRAFT") return { primary: { label: "Draft", tone: "amber" } };
  if (d.documentStatus === "SUPERSEDED") return { primary: { label: "Voided · Re-Billed", tone: "slate" } };
  if (d.documentStatus === "CANCELLED")
    return {
      primary: d.isReBilled
        ? { label: "Voided · Re-Billed", tone: "slate" }
        : { label: "Voided", tone: "rose" },
    };
  if (d.docType === "receipt") return { primary: { label: "Received", tone: "emerald" } };
  // A proforma carries no settlement of its own (isNonReceivableDocType), so the paid/
  // unpaid pills below would read "Unpaid" forever on a request that has been fully
  // graduated. It states what it IS instead.
  if (d.docType === "proforma") return { primary: { label: "Provisional", tone: "amber" } };
  // OEA records money already DEDUCTED from the owner's payout — it has no payment axis,
  // so it must never read "Unpaid" (which would imply the owner still owes it).
  if (d.docType === "owner_expense_advice") return { primary: { label: "Deducted", tone: "slate" } };

  // Payment axis — derived; fall back to the persisted settlementStatus on a legacy payload.
  const pay = d.derivedPaymentStatus ?? d.settlementStatus;
  const primary: Pill =
    pay === "FULLY_CREDITED"
      ? { label: "Closed · Fully credited", tone: "slate" }
      : pay === "PAID"
        ? { label: "Paid", tone: "emerald" }
        : pay === "PARTIALLY_PAID"
          ? { label: "Part-paid", tone: "amber" }
          : pay === "OVERPAID"
            ? { label: "Overpaid", tone: "sky" }
            : pay === "UNPAID"
              ? { label: "Unpaid", tone: "amber" }
              : { label: "Issued", tone: "slate" };

  // Secondary adjustment badge — skipped when fully credited (already the primary) and
  // on a legacy payload with no adjustmentStatus.
  let secondary: Pill | undefined;
  switch (d.adjustmentStatus) {
    case "CREDIT_NOTE_ISSUED":
      secondary = { label: "Credit note issued", tone: "sky" };
      break;
    case "DEBIT_NOTE_ISSUED":
      secondary = { label: "Debit note issued", tone: "amber" };
      break;
    case "CREDIT_AND_DEBIT_NOTES_ISSUED":
      secondary = { label: "CN + DN issued", tone: "amber" };
      break;
    default:
      secondary = undefined; // NONE / FULLY_CREDITED / undefined
  }

  return secondary ? { primary, secondary } : { primary };
}

// ── Line-level adjustment display (spec §7-A3 — server strings only, never
// client-computed) ───────────────────────────────────────────────────────────

export type AdjustmentTone = "credit" | "debit" | "neutral";

/**
 * Format an already-server-derived signed money string (e.g. a line's
 * `netAdjustmentAmount`, which may be negative) as "+RM50.00" / "−RM23.00"
 * (U+2212 minus, not a hyphen) with a tone for the caller to color. This is a
 * DISPLAY transform of one field (sign + magnitude split for formatting) — it
 * never sums or derives a new value from other fields.
 */
export function formatSignedRM(amount: string | number): { text: string; tone: AdjustmentTone } {
  const n = typeof amount === "number" ? amount : Number(amount);
  if (!Number.isFinite(n) || n === 0) return { text: formatRM(0), tone: "neutral" };
  const sign = n > 0 ? "+" : "−";
  return { text: `${sign}${formatRM(Math.abs(n))}`, tone: n > 0 ? "debit" : "credit" };
}

/**
 * Format one `adjustments[]` entry (a single note's prorated cents against this
 * line) with the SAME sign convention used everywhere else in this drawer for
 * face amounts: a debit note is an addition (+), a credit note is a reduction
 * (−). `amountCents` itself is an unsigned magnitude from the server; only the
 * display sign is derived from `docType`, mirroring the existing
 * "− {creditNoteTotal}" convention in the totals block.
 */
export function formatSignedNoteAmount(docType: "credit_note" | "debit_note", amountCents: number): string {
  const sign = docType === "credit_note" ? "−" : "+";
  return `${sign}${formatRM(amountCents / 100)}`;
}

/** Tailwind classes for an adjustment tone — used by both the line-items table
 * (net amount) and the adjustments register (note amount). Never color-only:
 * callers always render the signed text alongside these classes. */
export function adjustmentToneClass(tone: AdjustmentTone): string {
  switch (tone) {
    case "credit":
      return "text-emerald-700 dark:text-emerald-400";
    case "debit":
      return "text-amber-700 dark:text-amber-400";
    default:
      return "text-muted-foreground";
  }
}

/** "issued" / "partially_settled" → "Issued" / "Partially settled". Used for the
 * legacy `BillingDocumentStatus` string carried on `relatedDocuments[]`, which
 * has no derived-badge axes of its own (no documentStatus/adjustmentStatus). */
export function humanizeStatus(status: string): string {
  const spaced = status.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// ── Register doc-type facets (Phase 1.6, spec D3) ───────────────────────────

/**
 * A mixed (All-documents) register row's own FACE amount, signed by docType
 * convention — a credit note is a deduction (−), a debit note is an addition
 * (+). Distinct from `formatSignedRM` (which signs an ALREADY-signed
 * server-derived delta): `BillingDocumentListItem.total` is always a positive
 * face amount, so the sign here is a pure display convention keyed on
 * `docType`, never derived from the number's own sign (D3: "no summed
 * footer; rows are non-additive" — this never sums anything, it only
 * annotates one document's own total). Callers MUST also render the docType
 * text alongside this (never color/sign-only — D3 + accessibility).
 */
export function signedFaceAmount(docType: BillingDocType, total: string): { text: string; tone: AdjustmentTone } {
  if (docType === "credit_note") return { text: `−${formatRM(Number(total))}`, tone: "credit" };
  if (docType === "debit_note") return { text: `+${formatRM(Number(total))}`, tone: "debit" };
  return { text: formatRM(Number(total)), tone: "neutral" };
}

/**
 * What to show in the drawer header's "Unit" field.
 *
 * A COMBINED owner statement (IVOWN) has apartmentId NULL — it deliberately
 * spans every unit the owner holds — so the document-level `unitCode` is null
 * and the header used to render a bare "—". True, but useless: it says nothing
 * about a document that actually covers three units. The LINES know, because
 * each carries its own `unitCode`, so answer from them:
 *
 *   one distinct unit  → name it ("A-01-01")
 *   several            → count them ("3 units"), and the per-line labels in the
 *                        line-items table say which
 *   none               → fall back to the document-level unit, else "—"
 */
export function summariseDocumentUnits(
  docUnitCode: string | null,
  lines: { unitCode: string | null }[],
): string {
  const distinct = [...new Set(lines.map((l) => l.unitCode).filter((u): u is string => !!u))];
  if (distinct.length === 1) return distinct[0];
  if (distinct.length > 1) return `${distinct.length} units`;
  return docUnitCode ?? "—";
}
