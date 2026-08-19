// apps/api/src/modules/billing-documents/repository.ts
// Read-side for the Documents register. BillingDocument keeps PLAIN columns
// (partyId/apartmentId/seriesId/originalDocumentId), so display fields are
// enriched via batched lookups instead of relations.

import { getDb, Prisma } from "@kason/db";
import { toCents, centsToString, ACTIVE_ADJUSTMENT_NOTE_STATUSES, formatLineUnitLabel, CASH_ALLOCATION_WHERE, AWAITING_VERIFICATION_WHERE } from "@kason/shared";
import { isPhase2FlagEnabled } from "../../lib/feature-flags";
import type {
  BillingDocumentDetail,
  BillingDocumentLineDto,
  BillingDocumentListItem,
  ListBillingDocumentsQuery,
} from "@kason/shared";
import { sumReversalsForAllocations } from "../payments/payments.repository";
import { deriveForDocs, type DocBadge } from "./derive-for-docs";

function money(v: { toString(): string }): string {
  const n = parseFloat(v.toString());
  return Number.isNaN(n) ? "0.00" : n.toFixed(2);
}

/**
 * Split a charge-level cents figure (paid or outstanding) across that charge's
 * document lines, weighted by each line's amount, so the per-line parts sum EXACTLY
 * back to the total. Rounding residual goes to the largest-weight lines first
 * (deterministic). Exact for a 1:1 line↔charge invoice (one line gets the whole
 * figure); a fair split for a pooled charge itemised across several lines (meter
 * path). Non-positive weights (e.g. a negative subsidy line) take 0.
 */
function prorateAcrossLines(totalCents: number, weightsCents: number[]): number[] {
  const n = weightsCents.length;
  if (n === 0) return [];
  const total = Math.max(0, totalCents);
  const weights = weightsCents.map((w) => Math.max(0, w));
  const weightSum = weights.reduce((s, w) => s + w, 0);
  if (weightSum <= 0) return weightsCents.map((_, i) => (i === 0 ? total : 0));
  const out = weights.map((w) => Math.floor((total * w) / weightSum));
  let residual = total - out.reduce((s, v) => s + v, 0);
  const order = weights.map((w, i) => [w, i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; residual > 0; k += 1, residual -= 1) out[order[k % n][1]] += 1;
  return out;
}

export async function buildWhere(orgId: string, q: ListBillingDocumentsQuery): Promise<Prisma.BillingDocumentWhereInput> {
  const where: Prisma.BillingDocumentWhereInput = { organizationId: orgId };
  // Multi-docType (CSV) supersedes the single docType — the Invoices register uses it
  // to span invoice + debit_note (rent/utility bills routed to DEP are still bills owed).
  if (q.docTypes && q.docTypes.length > 0) where.docType = { in: q.docTypes };
  else if (q.docType) where.docType = q.docType;
  // Primary-bill scoping (register opt-in). originalDocumentId IS NULL excludes
  // correction/adjustment notes (e.g. DEBIT_ADJUSTMENT debit notes that reuse a
  // parent invoice's charge — "Correct"ing one would void the whole parent
  // receivable). Replacement invoices keep originalDocumentId null, so they stay.
  if (q.primaryOnly) where.originalDocumentId = null;
  // Live-bills scoping (register opt-in). Drop dead docs (re-Bill supersessions /
  // cancellations) whose stale legacy `status` would otherwise render inert
  // Record-payment / Correct affordances.
  if (q.activeOnly) where.documentStatus = { notIn: ["CANCELLED", "SUPERSEDED"] };
  if (q.seriesId) where.seriesId = q.seriesId;
  if (q.partyId) where.partyId = q.partyId;
  if (q.apartmentId) where.apartmentId = q.apartmentId;
  if (q.status) where.status = q.status;
  if (q.counterpartyType) where.counterpartyType = q.counterpartyType;
  if (q.propertyId) where.propertyId = q.propertyId;
  if (q.month) where.billingMonth = new Date(`${q.month}-01T00:00:00.000Z`);
  // Issued-date range (inclusive). dateTo covers the whole day.
  if (q.dateFrom || q.dateTo) {
    where.issuedAt = {
      ...(q.dateFrom ? { gte: new Date(`${q.dateFrom}T00:00:00.000Z`) } : {}),
      ...(q.dateTo ? { lte: new Date(`${q.dateTo}T23:59:59.999Z`) } : {}),
    };
  }
  if (q.q) {
    // Search matches a party by display name OR phone — so an admin can find a
    // document by the tenant/owner's phone number, not just their name. getDb() is
    // resolved lazily HERE (not at function entry) so the pure where-shape branches
    // above are unit-testable without a DATABASE_URL / live client.
    const db = getDb();
    const parties = await db.party.findMany({
      where: {
        organizationId: orgId,
        OR: [
          { displayName: { contains: q.q, mode: "insensitive" } },
          { primaryPhone: { contains: q.q, mode: "insensitive" } },
        ],
      },
      select: { id: true },
      take: 200,
    });
    where.OR = [
      { documentNumber: { contains: q.q, mode: "insensitive" } },
      { partyId: { in: parties.map((p) => p.id) } },
    ];
  }
  return where;
}

async function enrich(orgId: string, rows: {
  id: string; docType: string; documentNumber: string; seriesId: string; status: string;
  documentStatus: string; settlementStatus: string; taxStatus: string;
  issuedAt: Date; billingMonth: Date | null; counterpartyType: string; partyId: string;
  apartmentId: string | null; propertyId: string | null; total: Prisma.Decimal; originalDocumentId: string | null;
  paymentId: string | null; supersededByDocumentId: string | null;
}[], precomputedBadges?: Map<string, DocBadge>): Promise<BillingDocumentListItem[]> {
  const db = getDb();
  const partyIds = [...new Set(rows.map((r) => r.partyId))];
  const apartmentIds = [...new Set(rows.map((r) => r.apartmentId).filter((x): x is string => x !== null))];
  const seriesIds = [...new Set(rows.map((r) => r.seriesId))];
  const originalIds = [...new Set(rows.map((r) => r.originalDocumentId).filter((x): x is string => x !== null))];
  const [parties, apartments, series, originals] = await Promise.all([
    db.party.findMany({ where: { organizationId: orgId, id: { in: partyIds } }, select: { id: true, displayName: true } }),
    apartmentIds.length
      ? db.apartment.findMany({ where: { organizationId: orgId, id: { in: apartmentIds } }, select: { id: true, unitCode: true, propertyId: true } })
      : Promise.resolve([]),
    db.documentSeries.findMany({ where: { organizationId: orgId, id: { in: seriesIds } }, select: { id: true, code: true } }),
    originalIds.length
      ? db.billingDocument.findMany({ where: { organizationId: orgId, id: { in: originalIds } }, select: { id: true, documentNumber: true } })
      : Promise.resolve([]),
  ]);
  const partyName = new Map(parties.map((p) => [p.id, p.displayName]));
  const unitCode = new Map(apartments.map((a) => [a.id, a.unitCode]));
  const apartmentPropertyId = new Map(apartments.map((a) => [a.id, a.propertyId]));
  const seriesCode = new Map(series.map((s) => [s.id, s.code]));
  const originalNumber = new Map(originals.map((o) => [o.id, o.documentNumber]));

  // Property name — the "which building" a proper invoice header needs. Resolved
  // from the doc's own propertyId, else the linked unit's apartment→property. A
  // second batched lookup (apartments carry propertyId, not the name). Manual
  // invoices raised without a unit stay null.
  const resolvePropertyId = (r: { propertyId: string | null; apartmentId: string | null }): string | null =>
    r.propertyId ?? (r.apartmentId ? apartmentPropertyId.get(r.apartmentId) ?? null : null);
  const propertyIds = [...new Set(rows.map(resolvePropertyId).filter((x): x is string => x !== null))];
  const properties = propertyIds.length
    ? await db.property.findMany({ where: { organizationId: orgId, id: { in: propertyIds } }, select: { id: true, name: true } })
    : [];
  const propertyName = new Map(properties.map((p) => [p.id, p.name]));

  // Tenant-submitted payments still awaiting verification, per document — the
  // register's red dot. Two batched queries for the whole page (never per row).
  //
  // The link is document → its lines' charges → allocations → parent payment,
  // because a Payment has no documentId: a tenant pays CHARGES, and one
  // submitted transfer can span several documents. That also means a payment
  // legitimately badges more than one invoice — each is genuinely awaiting the
  // same decision.
  //
  // Counts DISTINCT paymentIds per document, so a single slip covering four
  // charges on one invoice shows "1", not "4".
  const pendingCountByDoc = new Map<string, number>();
  {
    // Cheapest discriminator FIRST: awaiting-verification payments are rare
    // (usually zero for a whole page), so this short-circuits before the wide
    // line fetch. Fetching every line for the page first — up to pageSize docs ×
    // N lines — and only then discovering there is nothing pending made the
    // common case pay for two wide queries.
    //
    // ⚠️ Do NOT justify this with Payment@@index([organizationId, status]).
    // Prisma emits the payment predicate as a relation subquery WITHOUT
    // organizationId (the org constraint sits on the allocation side), so that
    // composite index cannot be driven from its leading column. This read is
    // also org-wide and unbounded — no chargeId narrowing, no limit — so it
    // scales with the org's slip backlog rather than with page size. Fine while
    // the backlog is small (it is an exception queue someone is clearing), but
    // it is the thing to measure first if this page slows down.
    const pendingAllocs = await db.paymentAllocation.findMany({
      // Deliberately NOT CASH_ALLOCATION_WHERE — that filter means "money
      // arrived" (status posted). This is a different axis: claims awaiting a
      // human decision, which excludes in-flight FPX (see the fragment's docs).
      where: { organizationId: orgId, ...AWAITING_VERIFICATION_WHERE },
      select: { chargeId: true, paymentId: true },
    });
    if (pendingAllocs.length) {
      const pendingChargeIds = new Set(
        pendingAllocs.map((a) => a.chargeId).filter((x): x is string => x !== null),
      );
      const docLines = await db.billingDocumentLine.findMany({
        where: {
          documentId: { in: rows.map((r) => r.id) },
          chargeId: { in: [...pendingChargeIds] },
        },
        select: { documentId: true, chargeId: true },
      });
      if (docLines.length) {
        const paymentsByCharge = new Map<string, Set<string>>();
        for (const a of pendingAllocs) {
          if (!a.chargeId) continue;
          const set = paymentsByCharge.get(a.chargeId) ?? new Set<string>();
          set.add(a.paymentId);
          paymentsByCharge.set(a.chargeId, set);
        }
        const paymentsByDoc = new Map<string, Set<string>>();
        for (const l of docLines) {
          if (!l.chargeId) continue;
          const payments = paymentsByCharge.get(l.chargeId);
          if (!payments) continue;
          const set = paymentsByDoc.get(l.documentId) ?? new Set<string>();
          for (const p of payments) set.add(p);
          paymentsByDoc.set(l.documentId, set);
        }
        for (const [docId, set] of paymentsByDoc) pendingCountByDoc.set(docId, set.size);
      }
    }
  }

  // Read-time badge derivation (billing-document-status-model) — batched over the page,
  // so the register reflects linked CN/DN + payments (never the stale persisted status).
  const derived =
    precomputedBadges ??
    (await deriveForDocs(
      orgId,
      rows.map((r) => ({
        id: r.id,
        documentStatus: r.documentStatus,
        supersededByDocumentId: r.supersededByDocumentId,
        settlementStatus: r.settlementStatus,
        total: r.total,
      })),
    ));

  return rows.map((r) => {
    const resolvedPropertyId = resolvePropertyId(r);
    const b = derived.get(r.id);
    return {
      id: r.id,
      docType: r.docType as BillingDocumentListItem["docType"],
      documentNumber: r.documentNumber,
      seriesCode: seriesCode.get(r.seriesId) ?? "",
      status: r.status as BillingDocumentListItem["status"],
      documentStatus: r.documentStatus as BillingDocumentListItem["documentStatus"],
      taxStatus: r.taxStatus as BillingDocumentListItem["taxStatus"],
      settlementStatus: r.settlementStatus as BillingDocumentListItem["settlementStatus"],
      issuedAt: r.issuedAt.toISOString(),
      billingMonth: r.billingMonth ? r.billingMonth.toISOString().slice(0, 10) : null,
      counterpartyType: r.counterpartyType as "tenant" | "owner",
      partyId: r.partyId,
      partyName: partyName.get(r.partyId) ?? "—",
      unitCode: r.apartmentId ? (unitCode.get(r.apartmentId) ?? null) : null,
      propertyName: resolvedPropertyId ? (propertyName.get(resolvedPropertyId) ?? null) : null,
      total: money(r.total),
      originalDocumentNumber: r.originalDocumentId ? (originalNumber.get(r.originalDocumentId) ?? null) : null,
      // R9 (Task 12): expose the linked Payment id so the Receipts row can offer
      // "Void payment". Plain nullable column — no enrichment lookup needed.
      paymentId: r.paymentId,
      // Derived-on-read display axes. Fall back to the persisted settlementStatus only
      // if derivation is unexpectedly absent (never for a real row).
      derivedPaymentStatus: (b?.paymentStatus ??
        r.settlementStatus) as BillingDocumentListItem["derivedPaymentStatus"],
      adjustmentStatus: (b?.adjustmentStatus ?? "NONE") as BillingDocumentListItem["adjustmentStatus"],
      isReBilled: b?.isReBilled ?? r.supersededByDocumentId !== null,
      adjustedTotal: b ? centsToString(b.adjustedCents) : money(r.total),
      pendingVerificationCount: pendingCountByDoc.get(r.id) ?? 0,
    };
  });
}

const LIST_SELECT = {
  id: true, docType: true, documentNumber: true, seriesId: true, status: true,
  documentStatus: true, settlementStatus: true, taxStatus: true, issuedAt: true,
  billingMonth: true, counterpartyType: true, partyId: true, apartmentId: true, propertyId: true, total: true,
  originalDocumentId: true, paymentId: true, supersededByDocumentId: true,
} as const;

export async function listBillingDocuments(
  orgId: string,
  q: ListBillingDocumentsQuery,
): Promise<{ items: BillingDocumentListItem[]; total: number }> {
  const db = getDb();
  const where = await buildWhere(orgId, q);
  const [total, rows] = await Promise.all([
    db.billingDocument.count({ where }),
    db.billingDocument.findMany({
      where,
      select: LIST_SELECT,
      orderBy: [{ issuedAt: "desc" }, { documentNumber: "desc" }],
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
    }),
  ]);
  return { items: await enrich(orgId, rows), total };
}

/** The per-charge row the detail read needs: settlement (outstanding) plus the
 * unit the charge is for, used to give each display line its own unit identity. */
type ChargeSettlementRow = {
  id: string;
  outstandingAmount: Prisma.Decimal;
  /** Set on an SST sibling Charge → the base charge it taxes. Surfaced as the DTO's
   * `taxParentChargeId` so a renderer can pair a tax line with its base without
   * parsing charge numbers (see foldTaxLines, @kason/shared). */
  parentChargeId: string | null;
  unit: { listingType: string; apartment: { unitCode: string; listingMode: string } } | null;
};

export async function getBillingDocumentDetail(orgId: string, id: string): Promise<BillingDocumentDetail | null> {
  const db = getDb();
  const doc = await db.billingDocument.findFirst({
    where: { id, organizationId: orgId },
    include: { lines: true },
  });
  if (!doc) return null;
  // Derive the badges ONCE for this doc and share them with enrich (so list + detail
  // agree, R11) and with the breakdown totals below — no double derivation.
  const detailBadges = await deriveForDocs(orgId, [
    {
      id: doc.id,
      documentStatus: doc.documentStatus,
      supersededByDocumentId: doc.supersededByDocumentId,
      settlementStatus: doc.settlementStatus,
      total: doc.total,
    },
  ]);
  const [listItem] = await enrich(orgId, [doc], detailBadges);
  // Overpayment-CN lines (R12a) carry categoryId=null — filter before the
  // findMany's `{ in: [...] }` clause (a null there is rejected by Prisma).
  const categoryIds = [...new Set(doc.lines.map((l) => l.categoryId).filter((id): id is string => id !== null))];
  const categories = await db.chargeCategory.findMany({
    where: { organizationId: orgId, id: { in: categoryIds } },
    select: { id: true, name: true },
  });
  const categoryName = new Map(categories.map((c) => [c.id, c.name]));
  const related = await db.billingDocument.findMany({
    where: { organizationId: orgId, originalDocumentId: id },
    select: { id: true, docType: true, documentNumber: true, status: true },
    orderBy: { issuedAt: "asc" },
  });

  // Settlement figures for the drawer's Amount Paid / Balance Due rows. Both are
  // read from the SAME source the settlement pill derives from, so they can never
  // contradict it: balance = Σ(charge.outstandingAmount) → "0.00" ⟺ PAID, and
  // amountPaid = Σ(posted PaymentAllocation) − Σ(reversals) = cash only (credit-note
  // offsets stay on the separate `creditAmount` line). Overpayment-CN lines (R12a)
  // carry chargeId=null and settle no charge — excluded (same filter as categories).
  const docChargeIds = [...new Set(doc.lines.map((l) => l.chargeId).filter((x): x is string => x !== null))];
  const [chargeRows, allocRows] = await Promise.all([
    docChargeIds.length
      ? db.charge.findMany({
          where: { organizationId: orgId, id: { in: docChargeIds } },
          // `unit` is the Charge→Listing relation (the Prisma model `Listing` is
          // mapped to the "Unit" table). Selected on the query that ALREADY runs
          // for outstanding, so per-line unit identity costs no extra round-trip.
          select: {
            id: true,
            outstandingAmount: true,
            parentChargeId: true,
            unit: {
              select: {
                listingType: true,
                apartment: { select: { unitCode: true, listingMode: true } },
              },
            },
          },
        })
      : Promise.resolve([] as ChargeSettlementRow[]),
    docChargeIds.length
      ? db.paymentAllocation.findMany({
          where: { organizationId: orgId, chargeId: { in: docChargeIds }, ...CASH_ALLOCATION_WHERE },
          select: { id: true, allocatedAmount: true, chargeId: true },
        })
      : Promise.resolve([] as { id: string; allocatedAmount: Prisma.Decimal; chargeId: string | null }[]),
  ]);
  // Per-charge outstanding — drives BOTH the document balance (Σ over distinct
  // charges) and each line's charge-level `outstanding` (the Record-Payment form's
  // allocation cap). docChargeIds is already de-duplicated, so summing the map
  // values never double-counts a charge shared across itemised lines.
  const outstandingByCharge = new Map(
    chargeRows.map((c) => [c.id, toCents(c.outstandingAmount.toString(), "getBillingDocumentDetail.outstanding")]),
  );
  // Per-line unit identity — the answer the document-level unitCode cannot give
  // on a combined owner statement (apartmentId null ⇒ header reads "—").
  const unitCodeByCharge = new Map(chargeRows.map((c) => [c.id, formatLineUnitLabel(c.unit)]));
  // Tax sibling → the base charge it taxes, so `foldTaxLines` can pair the two
  // structurally instead of parsing charge numbers on the client.
  const parentChargeIdByCharge = new Map(chargeRows.map((c) => [c.id, c.parentChargeId]));
  const balanceCents = [...outstandingByCharge.values()].reduce((s, v) => s + v, 0);
  const reversed = await sumReversalsForAllocations(db, orgId, allocRows.map((a) => a.id));
  // Per-charge paid (net of reversals) + document total, in one pass.
  const paidByCharge = new Map<string, number>();
  let paidCents = 0;
  for (const a of allocRows) {
    const netCents =
      toCents(a.allocatedAmount.toString(), "getBillingDocumentDetail.alloc") -
      Math.round((reversed.get(a.id) ?? 0) * 100);
    paidCents += netCents;
    if (a.chargeId) paidByCharge.set(a.chargeId, (paidByCharge.get(a.chargeId) ?? 0) + netCents);
  }

  // Per-LINE paid/outstanding: prorate each charge's figure across its lines by line
  // amount (foots to the charge total; exact for 1:1 line↔charge). Drives the invoice
  // detail's per-line "Paid · Outstanding" and the Record-Payment allocation caps.
  const paidByLine = new Map<string, number>();
  const outstandingByLine = new Map<string, number>();
  const linesByCharge = new Map<string, { id: string; amountCents: number }[]>();
  for (const l of doc.lines) {
    if (!l.chargeId) continue;
    const arr = linesByCharge.get(l.chargeId) ?? [];
    arr.push({ id: l.id, amountCents: toCents(l.amount.toString(), "getBillingDocumentDetail.lineAmount") });
    linesByCharge.set(l.chargeId, arr);
  }
  for (const [chargeId, chargeLines] of linesByCharge) {
    const weights = chargeLines.map((cl) => cl.amountCents);
    const paidSplit = prorateAcrossLines(Math.max(0, paidByCharge.get(chargeId) ?? 0), weights);
    const outSplit = prorateAcrossLines(Math.max(0, outstandingByCharge.get(chargeId) ?? 0), weights);
    chargeLines.forEach((cl, i) => {
      paidByLine.set(cl.id, paidSplit[i]);
      outstandingByLine.set(cl.id, outSplit[i]);
    });
  }

  // Derived note totals for the adjusted-amount breakdown, from the single derivation above.
  const detailBadge = detailBadges.get(doc.id);

  // Phase 2.1: line-level, SERVER-DERIVED adjustment fields. Active (documentStatus
  // ISSUED — the canonical predicate, note-lifecycle.ts) charge-backed CN/DN linked
  // to THIS doc, attributed at CHARGE granularity and prorated across that charge's
  // display lines the SAME way paid/outstanding are above (reuses linesByCharge /
  // prorateAcrossLines), so the per-line parts always foot to the charge-level note
  // totals. Overpayment/charge-less notes carry no charge-backed line and are
  // excluded by the `lines: { some: { chargeId: { not: null } } }` filter.
  const noteDocs = await db.billingDocument.findMany({
    where: {
      organizationId: orgId,
      originalDocumentId: doc.id,
      docType: { in: ["credit_note", "debit_note"] },
      documentStatus: { in: [...ACTIVE_ADJUSTMENT_NOTE_STATUSES] },
      lines: { some: { chargeId: { not: null } } },
    },
    select: {
      id: true,
      documentNumber: true,
      docType: true,
      // sstAmount rides along so the SST COLUMN can be adjusted too, not just the
      // amount. A note on an SST-bearing charge declares its own tax relief there
      // (issueDocumentTx derives it from the line's sstRate), and without it a
      // half-credited RM 1.00 charge went on printing the full RM 0.08 of SST.
      lines: { select: { chargeId: true, amount: true, sstAmount: true } },
    },
  });
  // Per-charge cents totals (split by docType) + per-charge, per-note contributions
  // (a note's own lines against the same charge are summed first, in case it carries
  // more than one) — the SAME per-charge totals feed both the debit/credit line
  // proration below and `adjustments[]`.
  const debitCentsByCharge = new Map<string, number>();
  const creditCentsByCharge = new Map<string, number>();
  const noteContribByCharge = new Map<
    string,
    { noteId: string; documentNumber: string; docType: "credit_note" | "debit_note"; cents: number }[]
  >();
  const netSstCentsByCharge = new Map<string, number>();
  for (const n of noteDocs) {
    const docType = n.docType as "credit_note" | "debit_note";
    const perChargeCents = new Map<string, number>();
    const perChargeSstCents = new Map<string, number>();
    for (const l of n.lines) {
      if (!l.chargeId) continue;
      const c = toCents(l.amount.toString(), "getBillingDocumentDetail.noteLine");
      perChargeCents.set(l.chargeId, (perChargeCents.get(l.chargeId) ?? 0) + c);
      const s = toCents(l.sstAmount.toString(), "getBillingDocumentDetail.noteLineSst");
      if (s !== 0) perChargeSstCents.set(l.chargeId, (perChargeSstCents.get(l.chargeId) ?? 0) + s);
    }
    for (const [chargeId, cents] of perChargeCents) {
      if (docType === "debit_note") debitCentsByCharge.set(chargeId, (debitCentsByCharge.get(chargeId) ?? 0) + cents);
      else creditCentsByCharge.set(chargeId, (creditCentsByCharge.get(chargeId) ?? 0) + cents);
      const arr = noteContribByCharge.get(chargeId) ?? [];
      arr.push({ noteId: n.id, documentNumber: n.documentNumber, docType, cents });
      noteContribByCharge.set(chargeId, arr);
    }
    // SST is netted (not split by direction) because there is no "debit SST / credit
    // SST" column to show — only an adjusted figure. A debit adds tax, a credit
    // relieves it.
    for (const [chargeId, sstCents] of perChargeSstCents) {
      const signed = docType === "debit_note" ? sstCents : -sstCents;
      netSstCentsByCharge.set(chargeId, (netSstCentsByCharge.get(chargeId) ?? 0) + signed);
    }
  }
  const debitAdjByLine = new Map<string, number>();
  const creditAdjByLine = new Map<string, number>();
  const netSstAdjByLine = new Map<string, number>();
  const adjustmentsByLine = new Map<string, BillingDocumentLineDto["adjustments"]>();
  for (const [chargeId, chargeLines] of linesByCharge) {
    const weights = chargeLines.map((cl) => cl.amountCents);
    const debitSplit = prorateAcrossLines(debitCentsByCharge.get(chargeId) ?? 0, weights);
    const creditSplit = prorateAcrossLines(creditCentsByCharge.get(chargeId) ?? 0, weights);
    // Prorated on the same weights as the amounts, so a charge itemised across
    // several display lines keeps Σ(per-line SST) === the charge's total SST move.
    const netSst = netSstCentsByCharge.get(chargeId) ?? 0;
    const sstSplit = prorateAcrossLines(Math.abs(netSst), weights);
    const sstSign = netSst < 0 ? -1 : 1;
    chargeLines.forEach((cl, i) => {
      debitAdjByLine.set(cl.id, debitSplit[i]);
      creditAdjByLine.set(cl.id, creditSplit[i]);
      netSstAdjByLine.set(cl.id, sstSign * sstSplit[i]);
    });
    for (const note of noteContribByCharge.get(chargeId) ?? []) {
      const noteSplit = prorateAcrossLines(note.cents, weights);
      chargeLines.forEach((cl, i) => {
        const arr = adjustmentsByLine.get(cl.id) ?? [];
        arr.push({ noteId: note.noteId, docType: note.docType, documentNumber: note.documentNumber, amountCents: noteSplit[i] });
        adjustmentsByLine.set(cl.id, arr);
      });
    }
  }

  // Attachments (bill-expenses R6): resolve each expense line's files via
  // charge.sourceGridExpenseId → GridExpense.attachments. Flag-gated; [] when off.
  const attachmentsByLine = new Map<string, { id: string; filename: string }[]>();
  if (isPhase2FlagEnabled("ENABLE_BILL_EXPENSES_AS_CHARGES") && docChargeIds.length) {
    const expCharges = await db.charge.findMany({
      where: { organizationId: orgId, id: { in: docChargeIds }, sourceGridExpenseId: { not: null } },
      select: { id: true, sourceGridExpenseId: true },
    });
    const expenseIdByCharge = new Map(expCharges.map((c) => [c.id, c.sourceGridExpenseId!]));
    const expenseIds = [...new Set(expCharges.map((c) => c.sourceGridExpenseId!))];
    if (expenseIds.length) {
      const atts = await db.gridAttachment.findMany({
        where: { organizationId: orgId, expenseId: { in: expenseIds } },
        select: { id: true, filename: true, expenseId: true },
        orderBy: { createdAt: "asc" },
      });
      const byExpense = new Map<string, { id: string; filename: string }[]>();
      for (const a of atts) {
        if (!a.expenseId) continue;
        const arr = byExpense.get(a.expenseId) ?? [];
        arr.push({ id: a.id, filename: a.filename });
        byExpense.set(a.expenseId, arr);
      }
      for (const l of doc.lines) {
        if (!l.chargeId) continue;
        const expId = expenseIdByCharge.get(l.chargeId);
        if (expId) attachmentsByLine.set(l.id, byExpense.get(expId) ?? []);
      }
    }
  }

  return {
    ...listItem,
    subtotal: money(doc.subtotal),
    sstAmount: money(doc.sstAmount),
    creditAmount: doc.creditAmount === null ? null : money(doc.creditAmount),
    debitNoteTotal: centsToString(detailBadge?.debitNoteCents ?? 0),
    creditNoteTotal: centsToString(detailBadge?.creditNoteCents ?? 0),
    amountPaid: centsToString(Math.max(0, paidCents)),
    balance: centsToString(Math.max(0, balanceCents)),
    reason: doc.reason,
    statementInvoiceId: doc.statementInvoiceId,
    hasPdf: doc.pdfKey !== null,
    lines: doc.lines.map((l) => {
      const originalCents = toCents(l.amount.toString(), "getBillingDocumentDetail.originalAmount");
      const debitCents = l.chargeId ? (debitAdjByLine.get(l.id) ?? 0) : 0;
      const creditCents = l.chargeId ? (creditAdjByLine.get(l.id) ?? 0) : 0;
      const netCents = debitCents - creditCents;
      const chargeLineCount = l.chargeId ? (linesByCharge.get(l.chargeId)?.length ?? 1) : 1;
      const allocationBasis: "exact" | "prorated" = l.chargeId === null || chargeLineCount === 1 ? "exact" : "prorated";
      return {
        id: l.id,
        chargeId: l.chargeId,
        description: l.description,
        amount: money(l.amount),
        sstRate: l.sstRate.toString(),
        sstAmount: money(l.sstAmount),
        categoryName: (l.categoryId ? categoryName.get(l.categoryId) : undefined) ?? "—",
        unitCode: l.chargeId ? (unitCodeByCharge.get(l.chargeId) ?? null) : null,
        // Per-line prorated figures (see BillingDocumentLineDto): "0.00" for a
        // charge-less line; parts of a shared charge sum back to the charge total.
        paid: l.chargeId ? centsToString(paidByLine.get(l.id) ?? 0) : "0.00",
        outstanding: l.chargeId ? centsToString(outstandingByLine.get(l.id) ?? 0) : "0.00",
        // Phase 2.1: line-level, SERVER-DERIVED adjustment fields (see BillingDocumentLineDto).
        originalAmount: money(l.amount),
        debitAdjustmentAmount: centsToString(debitCents),
        creditAdjustmentAmount: centsToString(creditCents),
        netAdjustmentAmount: centsToString(netCents),
        adjustedAmount: centsToString(originalCents + netCents),
        // The SST actually owed after active notes. Clamped at 0 alongside its base:
        // tax relief can zero a line's tax, never turn it into a rebate.
        adjustedSstAmount: centsToString(
          Math.max(
            0,
            toCents(l.sstAmount.toString(), "getBillingDocumentDetail.lineSst") +
              (l.chargeId ? (netSstAdjByLine.get(l.id) ?? 0) : 0),
          ),
        ),
        allocationBasis,
        adjustments: l.chargeId ? (adjustmentsByLine.get(l.id) ?? []) : [],
        // bill-expenses R6 (from origin/master merge): source-expense attachments.
        attachments: attachmentsByLine.get(l.id) ?? [],
        // The tax-sibling pair. `lines` stays RAW — the Record-Payment form, the
        // CN/DN picker and correct-invoice all need the tax line. Only renderers
        // fold, via foldTaxLines.
        isTax: l.isTax,
        taxParentChargeId: l.isTax && l.chargeId ? (parentChargeIdByCharge.get(l.chargeId) ?? null) : null,
      };
    }),
    relatedDocuments: related.map((r) => ({
      id: r.id,
      docType: r.docType as BillingDocumentDetail["docType"],
      documentNumber: r.documentNumber,
      status: r.status as BillingDocumentDetail["status"],
    })),
  };
}
