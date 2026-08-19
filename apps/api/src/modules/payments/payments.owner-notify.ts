/**
 * Owner-notification dispatcher (PART 3 / Workstream D).
 *
 * When a tenant payment is APPLIED and a Charge reaches "paid", the unit's OWNER
 * is notified that their tenant's payment has landed — completing the monthly
 * cycle (admin keys utilities → owner sees draft → admin posts → owner sees
 * pending → TENANT PAYS → owner notified "paid" → report). Before this, the only
 * notification on a tenant payment was the org-wide ADMIN inbox alert raised when
 * the tenant SUBMITTED the payment; the owner was never told it was applied.
 *
 * Design (deliberately mirrors agent-cards/notifications.ts):
 *   • Resolution chain is THREE nullable hops — Charge.unitId → Listing
 *     (Unit table) → Listing.ownerPartyId → User.partyId (one user per party).
 *     Any hop missing (legacy charge with null unitId, an unowned unit, an owner
 *     with no portal User) → the notification is simply skipped. The owner Party
 *     is resolved per the unit's Listing.ownerPartyId (NOT LandlordTenancy).
 *   • Runs OUT of the payment transaction and SWALLOWS errors: a notification
 *     failure must NEVER roll back a posted/applied payment (money path). Callers
 *     fire it AFTER the tx has committed, with the set of charge ids that
 *     transitioned TO "paid" in that one payment-application event.
 *   • One notification per (owner, charge-paid) event — the caller passes only
 *     the newly-paid charge ids, so a re-applied/replayed payment that pays
 *     nothing new sends nothing (no spam).
 */
import { getDb } from "@kason/db";

/**
 * Notify the owner(s) of the units behind the given just-paid charges that their
 * tenant's payment has been applied. `chargeIds` MUST be only the charges that
 * transitioned to "paid" in this event (the caller computes this from the tx
 * result). Org-scoped. Never throws — every failure is logged and swallowed.
 */
export async function notifyOwnersOfChargesPaid(
  organizationId: string,
  chargeIds: string[] | undefined | null,
): Promise<void> {
  // Defensive: this is a money-path safety function — it must never throw, even
  // on a missing/empty id list (a no-op early-out keeps callers from needing a
  // `?? []` guard).
  if (!chargeIds || chargeIds.length === 0) return;
  try {
    const db = getDb();

    // Resolve each paid charge → its unit → the unit's owner Party. A charge with
    // a null unitId, or a unit with no ownerPartyId, contributes no owner.
    const charges = await db.charge.findMany({
      where: { organizationId, id: { in: chargeIds } },
      select: {
        id: true,
        chargeNumber: true,
        chargeType: true,
        amount: true,
        unit: { select: { ownerPartyId: true, apartment: { select: { unitCode: true } } } },
      },
    });

    for (const charge of charges) {
      const ownerPartyId = charge.unit?.ownerPartyId ?? null;
      if (ownerPartyId === null) continue; // no unit / unowned unit → nothing to notify

      // One User per Party (User.partyId is @unique). An owner who never activated
      // a portal account has no User → skip (no org-wide spam for owner alerts).
      const ownerUser = await db.user.findFirst({
        where: { organizationId, partyId: ownerPartyId },
        select: { id: true },
      });
      if (!ownerUser) continue;

      const unitLabel = charge.unit?.apartment?.unitCode ?? null;
      const amountStr = Number(charge.amount.toString()).toFixed(2);
      await db.notification.create({
        data: {
          organizationId,
          userId: ownerUser.id, // owner-targeted (not an org-wide admin alert)
          domain: "finance",
          title: "Tenant payment received",
          body:
            `A tenant payment of MYR ${amountStr} has been applied to ` +
            `${charge.chargeType} charge ${charge.chargeNumber}` +
            (unitLabel ? ` for unit ${unitLabel}` : "") +
            ` — it is now fully paid.`,
          actionUrl: "/owner/financials",
          read: false,
        },
      });
    }
  } catch (err) {
    // A notification failure must not surface on the payment path.
    console.error("[owner-notify] failed to notify owner(s) of paid charge(s):", err);
  }
}
