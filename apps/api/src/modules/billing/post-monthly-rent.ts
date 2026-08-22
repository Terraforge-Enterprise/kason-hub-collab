import { Prisma } from "@kason/db";
import { rentChargeNumber } from "./auto-draft.repository";
import { computeProratedRent, pickBaseRent } from "../../lib/rent-math";
import { assertPeriodOpen } from "../owner-ledger/assert-period-open";

/**
 * Unified rent posting (spec §10b.1 + §12 "Unified rent (Q5)").
 *
 * One idempotent helper used by BOTH the tenant-tracker "Post charges" action
 * (meter/service.ts `chargeUtilityBillService`) AND the auto-draft rent cron, so a
 * month's rent is posted exactly once. Dedup key = `Charge @@unique(organizationId,
 * chargeNumber)` with a deterministic FULL-id number (see `rentChargeNumber`).
 *
 * Idempotency is implemented CHECK-FIRST (not catch-P2002-then-query): a unique
 * violation inside an interactive Prisma transaction ABORTS the whole tx (Postgres),
 * which would also roll back the utility/aircond charges created alongside the rent in
 * the tracker post. So we resolve the existing-row cases (cron drafted first, or replay)
 * deterministically before inserting, and only let a genuine concurrent-insert P2002
 * propagate (caller's tx rolls back atomically → safe retry, never a double-charge).
 */

export type PostMonthlyRentResult = {
  chargeId: string;
  created: boolean;
  /**
   * TRUE when this call turned the charge into a LIVE RECEIVABLE — either it
   * created it posted, or it flipped a cron-drafted row draft→posted right here.
   *
   * Distinct from `created` on purpose. `created` answers "did this row exist
   * before"; this answers "did it start being owed just now", which is the
   * question credit auto-apply has to ask. A cron-drafted rent has `created:
   * false` yet is a brand-new receivable at the moment of the flip — and it never
   * had credit applied while it was a draft, because drafts are excluded from
   * the applier's charge filter. Keying auto-apply on `created` therefore skipped
   * every cron-drafted rent permanently: carried-forward credit could never come
   * off next month's rent, which is the whole point of carrying it forward.
   */
  becameReceivable: boolean;
};

// `computeProratedRent` + `pickBaseRent` now LIVE in `../../lib/rent-math` (Task 2 —
// see that file's header for why) and are re-exported here UNCHANGED so every
// existing importer of this module (`resolveMonthlyRentAmount` below, plus
// `tenancy/rent-preview.ts` and this module's own tests) keeps working verbatim.
export { computeProratedRent, pickBaseRent };

function firstOfMonthUtc(month: Date): Date {
  return new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1));
}

// "YYYY-MM" for the given month — the period-string contract `rentChargeNumber` expects.
function ymString(month: Date): string {
  return `${month.getUTCFullYear()}-${String(month.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Shared rent-amount resolver for BOTH the auto-draft cron AND
 * postMonthlyRentForTenancy (tracker post). Ensures both callers compute
 * an IDENTICAL prorated amount — so the draft→post flip never rewrites
 * a move-in month's rent.
 *
 * Precedence (highest first):
 *   1. Active RecurringCharge(rent) — preserved from the cron's existing override path.
 *      NOTE: spec §12 designates agreedMonthlyRent as the canonical source; the
 *      RecurringCharge slot is kept at #1 only to preserve the cron's legacy behaviour.
 *      In practice, if no active RecurringCharge(rent) rows exist this has no effect.
 *   2. Tenancy → UnitReservation.agreedMonthlyRent (spec §12 single rent source).
 *   3. Tenancy.monthlyRentAmount (fallback).
 * All paths apply spec §Phase-4 mid-month proration.
 */
export async function resolveMonthlyRentAmount(
  tx: Prisma.TransactionClient,
  orgId: string,
  tenancyId: string,
  month: Date,
): Promise<string> {
  const tenancy = await tx.tenancy.findFirst({
    where: { id: tenancyId, organizationId: orgId },
    select: {
      startDate: true,
      endDate: true,
      monthlyRentAmount: true,
      reservation: { select: { agreedMonthlyRent: true } },
    },
  });
  if (!tenancy) throw new Error(`resolveMonthlyRentAmount: tenancy ${tenancyId} not found in org ${orgId}`);

  // 1. RecurringCharge override (legacy cron path — top precedence preserved).
  const rc = await tx.recurringCharge.findFirst({
    where: { organizationId: orgId, tenancyId, chargeType: "rent", isActive: true },
    select: { amount: true },
  });

  const baseRent = pickBaseRent(
    rc?.amount != null ? Number(rc.amount.toString()) : null,
    tenancy.reservation?.agreedMonthlyRent != null ? Number(tenancy.reservation.agreedMonthlyRent) : null,
    Number(tenancy.monthlyRentAmount),
  );

  return computeProratedRent(baseRent, tenancy.startDate, tenancy.endDate, month).toFixed(2);
}

export async function postMonthlyRentForTenancy(
  tx: Prisma.TransactionClient,
  orgId: string,
  tenancyId: string,
  month: Date,
  actorUserId: string,
): Promise<PostMonthlyRentResult> {
  const chargeNumber = rentChargeNumber(ymString(month), tenancyId); // RENT-YYYYMM-{fullTenancyId}

  // CHECK-FIRST dedup (tx-safe). If a rent charge with this number already exists —
  // the cron drafted it, or this is a replay — reconcile WITHOUT triggering P2002.
  const existing = await tx.charge.findFirst({
    where: { organizationId: orgId, chargeNumber },
    select: { id: true, status: true },
  });
  if (existing) {
    let becameReceivable = false;
    if (existing.status === "draft") {
      // Cron drafted it first → flip draft→posted via a guarded WHERE (status:"draft"),
      // which is a 0-row no-op on a concurrent replay. The amount is NEVER rewritten
      // (resolveMonthlyRentAmount is the single amount source; the cron already set it).
      const flipped = await tx.charge.updateMany({
        where: { id: existing.id, organizationId: orgId, status: "draft" },
        data: { status: "posted", postedAt: new Date() },
      });
      if (flipped.count > 0) {
        // `count > 0` (not merely "it was a draft when we read it") is what makes
        // this safe under a concurrent replay: the guarded WHERE means exactly one
        // caller wins the flip, and only that caller reports a new receivable.
        becameReceivable = true;
        await tx.chargeEvent.create({
          data: {
            organizationId: orgId, chargeId: existing.id, eventType: "charge_posted", eventAt: new Date(),
            actorUserId, payloadJson: { previousStatus: "draft", nextStatus: "posted", source: "tracker.rent" },
          },
        });
      }
    }
    // draft (just flipped) / posted / paid / void → no-op. Never rewrite a posted amount.
    return { chargeId: existing.id, created: false, becameReceivable };
  }

  // Resolve the tenancy identity fields (unitId + tenantPartyId) for the Charge create.
  // The prorated rent amount is resolved via resolveMonthlyRentAmount — the shared helper
  // used by both the cron and the tracker so they are guaranteed to compute the same value.
  // The `unit` join resolves the per-unit owner (Listing.ownerPartyId) in the SAME
  // query — zero extra round-trips — for the R1 closed-period guard below.
  const tenancy = await tx.tenancy.findFirst({
    where: { id: tenancyId, organizationId: orgId },
    select: {
      unitId: true,
      tenantPartyId: true,
      startDate: true,
      endDate: true,
      firstMonthIsCommission: true,
      unit: { select: { ownerPartyId: true } },
    },
  });
  if (!tenancy) throw new Error(`postMonthlyRentForTenancy: tenancy ${tenancyId} not found in org ${orgId}`);

  const amount = await resolveMonthlyRentAmount(tx, orgId, tenancyId, month);
  // R9: a month entirely outside [startDate, endDate] resolves to 0 — nothing to bill.
  if (Number(amount) === 0) return { chargeId: "", created: false, becameReceivable: false };
  const billingMonth = firstOfMonthUtc(month);

  // Letting commission (Phase 2): the first FULL month is KAEN's letting commission — KAEN
  // revenue billed to the tenant on IVTEN (an Invoice), NOT the owner's rent (RB Rental Bill).
  // Flag off, non-commission month, or firstMonthIsCommission unset → ordinary "rent" (unchanged).
  // Shared decision so poster / auto-draft / tenancy preview never disagree.
  const chargeType = "rent" as const;

  // R1 (closed-period integrity): the rent charge created just below is owner INCOME
  // for this unit's owner (attributed per-unit via Listing.ownerPartyId) in billingMonth,
  // surfaced by the POST-COMMIT owner-ledger sync. If that owner-statement month is
  // FROZEN, the sync's void-only forward-reversal silently DROPS the owner income — so
  // reject the owner-impacting rent AT CREATION, in-tx, BEFORE the charge write (a throw
  // rolls the whole tx back → nothing persisted). No-op when the live-ledger flag is off,
  // the period is open/absent, or the unit has no owner (nothing to freeze). Mirrors the
  // guard at meter/service.ts + bills-grid/service.ts + owner-billing.service.ts.
  //
  // SCOPE: guards the CREATE branch only. The existing-row draft→posted flip above is
  // reached solely via meter/service.ts, which already calls assertPeriodOpen at the
  // apartment level BEFORE this helper — so that path is covered upstream and is left
  // untouched to keep the hot idempotent-replay path free of an extra owner lookup.
  // Tenant rent is always owner income. A first-month letting commission is a
  // separate owner-side deduction and never changes the tenant charge's nature.
  const ownerPartyId = tenancy.unit.ownerPartyId;
  if (ownerPartyId) {
    await assertPeriodOpen(tx, orgId, ownerPartyId, billingMonth);
  }

  // No existing row → create POSTED. A P2002 here is only a true concurrent-insert race
  // (the deterministic cron/tracker ordering was handled above). It aborts the tx, so we
  // let it propagate: the caller's transaction rolls back atomically and the post can be
  // retried (no double-charge). A single-admin post + a scheduled cron never collide here.
  const created = await tx.charge.create({
    data: {
      organizationId: orgId,
      chargeNumber,
      tenancyId,
      unitId: tenancy.unitId,
      partyId: tenancy.tenantPartyId,
      chargeType,
      status: "posted",
      postedAt: new Date(),
      description: "Monthly rent",
      // Due within the billing month so the owner-ledger sync surfaces it
      // (it filters rent by dueDate ∈ [monthStart, monthEnd]).
      dueDate: billingMonth,
      amount,
      currency: "MYR",
      outstandingAmount: amount,
      attachmentKeys: [],
      billingMonth,
    },
    select: { id: true },
  });
  await tx.chargeEvent.create({
    data: {
      organizationId: orgId, chargeId: created.id, eventType: "charge_created", eventAt: new Date(),
      actorUserId, payloadJson: { source: "tracker.rent", amount } as unknown as Prisma.InputJsonValue,
    },
  });
  await tx.chargeEvent.create({
    data: {
      organizationId: orgId, chargeId: created.id, eventType: "charge_posted", eventAt: new Date(),
      actorUserId, payloadJson: { previousStatus: "draft", nextStatus: "posted" },
    },
  });
  return { chargeId: created.id, created: true, becameReceivable: true };
}
