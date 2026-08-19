/**
 * Record that KAEN HOLDS a tenancy deposit, when the tenant pays it.
 *
 * `tenancy-deposits.ts` raises the DEPRENT-/DEPUTIL- Charges and the tenant pays
 * them, but until now nothing recorded the resulting fact — that KAEN is holding
 * that money on the tenancy's behalf. The owner saw no trace of it.
 *
 * The `Deposit` table has always had the right shape for this (amount, status,
 * refundedAmount, refundDate) and the owner statement has always read it; nothing
 * ever wrote a row, so every reader saw zero. This hook is the missing writer.
 *
 * IMPORTANT — a held deposit is NOT owner income. It is the tenant's money,
 * refundable at move-out (operator decision 2026-08-18: KAEN holds tenancy
 * deposits). Rows are written `status: "held"`, and
 * `findDepositsCollectedInMonth` — the reader that feeds the owner PAYOUT — counts
 * only `released_to_owner`. Writing a row therefore shows the deposit without
 * moving a cent of anyone's payout. Do not "simplify" that status filter.
 *
 * Trigger is FULL payment (`status: "paid"`), not each partial, mirroring
 * issueMgmtFeeForPaidRent: a half-paid deposit leaves the held figure ambiguous
 * and would make the owner-facing line flicker as instalments arrive.
 *
 * Contract mirrors mgmt-fee-on-payment.hook.ts and owner-ledger.sync-hook.ts
 * deliberately:
 *   • runs OUT of the caller's transaction, AFTER it commits
 *   • SWALLOWS every error — recording a deposit must NEVER roll back a payment
 *   • leaves a durable AuditLog marker when it swallows something, so a missed
 *     record is detectable instead of vanishing into a console line
 *
 * Flag: gated on ENABLE_PHASE2_OWNER_BILLING, the same gate both siblings use —
 * there is no owner statement to show a held deposit on when that flag is dark.
 */
import { getDb } from "@kason/db";
import type { Prisma } from "@kason/db";
import { recordAudit } from "../../lib/audit";
import { isPhase2FlagEnabled } from "../../lib/feature-flags";
import type { OwnerBillingActorCtx } from "./owner-billing.types";

/** The two DEPOSIT_LEGS keys in billing/tenancy-deposits.ts, by charge type. */
const LEG_BY_CHARGE_TYPE: Record<string, "rental" | "utilities"> = {
  security_deposit: "rental",
  utility_deposit: "utilities",
};

/**
 * Durable marker for a swallowed failure, mirroring mgmt-fee-on-payment's
 * recordFeeIssueIssue. Best-effort in its OWN try/catch so an audit-write failure
 * can never re-throw into the money-path caller.
 */
async function recordDepositHeldIssue(
  ctx: OwnerBillingActorCtx,
  action: "owner-billing.deposit_held_on_payment.failed",
  /** A charge the settlement touched — enough to find the payment again. */
  entityId: string,
  meta: Prisma.InputJsonObject,
): Promise<void> {
  try {
    await getDb().$transaction((tx) =>
      recordAudit(tx, {
        organizationId: ctx.orgId,
        actorUserId: ctx.actorUserId,
        actorRole: ctx.actorRole,
        action,
        entityType: "Deposit",
        entityId,
        meta,
      }),
    );
  } catch {
    // Never re-throw into the money path.
  }
}

/**
 * For each just-settled Charge that is a FULLY PAID deposit charge, ensure a
 * `Deposit` row records what KAEN now holds.
 *
 * `chargeIds` are the charges the payment touched — the same list the caller
 * hands syncOwnerLedgerForCharges and issueMgmtFeeForPaidRent.
 */
export async function recordDepositsHeldForPaidCharges(
  orgId: string,
  userId: string,
  role: string,
  chargeIds: string[] | null | undefined,
): Promise<void> {
  if (!isPhase2FlagEnabled("ENABLE_PHASE2_OWNER_BILLING")) return;
  if (!chargeIds || chargeIds.length === 0) return;

  const ctx: OwnerBillingActorCtx = {
    orgId,
    actorUserId: userId,
    // role comes from the authenticated session (typed `string`); at runtime it is
    // always one of the ctx roles. Assert at this single boundary, as the sibling
    // hooks do.
    actorRole: role as OwnerBillingActorCtx["actorRole"],
  };

  try {
    const db = getDb();

    // Only deposit legs, only fully paid — see the module docstring for why a
    // partial payment deliberately does nothing.
    const charges = await db.charge.findMany({
      where: {
        organizationId: orgId,
        id: { in: chargeIds },
        chargeType: { in: ["security_deposit", "utility_deposit"] },
        status: "paid",
      },
      select: {
        id: true,
        tenancyId: true,
        unitId: true,
        partyId: true,
        amount: true,
        chargeType: true,
      },
    });
    if (charges.length === 0) return;

    for (const c of charges) {
      // A deposit is always tenancy- and unit-scoped. Anything else is a data
      // shape this hook has no opinion on; skip rather than guess.
      if (!c.tenancyId || !c.unitId) continue;
      const type = LEG_BY_CHARGE_TYPE[c.chargeType];
      if (!type) continue;

      // Idempotent: re-settlement, reallocation and replayed webhooks all
      // re-enter here with the same chargeId, and a second row would overstate
      // what KAEN holds. (tenancyId, type) is the natural key —
      // tenancy-deposits.ts raises at most one charge per leg per tenancy
      // (chargeNumber DEPRENT-{tenancyId} / DEPUTIL-{tenancyId}, no month part).
      const existing = await db.deposit.findFirst({
        where: { organizationId: orgId, tenancyId: c.tenancyId, type },
        select: { id: true },
      });
      if (existing) continue;

      await db.deposit.create({
        data: {
          organizationId: orgId,
          tenancyId: c.tenancyId,
          partyId: c.partyId,
          unitId: c.unitId,
          type,
          amount: c.amount,
          status: "held",
        },
      });
    }
  } catch (err) {
    await recordDepositHeldIssue(
      ctx,
      "owner-billing.deposit_held_on_payment.failed",
      chargeIds[0]!,
      { chargeIds, message: err instanceof Error ? err.message : String(err) },
    );
  }
}
