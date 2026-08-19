/**
 * R9/R10 — executable enablement preflight.
 *
 * A READ-ONLY check that decides whether ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER is
 * safe to enable. It runs INDEPENDENT of that flag (spec R10) — it never references it,
 * writes nothing, and only reads the reconciliation runs/findings, the frozen periods,
 * and the payment-allocation event stream. `pass:true` ONLY when ALL hold; each failing
 * condition contributes a specific `reasons[]` entry.
 */
import { getDb } from "@kason/db";
import { CASH_ALLOCATION_WHERE, CASH_PAYMENT_STATUS } from "@kason/shared";
import { FORWARD_SOURCE_TYPES } from "../owner-ledger.types";
import { findPerUnitFrozenWithoutCombined } from "./period-scope-invariants";

export type PreflightCheckType = "source_to_ledger" | "frozen_integrity";

const CHECK_TYPES: readonly PreflightCheckType[] = ["source_to_ledger", "frozen_integrity"];

/**
 * Preflight recency window: a full-scope `completed` run of each reconciliation type must
 * have completed within this window to count as fresh. Default 24h per the spec Open
 * Questions ("Preflight recency window" — a full-scope completed run of each type within
 * the last 24h counts as fresh; older = stale → preflight fails).
 */
export const PREFLIGHT_RECENCY_WINDOW_HOURS = 24;

/**
 * Documented known gaps surfaced to the operator on EVERY preflight result (a green
 * preflight is not a clean bill of health for these). Kept explicit so enablement is an
 * informed decision, not a silent one.
 */
export const PREFLIGHT_KNOWN_LIMITATIONS: readonly string[] = [
  "R5 source-to-ledger does not yet cover statement EXPENSE charges (mgmt fee/cleaning/maintenance) — needs an expectedStatementLedgerRows() sync extract",
  "the closed-period guard is not wired into post-monthly-rent (rent cron targets the current month; owner not resolved in-hand)",
];

function firstOfMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

/**
 * Condition 4 — count unposted paid-after-freeze collections. The DIRECT complement of
 * the R3 forward-collection flow (`postPriorPeriodCollections`): for each combined-scope
 * (`apartmentId=null`) frozen period WITH a freeze boundary (`firstFrozenAt`), take the
 * owner's charges billed into the frozen month (owner via `unit`/`carpark`), then every
 * allocation EVENT created strictly after the freeze must carry a matching active
 * `prior_period_collection` row. Any post-freeze allocation with no active forward row
 * = one unposted collection.
 *
 * ⚠️ The charge selection below EXCLUDES void/credited, which R3's does NOT — R3's
 * Bug-1 fix deliberately includes them so a later-voided charge's reversal event is
 * never stranded. (An earlier version of this comment claimed the two selections
 * matched; they do not.) The gap is covered on purpose by condition 6,
 * countOrphanedVoidForwardCollections — see its docstring.
 */
async function countUnpostedPaidAfterFreeze(orgId: string): Promise<number> {
  const db = getDb();
  const periods = await db.ownerStatementPeriod.findMany({
    where: { organizationId: orgId, status: "frozen", apartmentId: null, firstFrozenAt: { not: null } },
    select: { ownerPartyId: true, periodMonth: true, firstFrozenAt: true },
  });

  let unposted = 0;
  for (const period of periods) {
    const firstFrozenAt = period.firstFrozenAt as Date;
    const frozenStart = firstOfMonth(period.periodMonth);
    const nextMonthStart = new Date(Date.UTC(frozenStart.getUTCFullYear(), frozenStart.getUTCMonth() + 1, 1));
    const ownerPartyId = period.ownerPartyId;

    const charges = await db.charge.findMany({
      where: {
        organizationId: orgId,
        billingMonth: { gte: frozenStart, lt: nextMonthStart },
        status: { notIn: ["void", "credited"] },
        OR: [{ unit: { ownerPartyId } }, { carpark: { ownerPartyId } }],
      },
      select: { id: true },
    });
    if (charges.length === 0) continue;
    const chargeIds = charges.map((c) => c.id);

    // Allocation EVENTS on those charges created strictly AFTER the freeze boundary
    // (`> firstFrozenAt`, matching R3 — at/before-freeze cash is already in the frozen figure).
    //
    // This condition is the NET that catches prior-period-collection going wrong,
    // so it must enumerate exactly the events R3 is obliged to post — no more, no
    // fewer. Over-enumerating is not "safely strict": it reports a discrepancy
    // against a correct ledger and blocks enablement on a phantom.
    const allocations = await db.paymentAllocation.findMany({
      where: { organizationId: orgId, chargeId: { in: chargeIds } },
      select: { id: true, chargeId: true, createdAt: true, payment: { select: { status: true } } },
    });
    // Collection leg: only settled cash owes a (+) row.
    const postFreezeAllocIds = allocations
      .filter((a) => a.createdAt > firstFrozenAt && a.payment.status === CASH_PAYMENT_STATUS)
      .map((a) => a.id);

    // Reversal EVENTS on ANY of these charges' allocations (a reversal may target a
    // PRE-freeze allocation, so span all of them — mirrors R3) created after the freeze.
    //
    // Gated on RECOGNISED CREDIT, exactly as R3 gates its own posting: a clawback
    // is only owed where credit exists — the frozen figure for a pre-freeze
    // allocation, or an active prior_period_collection for a post-freeze one. A
    // reversal on a never-credited allocation legitimately posts nothing, so
    // counting it here would be a false positive.
    // ownerPartyId included to mirror R3's query exactly — these two are meant to
    // ask the identical question, and a reader comparing them should not have to
    // work out whether the difference was meaningful.
    const persistedCredits = allocations.length
      ? await db.ownerLedgerEntry.findMany({
          where: {
            organizationId: orgId,
            ownerPartyId,
            sourceChargeId: { in: chargeIds },
            sourceType: "prior_period_collection",
            status: "active",
          },
          select: { sourceAllocationEventId: true },
        })
      : [];
    const creditedAllocIds = new Set(
      persistedCredits.map((c) => c.sourceAllocationEventId).filter((x): x is string => x !== null),
    );
    // KNOWN, deliberate divergence from R3: R3 also recognises credit it QUEUES in
    // the same run, so for a post-freeze cash allocation R3 has not processed yet
    // plus a reversal on it, R3 will post 2 rows where this counts 1. That makes the
    // number in `reasons[]` an under-count, never a fail-open: the allocation itself
    // is always counted by postFreezeAllocIds above, so the condition still trips and
    // the gate still blocks. Do NOT "fix" it by seeding this set from post-freeze cash
    // allocations — that would count clawbacks for credit no run has posted yet, which
    // is the false positive the gate on recognised credit exists to prevent.
    const clawbackEligibleAllocIds = allocations
      .filter((a) => !(a.createdAt > firstFrozenAt) || creditedAllocIds.has(a.id))
      .map((a) => a.id);

    const reversals = clawbackEligibleAllocIds.length
      ? await db.paymentAllocationReversal.findMany({
          where: { organizationId: orgId, originalAllocationId: { in: clawbackEligibleAllocIds }, createdAt: { gt: firstFrozenAt } },
          select: { id: true },
        })
      : [];
    const reversalIds = reversals.map((r) => r.id);

    const eventIds = [...postFreezeAllocIds, ...reversalIds];
    if (eventIds.length === 0) continue;

    // A forward row counts as POSTED only when it is ACTIVE: R3 dedupes on the idempotency
    // key via skipDuplicates, so a later-voided forward row is never re-posted → the cash
    // is dropped and the event must re-flag as unposted (fail-closed).
    const forwardRows = await db.ownerLedgerEntry.findMany({
      where: {
        organizationId: orgId,
        status: "active",
        sourceType: { in: ["prior_period_collection", "prior_period_collection_reversal"] },
        sourceAllocationEventId: { in: eventIds },
      },
      select: { sourceAllocationEventId: true },
    });
    const posted = new Set(forwardRows.map((r) => r.sourceAllocationEventId));
    for (const id of eventIds) if (!posted.has(id)) unposted += 1;
  }
  return unposted;
}

/** Integer cents from a Decimal-like amount magnitude. */
function amtC(x: { toString(): string }): number {
  return Math.round(Number(x.toString()) * 100);
}

/**
 * Condition 6 (review C1/Scen2 safety net) — count VOID/credited frozen-month charges
 * whose forward booking is out of balance. countUnpostedPaidAfterFreeze EXCLUDES
 * void/credited charges (mirroring R3's selection), so an orphaned prior_period_collection
 * stranded when a forwarded charge is later voided (Bug 1 over-credit), or a
 * double-reversal (Bug 2 under-credit), is invisible to it → false-pass. This complement
 * asserts, for each such charge carrying forward rows, that the total booked stays within
 * [0, current_effective_allocated]:
 *   booked = frozen_collected + Σppc − Σppc_reversal − Σreversal   (integer cents)
 * booked < 0 (under-credit) or booked > effective_allocated (over-credit) ⇒ one orphan.
 */
async function countOrphanedVoidForwardCollections(orgId: string): Promise<number> {
  const db = getDb();
  const periods = await db.ownerStatementPeriod.findMany({
    where: { organizationId: orgId, status: "frozen", apartmentId: null, firstFrozenAt: { not: null } },
    select: { ownerPartyId: true, periodMonth: true },
  });

  let orphaned = 0;
  for (const period of periods) {
    const frozenStart = firstOfMonth(period.periodMonth);
    const nextMonthStart = new Date(Date.UTC(frozenStart.getUTCFullYear(), frozenStart.getUTCMonth() + 1, 1));
    const ownerPartyId = period.ownerPartyId;

    const charges = await db.charge.findMany({
      where: {
        organizationId: orgId,
        billingMonth: { gte: frozenStart, lt: nextMonthStart },
        status: { in: ["void", "credited"] },
        OR: [{ unit: { ownerPartyId } }, { carpark: { ownerPartyId } }],
      },
      select: { id: true },
    });
    for (const charge of charges) {
      const fwd = await db.ownerLedgerEntry.findMany({
        where: {
          organizationId: orgId,
          ownerPartyId,
          sourceChargeId: charge.id,
          status: "active",
          sourceType: { in: ["prior_period_collection", "prior_period_collection_reversal", "reversal", "reversal_forward_adjustment"] },
        },
        select: { amount: true, sourceType: true, direction: true },
      });
      if (fwd.length === 0) continue; // no forward rows → nothing to balance for this charge

      // frozen_collected = the active frozen-month normal row amount (immutable snapshot;
      // post-freeze tampering of it is frozen-integrity/R6's domain, not this gate's).
      const normal = await db.ownerLedgerEntry.findFirst({
        where: {
          organizationId: orgId,
          ownerPartyId,
          statementMonth: frozenStart,
          sourceChargeId: charge.id,
          status: "active",
          sourceType: { notIn: FORWARD_SOURCE_TYPES },
        },
        select: { amount: true, direction: true },
      });
      const frozenCollectedC = normal ? amtC(normal.amount) : 0;
      // The reversal canonical (holdback) direction is OPPOSITE the frozen normal row: an income
      // charge holds back with an EXPENSE, an owner EXPENSE charge (e.g. a voided management_fee)
      // holds back with INCOME. This gate scans ALL charge types (unlike R5, which is income-only),
      // so the sign MUST follow the normal's direction — hardcoding "expense=+" would invert the
      // reversal of a void expense charge into a false orphan. Default income when the normal row
      // is absent (no normal ⇒ no reversal family in practice; the sum is 0 regardless).
      const reversalDir = (normal?.direction ?? "income") === "income" ? "expense" : "income";
      let ppcC = 0;
      let ppcRevC = 0;
      let revC = 0;
      for (const r of fwd) {
        const c = amtC(r.amount);
        if (r.sourceType === "prior_period_collection") ppcC += c;
        else if (r.sourceType === "prior_period_collection_reversal") ppcRevC += c;
        // Reversal FAMILY (write-once `reversal` + forward `reversal_forward_adjustment` rows),
        // summed SIGNED in the holdback direction (reversalDir → +, a give-back in the original
        // direction → −). Keeps the identity exact across frozen months AND across income/expense.
        else revC += r.direction === reversalDir ? c : -c;
      }
      const bookedC = frozenCollectedC + ppcC - ppcRevC - revC;

      // current_effective_allocated = Σ PaymentAllocation − Σ PaymentAllocationReversal.
      // CASH_ALLOCATION_WHERE — this is the LEFT side of the R5 identity ("what the
      // charge says was collected"). Counting unsettled allocations here inflates it
      // and manufactures a mismatch against a correct ledger.
      //
      // ⚠️ DELIBERATELY plain posted-only, unlike countUnpostedPaidAfterFreeze
      // above — do not "fix" this to match it. An allocation and its reversals
      // drop together here, netting 0, which is the correct effective figure for
      // a voided payment. Same reasoning as source-to-ledger's effectiveAllocatedC.
      const allocs = await db.paymentAllocation.findMany({ where: { organizationId: orgId, chargeId: charge.id, ...CASH_ALLOCATION_WHERE }, select: { id: true, allocatedAmount: true } });
      const allocIds = allocs.map((a) => a.id);
      const revs = allocIds.length
        ? await db.paymentAllocationReversal.findMany({ where: { organizationId: orgId, originalAllocationId: { in: allocIds } }, select: { amount: true } })
        : [];
      const effC = allocs.reduce((s, a) => s + amtC(a.allocatedAmount), 0) - revs.reduce((s, r) => s + amtC(r.amount), 0);

      // Net band AND the exact reversal identity (holdback rule) — the forward `reversal`
      // must hold back ALL owner-recognised cash for a void/credited charge:
      //   revC == max(0, frozen_collected + Σppc − Σppc_reversal)
      // A void charge that collected cash post-freeze but was never held back sits at
      // booked == effAlloc (band passes), so only this identity's +Σppc term fails it closed.
      const targetRevC = Math.max(0, frozenCollectedC + ppcC - ppcRevC);
      if (bookedC < 0 || bookedC > effC || revC !== targetRevC) orphaned += 1;
    }
  }
  return orphaned;
}

/**
 * Condition 7 (review row 4) — count FROZEN per-unit periods (apartmentId != null) that
 * lack a FROZEN combined period (apartmentId = null) for the same owner-month. The
 * closed-period write guard (assertPeriodOpen) and the R5/R6 reconciliation checks are
 * COMBINED-scope only, so a per-unit period frozen without its combined sibling (reachable
 * via a lazy per-unit portal freeze, or a cron combined-freeze failure) is neither guarded
 * against post-freeze writes nor scanned for drift. Fail-closed at enablement until the
 * combined period is also frozen, restoring the "per-unit frozen ⇒ combined frozen"
 * invariant the guard/reconciliation assume.
 */
async function countPerUnitFrozenWithoutCombined(orgId: string): Promise<number> {
  // Delegates to the SHARED invariant helper (also used by R6 frozen-integrity to open a
  // durable finding) so the preflight count and the recon finding set never diverge.
  return (await findPerUnitFrozenWithoutCombined(orgId)).length;
}

export interface EnablementPreflightResult {
  pass: boolean;
  reasons: string[];
  checks: {
    recencyWindowHours: number;
    runs: Record<PreflightCheckType, { satisfied: boolean; latestCompletedAt: string | null }>;
    openCriticalFindings: Record<PreflightCheckType, number>;
    unpostedPaidAfterFreeze: number;
    orphanedForwardCollections: number;
    frozenPeriodsMissingManifest: number;
    perUnitFrozenWithoutCombined: number;
  };
  limitations: string[];
}

export async function runEnablementPreflight(ctx: { orgId: string }): Promise<EnablementPreflightResult> {
  const db = getDb();
  const orgId = ctx.orgId;
  const reasons: string[] = [];
  const cutoff = new Date(Date.now() - PREFLIGHT_RECENCY_WINDOW_HOURS * 60 * 60 * 1000);

  // 1 — recency: a full-scope `completed` run of EACH reconciliation type within window.
  const runs = {} as Record<PreflightCheckType, { satisfied: boolean; latestCompletedAt: string | null }>;
  for (const type of CHECK_TYPES) {
    const latest = await db.ownerLedgerReconciliationRun.findFirst({
      where: { organizationId: orgId, reconciliationType: type, status: "completed", isFullScope: true, completedAt: { not: null } },
      orderBy: { completedAt: "desc" },
      select: { completedAt: true },
    });
    // A run counts ONLY when its completedAt is within the recency window; an older
    // (stale) completed full-scope run is found but does NOT satisfy.
    const satisfied = !!latest?.completedAt && latest.completedAt.getTime() >= cutoff.getTime();
    runs[type] = { satisfied, latestCompletedAt: latest?.completedAt?.toISOString() ?? null };
    if (!satisfied) {
      reasons.push(`No full-scope completed ${type} run within the last ${PREFLIGHT_RECENCY_WINDOW_HOURS}h`);
    }
  }

  // 2/3 — zero unresolved critical findings of EACH check kind (open counts; only
  // resolved/ignored clear — acknowledged is still unresolved).
  const openCriticalFindings = {} as Record<PreflightCheckType, number>;
  for (const kind of CHECK_TYPES) {
    const count = await db.ownerLedgerReconciliationFinding.count({
      where: { organizationId: orgId, checkKind: kind, severity: "critical", status: { in: ["open", "acknowledged"] } },
    });
    openCriticalFindings[kind] = count;
    if (count > 0) {
      reasons.push(`${count} unresolved critical ${kind} finding(s)`);
    }
  }

  // 4 — no unposted paid-after-freeze collections (direct complement of R3).
  const unpostedPaidAfterFreeze = await countUnpostedPaidAfterFreeze(orgId);
  if (unpostedPaidAfterFreeze > 0) {
    reasons.push(`${unpostedPaidAfterFreeze} unposted paid-after-freeze collection(s)`);
  }

  // 6 — no orphaned forward collection on a void/credited charge (review C1/Scen2 safety
  // net; the complement of condition 4, which excludes void/credited charges).
  const orphanedForwardCollections = await countOrphanedVoidForwardCollections(orgId);
  if (orphanedForwardCollections > 0) {
    reasons.push(`${orphanedForwardCollections} orphaned forward collection(s) on void/credited charge(s)`);
  }

  // 5 — no frozen period lacking a manifest (fail-closed): a period frozen before the
  // manifest feature has no firstFrozenAt baseline → integrity unknown.
  const frozenPeriodsMissingManifest = await db.ownerStatementPeriod.count({
    where: { organizationId: orgId, status: "frozen", firstFrozenAt: null },
  });
  if (frozenPeriodsMissingManifest > 0) {
    reasons.push(`${frozenPeriodsMissingManifest} frozen period(s) lacking a freeze manifest`);
  }

  // 7 — no per-unit frozen period without a frozen combined sibling (review row 4): the
  // write guard + R5/R6 are combined-scope only, so such a period is unguarded/unscanned.
  const perUnitFrozenWithoutCombined = await countPerUnitFrozenWithoutCombined(orgId);
  if (perUnitFrozenWithoutCombined > 0) {
    reasons.push(`${perUnitFrozenWithoutCombined} frozen per-unit period(s) without a frozen combined period (guard/reconciliation are combined-scope)`);
  }

  return {
    pass: reasons.length === 0,
    reasons,
    checks: {
      recencyWindowHours: PREFLIGHT_RECENCY_WINDOW_HOURS,
      runs,
      openCriticalFindings,
      unpostedPaidAfterFreeze,
      orphanedForwardCollections,
      frozenPeriodsMissingManifest,
      perUnitFrozenWithoutCombined,
    },
    limitations: [...PREFLIGHT_KNOWN_LIMITATIONS],
  };
}
