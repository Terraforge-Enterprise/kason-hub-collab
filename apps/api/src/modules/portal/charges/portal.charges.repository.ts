import { getDb } from "@kason/db";
import { tenantVisibleChargeWhere, CASH_ALLOCATION_WHERE, foldPayableTaxSiblings } from "@kason/shared";
import { adjustmentSumsByChargeId } from "../../billing-documents/adjustment-sums";
import { isPhase2FlagEnabled } from "../../../lib/feature-flags";
import { resolveTenantBillReferences } from "./tenant-charge-reference";
import { resolveTaxSiblingFold, displayWhere, pageSiblingWhere } from "./tax-sibling-fold";

function toNumber(value: { toString(): string } | string | number | null | undefined): number {
  if (value == null) return 0;
  if (typeof value === "number") return value;
  return Number(value.toString());
}

type SessionScope = { partyId: string; orgId: string };

/** Columns a list row needs. Shared by the page query and the SST-sibling pull-in,
 * so the two can never select different shapes. */
const LIST_CHARGE_SELECT = {
  id: true,
  chargeNumber: true,
  chargeType: true,
  description: true,
  status: true,
  dueDate: true,
  amount: true,
  outstandingAmount: true,
  currency: true,
  parentChargeId: true,
} as const;

export async function listCharges(session: SessionScope, page: number, limit: number) {
  const db = getDb();
  // partyId + organizationId scope who the charge belongs to; the visibility
  // filter scopes WHICH OF THEIR OWN charges have been approved for their eyes.
  // Without it this endpoint listed the tenant's un-issued draft charges.
  const where = {
    partyId: session.partyId,
    organizationId: session.orgId,
    ...tenantVisibleChargeWhere(),
  };

  // Same SST-sibling fold the pay screen uses, from the same module so the two can
  // never drift — they had drifted once, and the tenant saw one expense as RM 0.54 on
  // the pay screen and RM 0.50 + RM 0.04 here.
  const { taxIds, foldableTaxIds } = await resolveTaxSiblingFold(db, where);
  const pagedWhere = displayWhere(where, foldableTaxIds);

  const [rows, total] = await Promise.all([
    db.charge.findMany({
      where: pagedWhere,
      select: LIST_CHARGE_SELECT,
      orderBy: { dueDate: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    db.charge.count({ where: pagedWhere }),
  ]);

  const siblingFilter = pageSiblingWhere(where, foldableTaxIds, rows.map((r) => r.id));
  const siblingRows = siblingFilter
    ? await db.charge.findMany({ where: siblingFilter, select: LIST_CHARGE_SELECT })
    : [];
  const allRows = [...rows, ...siblingRows];

  // CN/DN awareness (punch list B, 2026-08-06): the payable side already reads
  // the adjusted outstandingAmount, but the DISPLAYED totals read raw amount —
  // so a credit/debit note changed what the tenant pays without changing what
  // the tenant sees. Expose the adjustment explicitly per charge.
  //
  // Resolved for the pulled-in SIBLINGS too: charge-adjustment.service mirrors every
  // note onto the `-SST` sibling, so the sibling holds its own share of the credit and
  // the fold below has to merge it. Reading sums for the page rows alone would leave
  // the Total column understating the credit note.
  const sums = await adjustmentSumsByChargeId(db, session.orgId, allRows.map((r) => r.id));

  // The number printed on the bill the tenant was sent. `chargeNumber` is an
  // internal key that embeds raw UUIDs for grid-minted rows, and this table's
  // "Charge #" column rendered it verbatim — see tenant-charge-reference.ts.
  const billRefs = await resolveTenantBillReferences(db, session.orgId, rows.map((r) => r.id));

  const data = foldPayableTaxSiblings(
    allRows.map((r) => {
      const adj = sums.get(r.id);
      const amount = toNumber(r.amount);
      const debitNoteTotal = (adj?.debitCents ?? 0) / 100;
      const creditNoteTotal = (adj?.creditCents ?? 0) / 100;
      return {
        id: r.id,
        chargeNumber: r.chargeNumber,
        /** Bill number to show the tenant, or null when this charge is on no bill
         * yet. Clients MUST NOT fall back to `chargeNumber`. */
        documentNumber: billRefs.get(r.id) ?? null,
        chargeType: r.chargeType,
        description: r.description,
        status: r.status,
        dueDate: r.dueDate.toISOString(),
        amount,
        debitNoteTotal,
        creditNoteTotal,
        adjustedAmount: amount + debitNoteTotal - creditNoteTotal,
        outstandingAmount: toNumber(r.outstandingAmount),
        currency: r.currency,
        parentChargeId: r.parentChargeId,
        isTax: taxIds.has(r.id),
        // This list never pays, so nothing here is ever awaiting verification —
        // the field exists only because the shared fold reads it.
        pendingVerification: false,
      };
    }),
    // ⚠️ MONEY. This table has its own CN/DN columns, so the sibling's share of each
    // must merge or `adjustedAmount = amount + DN − CN` stops holding on a folded row.
    { alsoMerge: ["debitNoteTotal", "creditNoteTotal", "adjustedAmount"] },
  );

  return {
    // `total` counts display rows (folded siblings excluded from pagedWhere).
    data,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export async function getChargeDetail(session: SessionScope, chargeId: string) {
  const db = getDb();
  // The direct-id read. This is the one an attacker probes: guessing/replaying a
  // charge id must not surface a draft the list endpoint hides. A non-visible
  // charge resolves to null here, which the route maps to 404 — the same
  // "never leak existence" response as a charge belonging to another tenant.
  const row = await db.charge.findFirst({
    where: {
      id: chargeId,
      partyId: session.partyId,
      organizationId: session.orgId,
      ...tenantVisibleChargeWhere(),
    },
    select: {
      id: true,
      chargeNumber: true,
      chargeType: true,
      description: true,
      status: true,
      dueDate: true,
      amount: true,
      outstandingAmount: true,
      currency: true,
      createdAt: true,
    },
  });
  if (!row) return null;

  // P3 (spec §4.2 visibility): the tenant sees this charge's documents (its
  // Invoice/Debit Note + any CN referencing them) and "Credit applied — CN-x"
  // payment lines. Additive + flag-gated: flag-dark returns empty arrays.
  let documents: { id: string; docType: string; documentNumber: string }[] = [];
  let creditApplications: { amount: number; creditNoteNumber: string }[] = [];
  if (isPhase2FlagEnabled("ENABLE_PHASE2_BILLING_DOCS")) {
    const lines = await db.billingDocumentLine.findMany({
      where: {
        chargeId: row.id,
        document: {
          organizationId: session.orgId,
          // Lock-step with listTenantBillingDocuments / findOwnTenantBillingDocument (R9).
          // Without it this drawer lists a REPLACED PI- beside its replacement — the exact
          // confusion R9 removes — and the row 404s on click, because the by-id gate was
          // tightened and this list was not.
          NOT: { docType: "proforma", documentStatus: "CANCELLED" },
        },
      },
      select: { document: { select: { id: true, docType: true, documentNumber: true } } },
      orderBy: { document: { issuedAt: "asc" } },
    });
    documents = lines.map((l) => l.document);

    const creditAllocs = await db.paymentAllocation.findMany({
      where: {
        organizationId: session.orgId,
        chargeId: row.id,
        // The shared cash predicate PLUS this path's own credit-note narrowing,
        // merged into ONE `payment` object rather than two keys, so no reader has
        // to reason about duplicate-key precedence.
        payment: { ...CASH_ALLOCATION_WHERE.payment, paymentMethod: "credit_note" },
      },
      select: { allocatedAmount: true, paymentId: true },
    });
    if (creditAllocs.length > 0) {
      const apps = await db.creditApplication.findMany({
        where: { organizationId: session.orgId, paymentId: { in: creditAllocs.map((a) => a.paymentId) } },
        select: { paymentId: true, creditDocument: { select: { documentNumber: true } } },
      });
      const cnByPayment = new Map(apps.map((a) => [a.paymentId, a.creditDocument.documentNumber]));
      creditApplications = creditAllocs
        .filter((a) => cnByPayment.has(a.paymentId))
        .map((a) => ({
          amount: toNumber(a.allocatedAmount),
          creditNoteNumber: cnByPayment.get(a.paymentId)!,
        }));
    }
  }

  // Same CN/DN awareness as listCharges — the drawer's money breakdown needs
  // the split sums to explain the gap between the original amount and what is
  // actually payable (a residual plug misreported a CN as "Amount paid").
  const adj = (await adjustmentSumsByChargeId(db, session.orgId, [row.id])).get(row.id);
  const amount = toNumber(row.amount);
  const debitNoteTotal = (adj?.debitCents ?? 0) / 100;
  const creditNoteTotal = (adj?.creditCents ?? 0) / 100;

  return {
    ...row,
    dueDate: row.dueDate.toISOString(),
    createdAt: row.createdAt.toISOString(),
    amount,
    debitNoteTotal,
    creditNoteTotal,
    adjustedAmount: amount + debitNoteTotal - creditNoteTotal,
    outstandingAmount: toNumber(row.outstandingAmount),
    documents,
    creditApplications,
  };
}
