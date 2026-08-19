// Read-time derivation of a billing document's badges (lifecycle / payment / adjustment)
// for the register list AND the detail drawer, so both surfaces show identical badges (R11).
//
// Payment status is REUSED from the persisted, SST-EXCLUSIVE settlement (legacyStatus +
// settlementStatus) — the basis payments actually settle — never re-derived from the
// SST-inclusive document total. The ADJUSTMENT display counts only ACTIVE, CHARGE-BACKED
// notes (overpayment credit notes, whose lines settle no charge, are credit owed to the
// payer, not a reduction of the bill, so they are excluded).
//
// Two layers:
//  • computeBadgesForDocs — PURE grouping / active + charge-backed filtering → deriveDocumentBadges.
//  • deriveForDocs — thin Prisma plumbing that fetches the linked CN/DN the pure layer needs.
import { getDb } from "@kason/db";
import { deriveDocumentBadges, isActiveAdjustmentNote, toCents, type ActiveNote, type DerivedBadges } from "@kason/shared";

export type DocBadge = DerivedBadges & { isReBilled: boolean };

export type ComputeBadgesInput = {
  docs: {
    id: string;
    documentStatus: string;
    supersededByDocumentId: string | null;
    /** Persisted settlementStatus (UNPAID|PARTIALLY_PAID|PAID|OVERPAID). */
    settlementStatus: string;
    /** Document total in cents (SST-inclusive). */
    totalCents: number;
  }[];
  /** ALL linked CN/DN (any lifecycle). This fn drops non-ISSUED (canonical predicate) and non-charge-backed notes. */
  notes: {
    originalDocumentId: string;
    docType: string;
    documentStatus: string;
    /** Note total in cents (SST-inclusive) — the display basis. */
    totalCents: number;
    /** True when the note has ≥1 line settling a real charge (false ⟺ an overpayment CN). */
    isChargeBacked: boolean;
  }[];
};

/**
 * PURE assembly: per document, collect its ACTIVE, CHARGE-BACKED adjustment notes and derive
 * its badges. Overpayment (charge-less) CNs and non-ISSUED notes (canonical predicate) are excluded.
 */
export function computeBadgesForDocs(input: ComputeBadgesInput): Map<string, DocBadge> {
  const notesByDoc = new Map<string, ActiveNote[]>();
  for (const n of input.notes) {
    if (n.docType !== "credit_note" && n.docType !== "debit_note") continue;
    if (!isActiveAdjustmentNote(n.documentStatus)) continue; // canonical predicate (ISSUED-only)
    if (!n.isChargeBacked) continue; // overpayment CN → credit owed to payer, not a bill reduction
    const arr = notesByDoc.get(n.originalDocumentId) ?? [];
    arr.push({ docType: n.docType, amountCents: n.totalCents });
    notesByDoc.set(n.originalDocumentId, arr);
  }

  const out = new Map<string, DocBadge>();
  for (const d of input.docs) {
    const isReBilled = d.supersededByDocumentId != null;
    const badges = deriveDocumentBadges({
      documentStatus: d.documentStatus,
      isReBilled,
      settlementStatus: d.settlementStatus,
      originalTotalCents: d.totalCents,
      activeNotes: notesByDoc.get(d.id) ?? [],
    });
    out.set(d.id, { ...badges, isReBilled });
  }
  return out;
}

/** Structural view of a BillingDocument row this derivation needs (list or detail). */
type DeriveDocRow = {
  id: string;
  documentStatus: string;
  supersededByDocumentId: string | null;
  /** BillingDocument.settlementStatus (persisted, SST-exclusive). */
  settlementStatus: string;
  total: { toString(): string };
};

/**
 * Fetch the linked CN/DN `computeBadgesForDocs` needs for `docs` and derive per-doc badges.
 * Read-only, batched over the whole page (no N+1). Used by the list enrich() and the detail
 * read so both derive identically. Never 500s on a derivation edge (empty map → legacy display).
 */
export async function deriveForDocs(orgId: string, docs: DeriveDocRow[]): Promise<Map<string, DocBadge>> {
  if (docs.length === 0) return new Map();
  try {
    const db = getDb();
    const docIds = docs.map((d) => d.id);

    // ALL linked CN/DN with SST-inclusive totals + whether each is charge-backed (has a line
    // settling a real charge). Active filtering + overpayment exclusion happen in the pure layer.
    const noteRows = await db.billingDocument.findMany({
      where: { organizationId: orgId, originalDocumentId: { in: docIds }, docType: { in: ["credit_note", "debit_note"] } },
      select: {
        originalDocumentId: true,
        docType: true,
        documentStatus: true,
        total: true,
        lines: { select: { chargeId: true } },
      },
    });
    const notes = noteRows.map((n) => ({
      originalDocumentId: n.originalDocumentId as string,
      docType: n.docType,
      documentStatus: n.documentStatus,
      totalCents: toCents(n.total.toString(), "deriveForDocs.note"),
      isChargeBacked: n.lines.some((l) => l.chargeId !== null),
    }));

    return computeBadgesForDocs({
      docs: docs.map((d) => ({
        id: d.id,
        documentStatus: d.documentStatus,
        supersededByDocumentId: d.supersededByDocumentId,
        settlementStatus: d.settlementStatus,
        totalCents: toCents(d.total.toString(), "deriveForDocs.total"),
      })),
      notes,
    });
  } catch (e) {
    // A read path must never 500 on a derivation edge. Empty map → each doc falls back to
    // its legacy display (repository maps a missing badge to NONE + persisted settlementStatus).
    console.error("[billing-documents.derive] deriveForDocs failed (swallowed):", e);
    return new Map();
  }
}
