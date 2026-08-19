// apps/api/src/modules/billing-documents/graduation-retry.service.ts
//
// Spec R13 — the repair path for a graduation that failed.
//
// Graduation runs post-commit and never throws, so a failure leaves the tenant correctly
// PAID with the tax invoice missing. The money is right; only the document is absent. That
// state is recorded by a durable `graduation.issue_failed` audit marker, but a marker an
// operator has to read audit rows to find is not a repair path — this is.
//
// Idempotent by construction: it re-derives what is missing rather than replaying a
// remembered failure, so running it when nothing is pending is a clean no-op, and running
// it twice mints nothing the second time (graduateProformaForPaymentTx's own
// already-graduated guard).
import type { Prisma } from "@kason/db";
import { getDb } from "@kason/db";
import { CASH_ALLOCATION_WHERE } from "@kason/shared";
import { isPhase2FlagEnabled } from "../../lib/feature-flags";
import { graduateProformaForPaymentTx } from "./graduation.service";
import { issueReceiptDocumentTx } from "./receipts.service";

/**
 * Charges on this entry that SHOULD have graduated and have not: fully settled, sitting on
 * a live proforma, and absent from any graduated invoice — grouped by the payment that
 * settled each one, because graduation is keyed per payment.
 */
export async function findPendingGraduations(
  tx: Prisma.TransactionClient,
  orgId: string,
  entryId: string,
): Promise<Map<string, { partyId: string; chargeIds: string[] }>> {
  const out = new Map<string, { partyId: string; chargeIds: string[] }>();

  // Fully-settled grid charges for this entry. `outstandingAmount <= 0` is the charge
  // ledger's own settled test — the same signal settlementByEntry reads.
  const settled = await tx.charge.findMany({
    where: {
      organizationId: orgId,
      sourceGridEntryId: entryId,
      outstandingAmount: { lte: 0 },
      status: { notIn: ["void", "credited"] },
    },
    select: { id: true, partyId: true },
  });
  if (settled.length === 0) return out;
  const ids = settled.map((c) => c.id);

  // On a live proforma…
  const onProforma = await tx.billingDocumentLine.findMany({
    where: {
      chargeId: { in: ids },
      document: { organizationId: orgId, docType: "proforma", documentStatus: "ISSUED" },
    },
    select: { chargeId: true },
  });
  const proformaCharges = new Set(onProforma.map((l) => l.chargeId).filter((x): x is string => x !== null));
  if (proformaCharges.size === 0) return out;

  // …and NOT already on a graduated invoice.
  const graduated = await tx.billingDocumentLine.findMany({
    where: {
      chargeId: { in: [...proformaCharges] },
      document: { organizationId: orgId, proformaDocumentId: { not: null } },
    },
    select: { chargeId: true },
  });
  const done = new Set(graduated.map((l) => l.chargeId).filter((x): x is string => x !== null));
  const pending = [...proformaCharges].filter((id) => !done.has(id));
  if (pending.length === 0) return out;

  // Which payment settled each one. Cash-backed only — the same single definition of paid
  // the rest of the system uses.
  const allocs = await tx.paymentAllocation.findMany({
    where: { organizationId: orgId, chargeId: { in: pending }, ...CASH_ALLOCATION_WHERE },
    select: { paymentId: true, chargeId: true, payment: { select: { partyId: true } } },
    orderBy: { allocatedAt: "asc" },
  });
  for (const a of allocs) {
    if (!a.chargeId) continue;
    const entry = out.get(a.paymentId) ?? { partyId: a.payment.partyId, chargeIds: [] };
    if (!entry.chargeIds.includes(a.chargeId)) entry.chargeIds.push(a.chargeId);
    out.set(a.paymentId, entry);
  }
  return out;
}

export type RetryResult =
  | {
      ok: true;
      status: 200;
      data: {
        /** Invoices minted by this repair. Empty when nothing was pending. */
        graduated: { id: string; documentNumber: string }[];
        /** Receipts minted alongside them. Reported separately because the two are issued
         *  in SEPARATE transactions (see the note in the service), so a repair can
         *  legitimately produce an invoice and not its receipt. */
        receipts: { id: string; documentNumber: string }[];
      };
    }
  | { ok: false; status: 404 | 409; error: string };

/** Re-run graduation for every payment on this entry that is missing its invoice. */
export async function retryGraduationForEntryService(
  session: { orgId: string; userId: string; role: string },
  entryId: string,
): Promise<RetryResult> {
  if (!isPhase2FlagEnabled("ENABLE_PHASE2_BILLING_DOCS") || !isPhase2FlagEnabled("ENABLE_PROFORMA_INVOICES")) {
    return { ok: false, status: 409, error: "FLAG_DISABLED" };
  }
  const db = getDb();
  const entry = await db.unitBillsGridEntry.findFirst({
    where: { id: entryId, organizationId: session.orgId },
    select: { id: true },
  });
  if (!entry) return { ok: false, status: 404, error: "ENTRY_NOT_FOUND" };

  // One transaction for the whole repair: either every pending payment graduates or none
  // does, so a partial repair can never leave a second inconsistent state behind.
  const { graduated, receipts } = await db.$transaction(async (tx) => {
    const pending = await findPendingGraduations(tx, session.orgId, entryId);
    const made: { id: string; documentNumber: string }[] = [];
    const rcpts: { id: string; documentNumber: string }[] = [];
    for (const [paymentId, { partyId, chargeIds }] of pending) {
      const r = await graduateProformaForPaymentTx(tx, {
        organizationId: session.orgId,
        paymentId,
        partyId,
        paidChargeIds: chargeIds,
        actorUserId: session.userId,
      });
      made.push(...r.graduated);

      // The RECEIPT too. Graduation and receipt issuance run in SEPARATE post-commit
      // transactions on the live path, so they can genuinely diverge — the invoice can
      // exist while its receipt does not. A repair that only re-runs graduation leaves
      // that half broken forever, and reports success while doing it. Idempotent by the
      // same charge-set key the live path uses, so a receipt that already exists is
      // returned rather than duplicated.
      const rc = await issueReceiptDocumentTx(tx, {
        organizationId: session.orgId,
        paymentId,
        partyId,
        settledChargeIds: chargeIds,
        actorUserId: session.userId,
      });
      if ("id" in rc) rcpts.push(rc);
    }
    return { graduated: made, receipts: rcpts };
  });

  // Deliberately NOT an error when empty: "nothing was pending" is the ordinary answer
  // once someone has already repaired it, or when the chip was stale.
  return { ok: true, status: 200, data: { graduated, receipts } };
}

/**
 * Which of these entries have a graduation still pending — one batched pass for a whole
 * grid page, not a query per row.
 *
 * Drives the amber "Invoice pending" chip. Without it the repair endpoint exists but is
 * invisible: an operator would have to already suspect a failure and know the URL.
 */
export async function pendingGraduationEntryIds(
  tx: Prisma.TransactionClient,
  orgId: string,
  entryIds: string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  if (entryIds.length === 0) return out;

  const settled = await tx.charge.findMany({
    where: {
      organizationId: orgId,
      sourceGridEntryId: { in: entryIds },
      outstandingAmount: { lte: 0 },
      status: { notIn: ["void", "credited"] },
    },
    select: { id: true, sourceGridEntryId: true },
  });
  if (settled.length === 0) return out;

  const entryByCharge = new Map(settled.map((c) => [c.id, c.sourceGridEntryId!]));
  const ids = [...entryByCharge.keys()];

  const onProforma = await tx.billingDocumentLine.findMany({
    where: {
      chargeId: { in: ids },
      document: { organizationId: orgId, docType: "proforma", documentStatus: "ISSUED" },
    },
    select: { chargeId: true },
  });
  const candidates = new Set(onProforma.map((l) => l.chargeId).filter((x): x is string => x !== null));
  if (candidates.size === 0) return out;

  const graduated = await tx.billingDocumentLine.findMany({
    where: {
      chargeId: { in: [...candidates] },
      document: { organizationId: orgId, proformaDocumentId: { not: null } },
    },
    select: { chargeId: true },
  });
  const done = new Set(graduated.map((l) => l.chargeId).filter((x): x is string => x !== null));

  for (const chargeId of candidates) {
    if (done.has(chargeId)) continue;
    const entryId = entryByCharge.get(chargeId);
    if (entryId) out.add(entryId);
  }
  return out;
}
