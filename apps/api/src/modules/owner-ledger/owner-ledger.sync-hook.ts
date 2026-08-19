/**
 * Owner-ledger sync follow-on (Phase 1). Deliberately mirrors
 * payments/payments.owner-notify.ts: runs OUT of the caller's transaction and
 * SWALLOWS every error so an owner-ledger sync failure can NEVER roll back a
 * money transaction (draft save / charge / payment). Callers fire these AFTER
 * their tx commits. The actual ledger write is the existing idempotent
 * syncMonthService (it opens its own tx).
 */
import { getDb } from "@kason/db";
import type { Prisma } from "@kason/db";
import { recordAudit } from "../../lib/audit";
import { isPhase2FlagEnabled } from "../../lib/feature-flags";
import { findPeriod } from "../owner-billing/owner-statement-period.repository";
import { postForwardReversalForFrozenMonth, syncMonthService } from "./owner-ledger.sync";
import { postPriorPeriodCollections } from "./prior-period-collection";
import type { OwnerLedgerActorCtx } from "./owner-ledger.types";

// NOTE: OwnerLedgerActorCtx uses actorUserId + actorRole, NOT userId + role.
// Verified from owner-ledger.types.ts:16.
function systemActor(orgId: string, userId: string, role: string): OwnerLedgerActorCtx {
  // role originates from the authenticated session (typed `string`); at runtime it is
  // always one of the OwnerLedgerActorCtx roles, so assert at this single boundary.
  return { orgId, actorUserId: userId, actorRole: role as OwnerLedgerActorCtx["actorRole"] };
}

const monthOf = (d: Date): string => d.toISOString().slice(0, 7); // "YYYY-MM"

/**
 * Append a DURABLE, queryable marker (action:"owner_ledger.sync_failed",
 * entityType:"OwnerLedgerEntry") to AuditLog so a swallowed owner-ledger sync
 * failure leaves a detectable trace of statement drift instead of vanishing into a
 * lone console.error. Best-effort: wrapped in its OWN try/catch so an audit-write
 * failure can NEVER re-throw into the money-path caller (the sync stays
 * non-blocking, and still NEVER rolls back the money transaction). recordAudit
 * requires a TransactionClient, so we open a dedicated tx here — this is NOT part
 * of the original money transaction (which already committed before these hooks
 * run); it only records the failure.
 */
async function recordSyncFailure(
  orgId: string,
  userId: string,
  role: string,
  entityId: string,
  meta: Prisma.InputJsonObject,
): Promise<void> {
  try {
    const db = getDb();
    await db.$transaction((tx) =>
      recordAudit(tx, {
        organizationId: orgId,
        actorUserId: userId,
        actorRole: role,
        action: "owner_ledger.sync_failed",
        entityType: "OwnerLedgerEntry",
        entityId,
        meta,
      }),
    );
  } catch (auditErr) {
    console.error("[owner-ledger.sync-hook] failed to record sync_failed audit (swallowed):", auditErr);
  }
}

/** Sync the owner-ledger month for the owner of `apartmentId`. Never throws. */
export async function syncOwnerLedgerForApartmentMonth(
  orgId: string,
  userId: string,
  role: string,
  apartmentId: string,
  periodMonth: Date,
): Promise<void> {
  if (!isPhase2FlagEnabled("ENABLE_PHASE2_OWNER_BILLING")) return;
  // Hoisted so the catch can attribute a sync failure to the resolved owner.
  let ownerPartyId: string | null = null;
  try {
    const db = getDb();
    const apt = await db.apartment.findFirst({
      where: { id: apartmentId, organizationId: orgId },
      select: { listings: { where: { listingStatus: { not: "archived" } }, select: { ownerPartyId: true } } },
    });
    ownerPartyId = apt?.listings.find((l) => l.ownerPartyId)?.ownerPartyId ?? null;
    if (!ownerPartyId) return;
    await syncMonthService(systemActor(orgId, userId, role), { ownerPartyId, month: monthOf(periodMonth) });
  } catch (e) {
    console.error("[owner-ledger.sync-hook] apartment-month sync failed (swallowed):", e);
    // Durable drift marker — anchor to the owner if resolved, else the apartment.
    await recordSyncFailure(orgId, userId, role, ownerPartyId ?? apartmentId, {
      month: monthOf(periodMonth),
      error: (e as Error).message,
      apartmentId,
      ownerPartyId,
    });
  }
}

/**
 * Sync the owner-ledger month for a KNOWN owner directly (owner + first-of-month
 * Date in hand). Use when the caller has the ownerPartyId already and the charge(s)
 * that triggered the re-sync may carry NO unitId — e.g. an ad-hoc owner-statement
 * ADJUSTMENT (fire insurance paid on behalf). syncOwnerLedgerForCharges discovers the
 * (owner, month) pair via charge.unit.ownerPartyId, so a unit-less adjustment charge
 * would silently skip the sync (the expense would never book → payout overstated);
 * this hook bypasses that discovery. Mirrors syncOwnerLedgerForApartmentMonth's
 * swallow-and-record-drift contract: flag-gated, opens its own tx (via
 * syncMonthService), NEVER throws — it can never roll back the caller's money tx.
 */
export async function syncOwnerLedgerForOwnerMonth(
  orgId: string,
  userId: string,
  role: string,
  ownerPartyId: string,
  periodMonth: Date,
): Promise<void> {
  if (!isPhase2FlagEnabled("ENABLE_PHASE2_OWNER_BILLING")) return;
  const month = monthOf(periodMonth);
  try {
    await syncMonthService(systemActor(orgId, userId, role), { ownerPartyId, month });
  } catch (e) {
    console.error("[owner-ledger.sync-hook] owner-month sync failed (swallowed):", e);
    await recordSyncFailure(orgId, userId, role, ownerPartyId, {
      month,
      error: (e as Error).message,
      ownerPartyId,
    });
  }
}

/** Sync the owner-ledger month(s) for the owners behind the given charges. Never throws. */
export async function syncOwnerLedgerForCharges(
  orgId: string,
  userId: string,
  role: string,
  chargeIds: string[] | null | undefined,
): Promise<void> {
  if (!isPhase2FlagEnabled("ENABLE_PHASE2_OWNER_BILLING")) return;
  if (!chargeIds || chargeIds.length === 0) return;
  // Track the (owner, month) currently syncing so the catch can attribute a failure.
  let currentOwnerPartyId: string | null = null;
  let currentMonth: string | null = null;
  try {
    const db = getDb();
    const charges = await db.charge.findMany({
      where: { organizationId: orgId, id: { in: chargeIds } },
      select: {
        billingMonth: true,
        unit: { select: { ownerPartyId: true } },
        // Task 4.4: carpark charges (carparkId set, unitId null) must resolve their
        // owner via Carpark.ownerPartyId so a payment on a bay's charge re-syncs
        // the BAY's owner's ledger (not the room owner, who is on unit.ownerPartyId).
        carpark: { select: { ownerPartyId: true } },
      },
    });
    const pairs = new Map<string, Set<string>>();
    for (const c of charges) {
      const owner = c.unit?.ownerPartyId ?? c.carpark?.ownerPartyId ?? null;
      if (!owner || !c.billingMonth) continue;
      if (!pairs.has(owner)) pairs.set(owner, new Set());
      pairs.get(owner)!.add(monthOf(c.billingMonth));
    }
    const actor = systemActor(orgId, userId, role);
    for (const [ownerPartyId, months] of pairs) {
      for (const month of months) {
        currentOwnerPartyId = ownerPartyId;
        currentMonth = month;
        // Task 7: a FROZEN month is immutable — do NOT rebuild it. Post the
        // correction FORWARD as a reversing entry in the current open month.
        // Flag-gated: with the live-ledger flag off this is byte-identical to
        // today (no findPeriod read, always the normal syncMonthService path).
        const mStart = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5) - 1, 1));
        const frozen =
          isPhase2FlagEnabled("ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER") &&
          (await findPeriod(orgId, { ownerPartyId, apartmentId: null, periodMonth: mStart }))?.status === "frozen";
        if (frozen) {
          // ORDER MATTERS (review Scen2 / Bug 2): collections FIRST, forward-reversal
          // SECOND. postPriorPeriodCollections books a prior_period_collection_reversal
          // for every post-freeze PaymentAllocationReversal (append-only events,
          // independent of charge status); postForwardReversalForFrozenMonth then
          // reverses only the REMAINDER of the frozen collected figure
          // (frozen_collected − Σ prior_period_collection_reversal). Running collections
          // first means that netting sees the just-posted reversals within ONE fire, so a
          // payment-reversal + a void landing before a single hook fire reverse the frozen
          // cash EXACTLY ONCE (never twice). Both swallow their own errors (never throw),
          // so neither can abort this loop nor roll back the already-committed money tx.
          //
          // R3: cash that settles a frozen-month charge AFTER freeze posts FORWARD as a
          // prior_period_collection into the current open month (the frozen month is
          // immutable, so it can never be rebuilt). Self-discovers the owner's
          // frozen-month charges from (owner, month).
          await postPriorPeriodCollections(actor, ownerPartyId, month);
          await postForwardReversalForFrozenMonth(actor, ownerPartyId, month);
        } else {
          await syncMonthService(actor, { ownerPartyId, month });
        }
      }
    }
  } catch (e) {
    console.error("[owner-ledger.sync-hook] charges sync failed (swallowed):", e);
    // Durable drift marker — anchor to the owner being synced when it threw; if the
    // failure happened before any owner was resolved (e.g. the charge lookup), anchor
    // to the first chargeId so the marker stays queryable.
    await recordSyncFailure(orgId, userId, role, currentOwnerPartyId ?? chargeIds[0]!, {
      month: currentMonth,
      error: (e as Error).message,
      chargeIds,
      ownerPartyId: currentOwnerPartyId,
    });
  }
}
