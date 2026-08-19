/**
 * Two-phase repair for owner invoices that disagree with the money behind them.
 *
 * PHASE 1 — settle IVOWN lines the owner ledger already deducted but nothing ever
 * settled: the management-fee invoices that read "Unpaid" while KAEN had in fact been
 * paid out of the rent. Does NOT hand-write settlements. It re-runs the real hook
 * (autoOffsetOwnerReceivablesForPaidRent) against rent that is ALREADY fully paid, so
 * the backfill takes exactly the same guarded, audited, payable-neutral path a new
 * payment now takes. Anything the hook would refuse, this refuses too.
 *
 * PHASE 2 — reconcile the document STATUS PROJECTION. "Paid" has two homes:
 * the charges (what the detail view re-derives on read) and BillingDocument.status /
 * settlementStatus (a persisted column every LIST view reads). A document whose charges
 * are all settled but whose column still says UNPAID looks paid inside and unpaid
 * outside. Phase 2 recomputes the expected projection with the SAME deriveDocumentStatus
 * the app uses and reports every disagreement — in both directions, so it is a genuine
 * check and not just a one-way patch.
 *
 * Repairs go through refreshDocumentStatusForCharges rather than a direct UPDATE, so
 * they inherit its guards (terminal owner `offset` docs and non-receivable doc types are
 * left alone) instead of re-implementing them here.
 *
 * Idempotent: phase 1 settles `outstanding`; phase 2 writes only on disagreement.
 *
 * Usage (from repo root):
 *   npx tsx scripts/backfill-ledger-backed-ivown.ts            # dry run — reports only
 *   npx tsx scripts/backfill-ledger-backed-ivown.ts --apply    # settle + reconcile
 */
import { resolve } from "node:path";
import dotenv from "dotenv";

// Load .env BEFORE @kason/db is imported — the client reads DATABASE_URL on init.
dotenv.config({ path: resolve(process.cwd(), ".env") });

import { getDb } from "@kason/db";
import { autoOffsetOwnerReceivablesForPaidRent } from "../apps/api/src/modules/owner-billing/auto-offset-on-rent.hook";
import {
  deriveDocumentStatus,
  mapSettlementStatus,
  refreshDocumentStatusForCharges,
} from "../apps/api/src/modules/billing-documents/status.service";

const APPLY = process.argv.includes("--apply");
const db = getDb();

/** Open IVOWN lines whose charge the ledger already booked as an active expense. */
async function stuckLines() {
  const rows = await db.$queryRawUnsafe<
    { documentNumber: string; chargeId: string; chargeType: string; outstanding: string; organizationId: string }[]
  >(`
    SELECT bd."documentNumber", ch.id AS "chargeId", ch."chargeType",
           ch."outstandingAmount"::text AS outstanding, bd."organizationId"
      FROM "BillingDocumentLine" l
      JOIN "BillingDocument" bd ON bd.id = l."documentId"
      JOIN "Charge" ch ON ch.id = l."chargeId"
     WHERE bd."docType" = 'invoice'
       AND bd."ledgerTreatment" = 'MANAGER_REVENUE'
       AND ch.status NOT IN ('void', 'credited')
       AND ch."outstandingAmount" > 0
       AND EXISTS (
         SELECT 1 FROM "OwnerLedgerEntry" e
          WHERE e."sourceChargeId" = ch.id AND e.status = 'active' AND e.direction = 'expense'
       )
     ORDER BY bd."documentNumber"
  `);
  return rows;
}

/**
 * PHASE 2 — every receivable document whose persisted projection disagrees with what its
 * charges actually say. Reported in both directions; "inside paid, outside unpaid" is the
 * common one, but a document marked PAID whose charges are open is the more dangerous one.
 */
async function projectionMismatches() {
  const docs = await db.billingDocument.findMany({
    where: { docType: { in: ["invoice", "debit_note"] } },
    select: {
      id: true,
      documentNumber: true,
      status: true,
      settlementStatus: true,
      counterpartyType: true,
      lines: { select: { chargeId: true } },
    },
  });

  const out: {
    id: string;
    documentNumber: string;
    was: string;
    expected: string;
    chargeIds: string[];
  }[] = [];

  for (const doc of docs) {
    // Mirror refreshDocumentStatusForCharges' own skip: a voided owner statement's
    // `offset` is set deliberately WITHOUT crediting the charges, so re-deriving it
    // would un-offset it. Not a mismatch — a documented terminal state.
    if (doc.status === "offset" && doc.counterpartyType === "owner") continue;

    const chargeIds = doc.lines.map((l) => l.chargeId).filter((id): id is string => id !== null);
    if (chargeIds.length === 0) continue;

    const charges = await db.charge.findMany({
      where: { id: { in: chargeIds } },
      select: { status: true, amount: true, outstandingAmount: true },
    });
    const expectedLegacy = deriveDocumentStatus(
      charges.map((c) => ({
        status: c.status,
        amountCents: Math.round(Number(c.amount.toString()) * 100),
        outstandingCents: Math.round(Number(c.outstandingAmount.toString()) * 100),
      })),
    );
    const expected = mapSettlementStatus(expectedLegacy);
    if (expected !== doc.settlementStatus) {
      out.push({
        id: doc.id,
        documentNumber: doc.documentNumber,
        was: `${doc.status}/${doc.settlementStatus}`,
        expected: `${expectedLegacy}/${expected}`,
        chargeIds,
      });
    }
  }
  return out;
}

async function main() {
  // Refuse to touch anything but a local database. This settles money; a mis-pointed
  // DATABASE_URL must fail loudly rather than quietly rewrite a client's books.
  const dsn = process.env.DATABASE_URL ?? "";
  if (!/@(localhost|127\.0\.0\.1)[:/]/.test(dsn)) {
    console.error(`REFUSING: DATABASE_URL is not local.\n  ${dsn.replace(/:\/\/[^@]*@/, "://***@")}`);
    process.exit(1);
  }
  // (The ENABLE_AUTO_OFFSET_ON_RENT precondition that used to sit here is gone with the
  // flag itself — autoOffsetOwnerReceivablesForPaidRent is unconditional now, so the hook
  // this script replays can no longer no-op. Left as a note rather than deleted silently:
  // the guard's message told operators the run would do nothing, which would have been
  // actively false, and the exit(1) blocked a legitimate backfill behind an env var that
  // no longer exists anywhere.)

  // ── PHASE 1 — settle what the ledger already deducted ──────────────────────
  const before = await stuckLines();
  if (before.length === 0) {
    console.log("PHASE 1: nothing stuck — every ledger-backed IVOWN line is already settled.");
  } else {
    console.log(`PHASE 1: stuck ledger-backed IVOWN lines: ${before.length}`);
    for (const r of before) console.log(`  ${r.documentNumber}  ${r.chargeType}  outstanding=${r.outstanding}`);

    if (APPLY) {
      // An operator to attribute the audit rows to. The hook records who settled.
      const actor = await db.user.findFirst({ where: { userType: "operator" }, select: { id: true } });
      if (!actor) {
        console.error("REFUSING: no operator user to attribute the audit trail to.");
        process.exit(1);
      }

      // Drive the hook exactly as a payment would: hand it the ALREADY-paid rent charges
      // for each affected org. The hook resolves owners, classifies lines and settles.
      const orgIds = [...new Set(before.map((r) => r.organizationId))];
      for (const orgId of orgIds) {
        const paidRent = await db.charge.findMany({
          where: { organizationId: orgId, chargeType: "rent", status: "paid" },
          select: { id: true },
        });
        if (paidRent.length === 0) {
          console.log(`  org ${orgId}: no fully-paid rent — nothing to trigger on, skipping.`);
          continue;
        }
        console.log(`  org ${orgId}: replaying ${paidRent.length} paid rent charge(s) through the hook…`);
        await autoOffsetOwnerReceivablesForPaidRent(
          orgId,
          actor.id,
          "admin",
          paidRent.map((c) => c.id),
        );
      }

      const after = await stuckLines();
      console.log(`  Settled ${before.length - after.length} of ${before.length}.`);
      for (const r of after) {
        console.log(`  STILL OPEN: ${r.documentNumber} ${r.chargeType} outstanding=${r.outstanding}`);
      }
    }
  }

  // ── PHASE 2 — reconcile "paid inside" against "paid outside" ───────────────
  const mismatched = await projectionMismatches();
  if (mismatched.length === 0) {
    console.log("\nPHASE 2: every document's status projection agrees with its charges.");
    if (!APPLY && before.length > 0) console.log("\nDry run. Re-run with --apply.");
    return;
  }

  console.log(`\nPHASE 2: documents whose projection disagrees with their charges: ${mismatched.length}`);
  for (const m of mismatched) console.log(`  ${m.documentNumber}  persisted=${m.was}  should be=${m.expected}`);

  if (!APPLY) {
    console.log("\nDry run. Re-run with --apply.");
    return;
  }

  for (const m of mismatched) await refreshDocumentStatusForCharges(m.chargeIds);

  const stillOff = await projectionMismatches();
  console.log(`  Reconciled ${mismatched.length - stillOff.length} of ${mismatched.length}.`);
  for (const m of stillOff) console.log(`  STILL OFF: ${m.documentNumber} persisted=${m.was} expected=${m.expected}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
