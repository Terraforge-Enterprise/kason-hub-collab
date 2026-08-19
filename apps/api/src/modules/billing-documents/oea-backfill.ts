// apps/api/src/modules/bills-grid/oea-backfill.ts
//
// Backfills an Owner Expense Advice (OEA-) document for every historical
// owner_borne_expense ledger deduction that has none — the deductions booked before
// the OEA document existed, which are invisible in the document register.
//
// SAFETY CONTRACT: this creates BillingDocument + BillingDocumentLine rows ONLY. It must
// never write an OwnerLedgerEntry — the deduction already exists and is the sole money
// movement. Because it moves no money it is safe inside a FROZEN owner-statement period,
// and so deliberately does NOT call assertPeriodOpen (which guards the Bill path
// precisely because that path DOES move money). The in-transaction ledger guard below
// enforces the contract rather than relying on that reasoning holding forever.
import { getDb } from "@kason/db";
import { issueDocumentTx } from "./issue.service";
import { resolveLineSst } from "../bills-grid/issue-grouped";

export type OeaBackfillOptions = {
  /** Perform the mint. Default (false) is a dry run that writes nothing. */
  apply?: boolean;
  /** Restrict to one organization. Default: every org. */
  orgId?: string;
  /** Stamped as BillingDocument.issuedById — a NOT NULL uuid, so REQUIRED for --apply. */
  actorUserId?: string;
};

export type OeaBackfillResult = { groups: number; created: number; skipped: number };

export async function runOeaBackfill(opts: OeaBackfillOptions): Promise<OeaBackfillResult> {
  const db = getDb();
  const apply = opts.apply === true;

  if (apply && !opts.actorUserId) {
    throw new Error("apply requires actorUserId — BillingDocument.issuedById is a NOT NULL uuid, so a sentinel string fails at insert");
  }
  if (apply && opts.actorUserId) {
    const actor = await db.user.findFirst({ where: { id: opts.actorUserId }, select: { id: true } });
    if (!actor) throw new Error(`actorUserId ${opts.actorUserId} is not an existing user`);
  }

  // Column names verified against the live schema: OwnerLedgerEntry carries listingId and
  // statementMonth — it has no unitId/periodMonth.
  const entries = await db.ownerLedgerEntry.findMany({
    where: {
      sourceType: "owner_borne_expense",
      status: "active",
      ...(opts.orgId ? { organizationId: opts.orgId } : {}),
    },
    select: {
      id: true, organizationId: true, ownerPartyId: true, listingId: true,
      statementMonth: true, sourceChargeId: true,
    },
  });

  // Group by (org, owner, listing, month) — the same granularity issue-grouped.ts uses,
  // so a backfilled document has the same shape as one minted at Bill time.
  const groups = new Map<string, typeof entries>();
  for (const e of entries) {
    const month = e.statementMonth ? e.statementMonth.toISOString().slice(0, 10) : "none";
    const key = `${e.organizationId}|${e.ownerPartyId}|${e.listingId ?? "none"}|${month}`;
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }

  let created = 0;
  let skipped = 0;

  for (const [key, bucket] of groups) {
    const idempotencyKey = `oea-backfill:${key}`;
    const existing = await db.billingDocument.findFirst({
      where: { docType: "owner_expense_advice", idempotencyKey },
      select: { id: true },
    });
    if (existing) { skipped++; continue; }

    const first = bucket[0]!;
    const chargeIds = bucket.map((b) => b.sourceChargeId).filter((x): x is string => x !== null);
    // Charge.description and Charge.sstRate are BOTH nullable, while the document line's
    // are NOT NULL — pull the category for the same fallbacks issue-grouped.ts uses.
    const charges = chargeIds.length
      ? await db.charge.findMany({
          where: { id: { in: chargeIds } },
          select: {
            id: true, categoryId: true, description: true, amount: true, sstRate: true,
            category: { select: { name: true, defaultSstRate: true } },
          },
        })
      : [];
    if (charges.length === 0) {
      console.warn(`skip ${key}: no resolvable source charges`);
      skipped++;
      continue;
    }

    if (!apply) {
      console.log(`PLAN ${key} -> OEA with ${charges.length} line(s)`);
      created++;
      continue;
    }

    await db.$transaction(async (tx) => {
      // Ledger guard INSIDE the transaction, counted on `tx` and org-scoped: throwing
      // here ROLLS BACK the document too, so a detected ledger write leaves zero rows.
      // Counting outside $transaction would only notice post-commit, with the document
      // already persisted.
      const ledgerBefore = await tx.ownerLedgerEntry.count({
        where: { organizationId: first.organizationId, sourceType: "owner_borne_expense" },
      });

      const doc = await issueDocumentTx(tx, {
        organizationId: first.organizationId,
        docType: "owner_expense_advice",
        seriesCode: "OEA",
        counterpartyType: "owner",
        partyId: first.ownerPartyId,
        listingId: first.listingId ?? undefined,
        billingMonth: first.statementMonth ? first.statementMonth.toISOString().slice(0, 10) : undefined,
        idempotencyKey,
        lines: charges.map((c) => ({
          chargeId: c.id,
          categoryId: c.categoryId ?? undefined,
          description: c.description ?? c.category?.name ?? "Owner-borne expense",
          amount: c.amount.toString(),
          sstRate: resolveLineSst(c.sstRate, c.category?.defaultSstRate ?? "0"),
        })),
        actorUserId: opts.actorUserId as string,
      });

      // Backfilled numbers are minted in backfill order, so document numbers are NOT
      // chronological for historical rows (an accepted trade-off). Stamping issuedAt from
      // the ledger period keeps every date-ordered view correct despite that.
      if (first.statementMonth) {
        await tx.billingDocument.update({ where: { id: doc.id }, data: { issuedAt: first.statementMonth } });
      }

      const ledgerAfter = await tx.ownerLedgerEntry.count({
        where: { organizationId: first.organizationId, sourceType: "owner_borne_expense" },
      });
      if (ledgerAfter !== ledgerBefore) {
        throw new Error(`ABORT: backfill wrote an OwnerLedgerEntry (${ledgerBefore} -> ${ledgerAfter}). No money may move.`);
      }
    });
    created++;
  }

  console.log(`groups=${groups.size} created=${created} skipped=${skipped} apply=${apply}`);
  return { groups: groups.size, created, skipped };
}
