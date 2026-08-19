// apps/api/src/modules/billing-documents/receipt.issue-hook.ts
//
// P2 R8: POST-COMMIT receipt issuance for a recorded payment. Mirrors
// owner-ledger.sync-hook.ts: opens its OWN transaction, is flag-gated, and
// NEVER throws — a receipt-issuance failure can never roll back the money
// transaction (which already committed before this runs). On failure a durable
// receipt.issue_failed audit marker is written. Idempotent via
// issueReceiptDocumentTx's "receipt:"+paymentId key.
import { getDb } from "@kason/db";
import type { Prisma } from "@kason/db";
import { recordAudit } from "../../lib/audit";
import { isPhase2FlagEnabled } from "../../lib/feature-flags";
import { issueReceiptDocumentTx } from "./receipts.service";

async function recordReceiptFailure(
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
        action: "receipt.issue_failed",
        entityType: "BillingDocument",
        entityId: paymentId,
        meta,
      }),
    );
  } catch (auditErr) {
    console.error("[billing-documents.receipt] failed to record receipt.issue_failed audit (swallowed):", auditErr);
  }
}

/** Issue the RCPT receipt for a just-recorded payment. Never throws. */
export async function issueReceiptForPayment(
  orgId: string,
  userId: string,
  role: string,
  paymentId: string,
  partyId: string,
  settledChargeIds: string[] | null | undefined,
): Promise<void> {
  if (!isPhase2FlagEnabled("ENABLE_PHASE2_BILLING_DOCS")) return;
  if (!settledChargeIds || settledChargeIds.length === 0) return;
  try {
    const db = getDb();
    await db.$transaction((tx) =>
      issueReceiptDocumentTx(tx, { organizationId: orgId, paymentId, partyId, settledChargeIds, actorUserId: userId }),
    );
  } catch (e) {
    console.error("[billing-documents.receipt] receipt issuance failed (swallowed):", e);
    await recordReceiptFailure(orgId, userId, role, paymentId, {
      paymentId,
      settledChargeIds,
      error: (e as Error).message,
    });
  }
}
