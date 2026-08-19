/**
 * R3 — Paid-after-freeze FORWARD collection.
 *
 * An income (rent) owner-ledger row stores the COLLECTED amount
 * (charge.amount − outstanding); an UNPAID charge freezes at collected = 0. Once
 * the owner-statement month is FROZEN it is immutable — so cash that arrives
 * AFTER the freeze can never be booked back into the frozen month. This flow
 * posts that post-freeze cash FORWARD into the CURRENT open month as a
 * `prior_period_collection` row (and a `prior_period_collection_reversal` for a
 * post-freeze allocation reversal), never mutating the frozen row or snapshot.
 *
 * Event-sourced + idempotent: `PaymentAllocation` / `PaymentAllocationReversal`
 * are append-only, so each un-forwarded allocation EVENT yields exactly one
 * forward row, keyed on the DB unique (org, sourceType, sourceAllocationEventId)
 * via createMany({ skipDuplicates }) — a re-run is an atomic no-op.
 *
 * Contract (mirrors the sync-hook): runs OUT of the caller's money tx,
 * post-commit, and NEVER throws into the caller (a failure is swallowed + logged;
 * the un-forwarded event is re-detected by R5 reconciliation).
 */
import { getDb } from "@kason/db";
import type { Prisma } from "@kason/db";
import { CASH_PAYMENT_STATUS } from "@kason/shared";
import { findPeriod } from "../owner-billing/owner-statement-period.repository";
import type { OwnerLedgerActorCtx } from "./owner-ledger.types";
// Canonical COMPLETE forward-source-type list (shared) — excluded when resolving the
// frozen-month baseline (normal) row to inherit attributes from. Was a partial 3-item
// local copy (missing reversal_forward_adjustment / prior_period_adjustment); Finding 1
// consolidated it to the single canonical constant so no aged forward row is misread.
import { FORWARD_SOURCE_TYPES } from "./owner-ledger.types";

/**
 * Post any un-forwarded post-freeze collections (and reversals) for the owner's
 * frozen-month charges into the current open month. Idempotent; never throws.
 */
export async function postPriorPeriodCollections(
  actor: OwnerLedgerActorCtx,
  ownerPartyId: string,
  frozenMonth: string, // "YYYY-MM"
): Promise<{ posted: number }> {
  // NEVER throw into the caller: this runs post-commit, OUT of the payment tx, so a
  // failure here must neither roll back the (already-committed) money tx nor abort
  // the sync-hook's loop over the other owner-months. Swallow + console.error — the
  // un-forwarded allocation event stays detectable by R5 reconciliation.
  try {
    return await collectFrozenMonthForward(actor, ownerPartyId, frozenMonth);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[owner-ledger.prior-period-collection] forward collection failed (swallowed):", e);
    return { posted: 0 };
  }
}

async function collectFrozenMonthForward(
  actor: OwnerLedgerActorCtx,
  ownerPartyId: string,
  frozenMonth: string,
): Promise<{ posted: number }> {
  const db = getDb();
  const [fy, fm] = frozenMonth.split("-").map(Number);
  const frozenStart = new Date(Date.UTC(fy!, fm! - 1, 1));
  const nextMonthStart = new Date(Date.UTC(fy!, fm!, 1));
  const now = new Date();
  const curMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  // The immutable freeze timestamp is the ONLY reliable boundary between cash that
  // is already in the frozen collected figure (createdAt <= firstFrozenAt) and cash
  // that must post forward. A period frozen BEFORE the manifest feature shipped has
  // no firstFrozenAt (spec R7 / Open-Questions "no backfill"): return early — the
  // fail-closed preflight + R5 reconciliation cover that legacy period, and guessing
  // a boundary here could double-credit or lose owner money.
  const period = await findPeriod(actor.orgId, { ownerPartyId, apartmentId: null, periodMonth: frozenStart });
  const firstFrozenAt = period?.firstFrozenAt ?? null;
  if (!firstFrozenAt) return { posted: 0 };

  // Self-discover the owner's charges billed in the frozen month — owner resolved
  // via unit.ownerPartyId / carpark.ownerPartyId (mirrors syncOwnerLedgerForCharges).
  //
  // Bug-1 fix (review C1): INCLUDE void/credited charges. The money is driven off the
  // append-only ALLOCATION EVENT stream (PaymentAllocation + PaymentAllocationReversal),
  // which is INDEPENDENT of charge status — voiding/crediting a charge does NOT emit a
  // PaymentAllocationReversal (verified: billing.service voidChargeService + credit-notes
  // credited path only flip Charge.status + zero outstanding; the reversal is a separate
  // event from reverseAllocationInTx / correction-replace). If a post-freeze allocation
  // was collected forward here and the charge is LATER voided while its bounce/reroute
  // emits a PaymentAllocationReversal, excluding void/credited stranded that reversal
  // EVENT → the +collection was never clawed back → owner silently OVER-CREDITED. Each
  // event still yields exactly one forward row keyed on sourceAllocationEventId, so
  // idempotency is unchanged. Disjointness with postForwardReversalForFrozenMonth is now
  // kept by MONEY, not status: that sibling nets off the collection-reversals THIS flow
  // posts (frozen_collected − Σ prior_period_collection_reversal), and the sync-hook runs
  // this flow FIRST so the netting sees them within one fire.
  const charges = await db.charge.findMany({
    where: {
      organizationId: actor.orgId,
      billingMonth: { gte: frozenStart, lt: nextMonthStart },
      OR: [{ unit: { ownerPartyId } }, { carpark: { ownerPartyId } }],
    },
    select: { id: true },
  });
  if (charges.length === 0) return { posted: 0 };

  // Which allocations the owner has ALREADY been credited for, for every charge at
  // once. Hoisted out of the per-charge loop deliberately: this function runs
  // post-commit on EVERY payment settlement (afterPaymentSettled → sync-hook), and
  // an owner can hold dozens of charges in one frozen month — one query per charge
  // multiplied that fan-out by the loop. OwnerLedgerEntry has no index on
  // sourceChargeId, so each of those reads scanned the owner's whole ledger
  // history; doing it once is the difference that matters, not the index.
  // Mirrors the batched shape preflight.ts already uses for the same question.
  const chargeIds = charges.map((c) => c.id);
  const persistedCredits = await db.ownerLedgerEntry.findMany({
    where: {
      organizationId: actor.orgId,
      ownerPartyId,
      sourceChargeId: { in: chargeIds },
      sourceType: "prior_period_collection",
      status: "active",
    },
    select: { sourceChargeId: true, sourceAllocationEventId: true },
  });
  const persistedCreditsByCharge = new Map<string, Set<string>>();
  for (const c of persistedCredits) {
    if (!c.sourceChargeId || !c.sourceAllocationEventId) continue;
    let forCharge = persistedCreditsByCharge.get(c.sourceChargeId);
    if (!forCharge) {
      forCharge = new Set();
      persistedCreditsByCharge.set(c.sourceChargeId, forCharge);
    }
    forCharge.add(c.sourceAllocationEventId);
  }

  const rows: Prisma.OwnerLedgerEntryCreateManyInput[] = [];
  for (const charge of charges) {
    // Inherit direction/paidBy/includeInPayout/category/property context from the
    // charge's frozen-month NORMAL row. No baseline → skip (R5 reconciliation flags it).
    const normal = await db.ownerLedgerEntry.findFirst({
      where: {
        organizationId: actor.orgId,
        ownerPartyId,
        statementMonth: frozenStart,
        sourceChargeId: charge.id,
        status: "active",
        sourceType: { notIn: FORWARD_SOURCE_TYPES },
      },
    });
    if (!normal) {
      // No frozen-month baseline to inherit from (e.g. a charge never materialised
      // before freeze). Skip — durable detection is R5 reconciliation's job; the
      // console.warn is only operational breadcrumbs (never a money decision).
      // eslint-disable-next-line no-console
      console.warn(`[owner-ledger.prior-period-collection] no frozen normal row for charge ${charge.id} (${frozenMonth}); skipped — reconciliation will flag`);
      continue;
    }

    // Shared row shell — every forward row inherits the normal row's owner
    // attribution + payout treatment; only paymentStatus is forced "paid" (this is
    // realized cash, NOT the frozen row's pending/partial state).
    const base = {
      organizationId: actor.orgId,
      ownerPartyId,
      propertyId: normal.propertyId,
      apartmentId: normal.apartmentId,
      listingId: normal.listingId,
      tenancyId: normal.tenancyId,
      statementMonth: curMonth,
      sstAmount: null,
      paidBy: normal.paidBy,
      paymentStatus: "paid",
      includeInPayout: normal.includeInPayout,
      category: normal.category,
      sourceChargeId: charge.id,
      status: "active",
      createdById: actor.actorUserId,
      updatedById: actor.actorUserId,
    } satisfies Partial<Prisma.OwnerLedgerEntryCreateManyInput>;

    // One fetch serves BOTH legs, but they answer DIFFERENT questions — the whole
    // subtlety of this function, and the source of two separate money bugs.
    //
    // Fetch is UNFILTERED on payment status. Payment status is the wrong
    // discriminator for the reversal leg: it says whether money ever ARRIVED, not
    // whether the owner was ever CREDITED. Those differ in both directions —
    //   • filtering to `posted` hid VOIDED allocations, so a bounced cheque never
    //     clawed back and the owner kept credit for money the org returned;
    //   • widening to posted|void|refunded then let a reversal on a never-credited
    //     allocation post a clawback against nothing, DEBITING the owner RM800 out
    //     of thin air. Reachable with no failure at all: reverseAllocationInTx
    //     writes the reversal row UNCONDITIONALLY and only consults
    //     payment.status afterwards, to decide whether to restore the charge
    //     (payments.repository.ts:819); correction-replace reads a charge's
    //     allocations with no payment filter at all.
    // The ledger's own rows are the authority — see recognisedCreditAllocIds below.
    const allAllocations = await db.paymentAllocation.findMany({
      where: { organizationId: actor.orgId, chargeId: charge.id },
      // Explicit select, not include: these rows are held in a Map for the whole
      // charge and only five fields are ever read. `include` dragged every column
      // along for the ride.
      select: {
        id: true,
        createdAt: true,
        allocatedAt: true,
        allocatedAmount: true,
        payment: { select: { status: true } },
      },
    });

    // The CREDIT leg still asks "is this cash now" — only settled money may post a
    // (+) row. An unverified or refused slip settles nothing.
    const cashAllocations = allAllocations.filter((a) => a.payment.status === CASH_PAYMENT_STATUS);

    // Which allocations the owner has actually been credited for. A clawback may
    // only net against credit that EXISTS:
    //   • post-freeze allocation → an active `prior_period_collection` keyed to it
    //     (already persisted by an earlier run, or queued in `rows` by this one);
    //   • pre-freeze allocation → the frozen collected figure IS the credit, so it
    //     always qualifies (handled at the use site, not here).
    //
    // COPY, never the map's own Set: the loop below adds this run's queued credit to
    // it, and handing out the shared instance would leak one charge's in-run credit
    // into the next charge's gate — re-opening the exact "clawback nets against
    // credit that isn't its own" hole this gate exists to close.
    const recognisedCreditAllocIds = new Set(persistedCreditsByCharge.get(charge.id) ?? []);

    // Each post-freeze allocation EVENT → one prior_period_collection (+, SAME
    // direction). Allocations at/BEFORE firstFrozenAt are already in the frozen
    // collected figure, so only strictly-after events post forward.
    for (const a of cashAllocations) {
      if (!(a.createdAt > firstFrozenAt)) continue;
      rows.push({
        ...base,
        transactionDate: a.allocatedAt, // the actual received date
        direction: normal.direction, // preserve — NOT flipped
        description: `Prior-period collection: ${normal.category} (from ${frozenMonth})`,
        amount: a.allocatedAmount,
        sourceType: "prior_period_collection",
        sourceAllocationEventId: a.id, // NON-NULL — the idempotency key
      });
      // Credit queued in THIS run counts as recognised: a payment posted and then
      // voided between two runs must still claw back, and both rows land together
      // in the createMany below.
      recognisedCreditAllocIds.add(a.id);
    }

    // Each post-freeze reversal EVENT → one prior_period_collection_reversal (−,
    // OPPOSITE direction) so it nets against the collection. A reroute = reverse +
    // new allocation, so reversals are event-sourced exactly like allocations.
    const oppDirection = normal.direction === "income" ? "expense" : "income";
    const allocById = new Map(allAllocations.map((a) => [a.id, a]));
    const allocIds = allAllocations.map((a) => a.id);
    const reversals = allocIds.length
      ? await db.paymentAllocationReversal.findMany({
          where: { organizationId: actor.orgId, originalAllocationId: { in: allocIds }, createdAt: { gt: firstFrozenAt } },
        })
      : [];
    for (const r of reversals) {
      // GATE: only claw back credit that exists. A pre-freeze allocation's credit
      // is the frozen collected figure (immutable, always there). A post-freeze
      // one must have an active prior_period_collection keyed to it — otherwise
      // this (−) would have no (+) anywhere to net against and would debit the
      // owner out of nothing.
      //
      // No cap needed on top: reverseAllocationInTx bounds each reversal at the
      // allocation's remaining effective amount, and voidPaymentTx reverses the
      // applied amount once, so Σ reversals for an allocation can never exceed the
      // credit posted for it.
      const alloc = allocById.get(r.originalAllocationId);
      if (!alloc) continue; // reversal for another charge's allocation — not ours
      const creditIsFrozen = !(alloc.createdAt > firstFrozenAt);
      if (!creditIsFrozen && !recognisedCreditAllocIds.has(alloc.id)) continue;
      rows.push({
        ...base,
        transactionDate: r.createdAt, // when the reversal was recorded
        direction: oppDirection,
        description: `Prior-period collection reversal: ${normal.category} (from ${frozenMonth})`,
        amount: r.amount,
        sourceType: "prior_period_collection_reversal",
        sourceAllocationEventId: r.id, // NON-NULL — the idempotency key
      });
    }
  }

  if (rows.length === 0) return { posted: 0 };
  const res = await db.ownerLedgerEntry.createMany({ data: rows, skipDuplicates: true });
  return { posted: res.count };
}
