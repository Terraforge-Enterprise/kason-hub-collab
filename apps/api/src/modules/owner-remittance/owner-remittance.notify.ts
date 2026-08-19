/**
 * Owner-notification dispatcher for a recorded Phase-2 remittance.
 *
 * Mirrors `../payments/payments.owner-notify.ts` exactly (same resolution
 * chain, same "never throws" contract, same one-User-per-Party lookup):
 *   • Runs OUT of the remittance transaction and SWALLOWS every error — a
 *     notification failure must NEVER surface on the money path. The caller
 *     (owner-remittance.service.ts) fires this ONLY after the tx has
 *     committed (GC3) and ONLY for a freshly-created entry, never for an
 *     idempotent replay (a replay is not a new event — no second notify).
 *   • One User per Party (`User.partyId` is `@unique`); an owner who never
 *     activated a portal account has no User → notify is a silent no-op
 *     (matches the payments precedent's no-spam contract).
 *
 * No dedicated remittance-notification infra exists yet beyond the generic
 * `Notification` table payments already write to — this reuses that table
 * (domain:"finance", same actionUrl as the payments notifier) rather than
 * inventing a parallel channel.
 */
import { getDb } from "@kason/db";

/**
 * Notify the owner that a remittance/pre-statement-remittance payout was
 * recorded on their behalf. Org-scoped. Never throws.
 */
export async function notifyOwnerOfRemittance(
  organizationId: string,
  ownerPartyId: string,
  amount: string,
  settlementKind: string,
): Promise<void> {
  try {
    const db = getDb();

    // One User per Party (User.partyId is @unique). An owner who never
    // activated a portal account has no User → skip (no org-wide spam).
    const ownerUser = await db.user.findFirst({
      where: { organizationId, partyId: ownerPartyId },
      select: { id: true },
    });
    if (!ownerUser) return;

    const label = settlementKind === "PRE_STATEMENT_REMITTANCE" ? "pre-statement remittance" : "remittance";
    await db.notification.create({
      data: {
        organizationId,
        userId: ownerUser.id,
        domain: "finance",
        title: "Remittance recorded",
        body: `A ${label} of ${amount} has been recorded for you.`,
        actionUrl: "/owner/financials",
        read: false,
      },
    });
  } catch (err) {
    // A notification failure must not surface on the remittance path.
    console.error("[owner-remittance.notify] failed to notify owner of remittance:", err);
  }
}

/**
 * Notify the owner that a remittance/pre-statement-remittance/receivable-offset
 * was REVERSED (Task 9). Same contract as notifyOwnerOfRemittance above —
 * org-scoped, one User per Party, NEVER throws (the try wraps the entire body,
 * before any DB call) — the caller (reverseRemittanceService/
 * reverseOffsetService) fires this ONLY after the tx has committed and ONLY
 * for a freshly-created reversal, never for an idempotent replay (a replay is
 * not a new event — no second notify). Kept as a SEPARATE function rather
 * than widening notifyOwnerOfRemittance with an event-kind flag: this keeps
 * that already-shipped function's call site (Task 6) and contract completely
 * unchanged — zero regression risk to it.
 */
export async function notifyOwnerOfReversal(
  organizationId: string,
  ownerPartyId: string,
  amount: string,
  settlementKind: string,
): Promise<void> {
  try {
    const db = getDb();

    const ownerUser = await db.user.findFirst({
      where: { organizationId, partyId: ownerPartyId },
      select: { id: true },
    });
    if (!ownerUser) return;

    const label =
      settlementKind === "PRE_STATEMENT_REMITTANCE"
        ? "pre-statement remittance"
        : settlementKind === "OWNER_RECEIVABLE_OFFSET"
          ? "receivable offset"
          : "remittance";
    await db.notification.create({
      data: {
        organizationId,
        userId: ownerUser.id,
        domain: "finance",
        title: "Remittance reversed",
        body: `A ${label} of ${amount} was reversed.`,
        actionUrl: "/owner/financials",
        read: false,
      },
    });
  } catch (err) {
    // A notification failure must not surface on the reversal path.
    console.error("[owner-remittance.notify] failed to notify owner of reversal:", err);
  }
}
