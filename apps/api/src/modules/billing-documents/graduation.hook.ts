// apps/api/src/modules/billing-documents/graduation.hook.ts
//
// Spec R3/R13 — POST-COMMIT graduation for a settled payment. Same contract as
// receipt.issue-hook.ts: own transaction, flag-gated, NEVER throws. The money committed
// before this runs, so a failed graduation must never roll it back — it leaves the
// tenant correctly paid with the invoice missing, and a durable
// `graduation.issue_failed` audit marker says so.
import { getDb } from "@kason/db";
import type { Prisma } from "@kason/db";
import { recordAudit } from "../../lib/audit";
import { isPhase2FlagEnabled } from "../../lib/feature-flags";
import { graduateProformaForPaymentTx } from "./graduation.service";

async function recordFailure(
  orgId: string,
  userId: string,
  role: string,
  paymentId: string,
  meta: Prisma.InputJsonObject,
): Promise<void> {
  try {
    const db = getDb();
    await db.$transaction((tx) =>
      recordAudit(tx, {
        organizationId: orgId,
        actorUserId: userId,
        actorRole: role,
        action: "graduation.issue_failed",
        entityType: "BillingDocument",
        entityId: paymentId,
        meta,
      }),
    );
  } catch (auditErr) {
    console.error("[billing-documents.graduation] failed to record graduation.issue_failed audit (swallowed):", auditErr);
  }
}

/**
 * Mint the real invoice for the charges a payment settled IN FULL. Never throws.
 *
 * `paidChargeIds`, never the merely-allocated set: a partial allocation must not mint a
 * full-value tax invoice, and two partials on one charge must not mint two.
 */
export async function graduateProformaForPayment(
  orgId: string,
  userId: string,
  role: string,
  paymentId: string,
  partyId: string,
  paidChargeIds: string[] | null | undefined,
): Promise<void> {
  if (!isPhase2FlagEnabled("ENABLE_PHASE2_BILLING_DOCS")) return;
  if (!isPhase2FlagEnabled("ENABLE_PROFORMA_INVOICES")) return;
  if (!paidChargeIds || paidChargeIds.length === 0) return;
  try {
    const db = getDb();
    await db.$transaction((tx) =>
      graduateProformaForPaymentTx(tx, {
        organizationId: orgId,
        paymentId,
        partyId,
        paidChargeIds,
        actorUserId: userId,
      }),
    );
  } catch (e) {
    console.error("[billing-documents.graduation] graduation failed (swallowed):", e);
    await recordFailure(orgId, userId, role, paymentId, {
      paymentId,
      paidChargeIds,
      error: (e as Error).message,
    });
  }
}
