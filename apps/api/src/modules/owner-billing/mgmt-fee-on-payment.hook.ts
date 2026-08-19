/**
 * Issue the owner's management-fee invoice when a tenant's RENT is fully paid.
 *
 * The fee used to be minted by an admin clicking "Issue statement", computed from
 * the tenancy's CONTRACTED rent regardless of whether anyone paid. That disagreed
 * with the owner ledger, which has always deducted the fee from rent actually
 * COLLECTED (owner-ledger.sync.ts books rental_income as
 * `collectedString(amount, outstanding)`). Two numbers, one fee.
 *
 * Now the collection itself is the trigger: when a rent Charge reaches `paid`, the
 * owner's statement invoice for that billing month is created (or appended to) so
 * the fee document and the payout deduction are the same figure by construction.
 * At full payment collected == contracted, so the invoiced fee and the ledger's
 * computed deduction reconcile exactly — which is precisely why the trigger is
 * FULL payment and not each partial one. A partial payment deliberately does
 * nothing here; the ledger still deducts proportionally, and the invoice waits
 * until the rent is settled so an issued document never needs amending.
 *
 * Contract mirrors owner-ledger.sync-hook.ts deliberately:
 *   • runs OUT of the caller's transaction, AFTER it commits
 *   • SWALLOWS every error — issuing a fee invoice must NEVER roll back a payment
 *   • leaves a durable AuditLog marker when it swallows something, so a missed fee
 *     is detectable instead of vanishing into a console line
 *
 * Flag: gated on ENABLE_PHASE2_OWNER_BILLING, the same gate the sibling ledger
 * sync uses. The management fee is core owner-billing; there is no owner statement
 * to put it on when that flag is dark.
 */
import { getDb } from "@kason/db";
import type { Prisma } from "@kason/db";
import { recordAudit } from "../../lib/audit";
import { isPhase2FlagEnabled } from "../../lib/feature-flags";
import { generateStatementService } from "./owner-billing.service";
import type { OwnerBillingActorCtx } from "./owner-billing.types";

const monthOf = (d: Date): string => d.toISOString().slice(0, 7); // "YYYY-MM"

/**
 * Durable marker for a swallowed failure (or a deliberate skip), mirroring
 * owner-ledger.sync-hook's recordSyncFailure. Best-effort in its OWN try/catch so
 * an audit-write failure can never re-throw into the money-path caller.
 */
async function recordFeeIssueIssue(
  ctx: OwnerBillingActorCtx,
  action: "owner-billing.mgmt_fee_on_payment.failed" | "owner-billing.mgmt_fee_on_payment.skipped",
  /** Owner the fee belongs to — same entityId convention as recordSyncFailure. */
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
        entityType: "Invoice",
        entityId,
        meta,
      }),
    );
  } catch {
    // Never re-throw into the money path.
  }
}

/**
 * For each just-settled Charge that is a FULLY PAID rent charge, ensure the
 * owning owner's statement invoice for that billing month carries the mgmt fee.
 *
 * `chargeIds` are the charges the payment touched — the same list the caller
 * hands syncOwnerLedgerForCharges.
 */
export async function issueMgmtFeeForPaidRent(
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
    // ledger hook does.
    actorRole: role as OwnerBillingActorCtx["actorRole"],
  };

  let currentOwnerPartyId: string | null = null;
  let currentMonth: string | null = null;

  try {
    const db = getDb();

    // Only rent, only fully paid. `partially_paid` is intentionally excluded — see
    // the module docstring for why the trigger is full settlement.
    const charges = await db.charge.findMany({
      where: {
        organizationId: orgId,
        id: { in: chargeIds },
        chargeType: "rent",
        status: "paid",
      },
      select: {
        id: true,
        billingMonth: true,
        // Owner resolution mirrors syncOwnerLedgerForCharges exactly: a unit charge
        // resolves via unit.ownerPartyId, a carpark charge via carpark.ownerPartyId
        // (carparkId set, unitId null) so a bay's rent credits the BAY's owner.
        unit: { select: { ownerPartyId: true } },
        carpark: { select: { ownerPartyId: true } },
      },
    });
    if (charges.length === 0) return;

    // Collapse to the distinct (owner, month) pairs needing a statement. One
    // generate per pair covers every unit of that owner in that month — the
    // in-tx per-unit probe decides which lines are still missing.
    const pairs = new Map<string, Set<string>>();
    for (const c of charges) {
      const owner = c.unit?.ownerPartyId ?? c.carpark?.ownerPartyId ?? null;
      if (!owner || !c.billingMonth) continue;
      if (!pairs.has(owner)) pairs.set(owner, new Set());
      pairs.get(owner)!.add(monthOf(c.billingMonth));
    }

    for (const [ownerPartyId, months] of pairs) {
      for (const billingMonth of months) {
        currentOwnerPartyId = ownerPartyId;
        currentMonth = billingMonth;

        // appendToExistingDraft: an owner with several units gets several rent
        // payments across the month. Without append the second payment would hit
        // the idempotency return and that unit's fee would never be billed.
        const result = await generateStatementService(
          ctx,
          { ownerPartyId, billingMonth },
          { appendToExistingDraft: true },
        );

        if (!result.ok) {
          await recordFeeIssueIssue(ctx, "owner-billing.mgmt_fee_on_payment.failed", ownerPartyId, {
            ownerPartyId,
            billingMonth,
            reason: result.error,
            status: result.status,
          });
          continue;
        }

        // The statement was already approved/sent/paid, so append mode returned it
        // untouched rather than moving an issued document's total. The fee for the
        // unit that just settled is therefore NOT on it. Record it — a missing fee
        // must be detectable, never silent.
        if (result.data.status !== "draft") {
          await recordFeeIssueIssue(ctx, "owner-billing.mgmt_fee_on_payment.skipped", ownerPartyId, {
            ownerPartyId,
            billingMonth,
            statementId: result.data.id,
            statementStatus: result.data.status,
            reason: "statement already issued — mgmt fee for the newly-paid rent was not appended",
          });
        }
      }
    }
  } catch (e) {
    await recordFeeIssueIssue(
      ctx,
      "owner-billing.mgmt_fee_on_payment.failed",
      currentOwnerPartyId ?? chargeIds[0]!,
      {
        ownerPartyId: currentOwnerPartyId,
        billingMonth: currentMonth,
        reason: (e as Error).message,
      },
    );
  }
}
