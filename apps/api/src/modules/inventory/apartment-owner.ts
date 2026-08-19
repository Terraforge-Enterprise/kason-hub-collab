/**
 * Canonical "who owns this apartment" resolvers.
 *
 * Owner is APARTMENT-scoped (one landlord per physical apartment) but is PERSISTED
 * on the apartment's rows — `Listing.ownerPartyId` and `Carpark.ownerPartyId` — not
 * on the `Apartment` row itself. Answering "who owns this apartment" therefore means
 * scanning those rows in a defined order.
 *
 * There are THREE questions, and they are NOT the same question:
 *
 *   1. "Who would a NEW row on this apartment be born owned by?"
 *      -> `resolveApartmentOwnerForInheritance`. Only rows we can TRUST.
 *   2. "Whose ledger does this apartment's money currently foot to?"
 *      -> `resolveApartmentOwnerAttributed`. A superset; the safe direction for a
 *         ledger rebuild, where naming one owner too many costs a recompute and
 *         naming one too few silently strands income.
 *   3. "Does SOMEONE already own this apartment?"
 *      -> `resolveApartmentOwnerForConflict`. The widest superset, evidence only.
 *
 * These live in their own module because BOTH `inventory.service.ts` (the create
 * paths) and `apartment.service.ts` ("Edit shared details") must answer them
 * identically. Duplicating the scan is how the two drifted: `apartment.service.ts`
 * probed Listings only, with no `ownerPartyId` filter and no `orderBy`, and read
 * "no previous owner" for an apartment that had one.
 *
 * All three take the Prisma client as their first argument and work equally with a
 * bare `db` handle or a `tx` handle, so callers may resolve before or inside a
 * transaction. Every scan pins `orderBy: { id: "asc" }` — `findFirst` without one
 * returns an arbitrary row, and two owned rows would make the answer
 * nondeterministic across calls.
 *
 * `Listing.ownerPartyId` and `Carpark.ownerPartyId` are nullable (schema.prisma:408,
 * 459), so `{ not: null }` is the deliberate "owned rows only" filter. `listingStatus`
 * and `Carpark.status` are non-nullable (schema.prisma:377, 462), so `{ not: ... }` on
 * them is NULL-safe.
 */

/**
 * INHERITANCE SOURCE — what a NEW row gets stamped with.
 *
 * Owner is APARTMENT-scoped (one landlord per physical apartment). A room only
 * ever receives an owner via the apartment-level fan-out (updateApartmentShared
 * / updateUnit), which touches rooms that exist AT THAT MOMENT. A room created
 * AFTER the owner was assigned would be born ownerless and could never be
 * occupied (UNIT_HAS_NO_OWNER) even though its siblings are owned — the exact
 * "can't occupy the other rooms" bug. New rooms must therefore inherit the
 * apartment's current owner.
 *
 * Reads NON-ARCHIVED LISTINGS ONLY. Nothing else. Two row classes are deliberately
 * excluded, for the same reason:
 *
 *   - ARCHIVED listings. Both fan-out writers (`updateUnitService`,
 *     `updateApartmentSharedService`) exclude `listingStatus: "archived"`, so an
 *     archived row keeps whatever owner it had when it was archived. After a
 *     re-point that value is STALE.
 *   - CARPARK BAYS. A bay's owner is kept current by the three fan-out writers
 *     TODAY, but bays minted before `2ce46923` (which gave
 *     `updateApartmentSharedService` its bay fan-out) and before `7fe7eb65` (which
 *     stopped minting bays from an archived listing's owner) are unconstrained on
 *     real data, and NO carpark backfill exists to repair them —
 *     `scripts/backfill-apartment-owner.ts:15` puts carparks explicitly out of
 *     scope ("Carparks are out of scope (rooms only)").
 *
 * Both classes prove that SOMEONE owns this apartment. Neither proves WHO. Stamping
 * a stale owner onto a new `Listing` is not a cosmetic error: `owner-ledger.sync-hook.ts`
 * attributes the whole apartment's charges through the first non-archived listing's
 * `ownerPartyId`, so a wrong stamp moves the apartment's money to the wrong ledger.
 * A row born OWNERLESS is the safe direction — it foots to nobody until an admin
 * assigns an owner from "Edit shared details", which fans out and audits.
 *
 * ONE STAMPING RULE, EVERYWHERE: "non-archived listings only". The two sites that
 * MINT a carpark bay derive its owner by that same rule
 * (`findApartmentForCarpark` in carpark.repository.ts, `ensureCarpark` in
 * data-import/inventory-resolver.ts), so a bay is born carrying the owner this
 * resolver would have returned.
 *
 * Returns the ownerPartyId to stamp on the new room(s), or null when the
 * apartment has no owner we can trust (owner gets assigned later, then fans out).
 */
export async function resolveApartmentOwnerForInheritance(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  orgId: string,
  apartmentId: string,
): Promise<string | null> {
  const sibling = await tx.listing.findFirst({
    where: {
      apartmentId,
      organizationId: orgId,
      listingStatus: { not: "archived" },
      ownerPartyId: { not: null },
    },
    select: { ownerPartyId: true },
    orderBy: { id: "asc" },
  });
  return sibling?.ownerPartyId ?? null;
}

/**
 * ATTRIBUTED OWNER — whose ledger this apartment's money currently foots to.
 *
 * `resolveApartmentOwnerForInheritance`, then non-inactive carpark bays. A bay is a
 * real attribution surface: `Carpark.ownerPartyId` mirrors the apartment's owner
 * (schema.prisma:459) and `owner-ledger.sync-hook.ts` routes a bay's charges through
 * it, so an apartment whose only owned row is an active bay DOES have income footing
 * to that party right now — even though we refuse to INHERIT from it.
 *
 * That asymmetry is the whole point. The bay may name a stale owner, so:
 *   - for a STAMP (inheritance) a stale answer is worse than no answer, and
 *   - for a LEDGER REBUILD a stale answer is better than no answer, because the
 *     party named is exactly the party whose ledger currently holds the income that
 *     is about to move. Rebuilding one owner too many costs a recompute; rebuilding
 *     one too few strands income on a ledger nobody will revisit.
 *
 * Use this — never the inheritance resolver — to answer "whose ledger must I rebuild".
 */
export async function resolveApartmentOwnerAttributed(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  orgId: string,
  apartmentId: string,
): Promise<string | null> {
  const listingOwner = await resolveApartmentOwnerForInheritance(tx, orgId, apartmentId);
  if (listingOwner) return listingOwner;

  const bay = await tx.carpark.findFirst({
    where: {
      apartmentId,
      organizationId: orgId,
      status: { not: "inactive" },
      ownerPartyId: { not: null },
    },
    select: { ownerPartyId: true },
    orderBy: { id: "asc" },
  });
  return bay?.ownerPartyId ?? null;
}

/**
 * CONFLICT EVIDENCE ONLY — never an inheritance source.
 *
 * Superset of `resolveApartmentOwnerAttributed`: after the attributed scans it also
 * consults ARCHIVED listings and INACTIVE bays. An apartment whose only surviving
 * owner record is an archived room must still refuse a NEW room carrying a
 * different owner — otherwise unarchiving that room silently yields two active
 * owners on one apartment.
 *
 * Why this must never feed inheritance: an archived listing and an inactive bay are
 * each frozen at the owner they carried when they were retired, and even an ACTIVE
 * bay may predate the writers that keep bays current. All three prove "someone owns
 * this apartment"; none of them proves WHO.
 */
export async function resolveApartmentOwnerForConflict(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  orgId: string,
  apartmentId: string,
): Promise<string | null> {
  const current = await resolveApartmentOwnerAttributed(tx, orgId, apartmentId);
  if (current) return current;

  const archived = await tx.listing.findFirst({
    where: {
      apartmentId,
      organizationId: orgId,
      listingStatus: "archived",
      ownerPartyId: { not: null },
    },
    select: { ownerPartyId: true },
    orderBy: { id: "asc" },
  });
  if (archived?.ownerPartyId) return archived.ownerPartyId;

  const inactiveBay = await tx.carpark.findFirst({
    where: {
      apartmentId,
      organizationId: orgId,
      status: "inactive",
      ownerPartyId: { not: null },
    },
    select: { ownerPartyId: true },
    orderBy: { id: "asc" },
  });
  return inactiveBay?.ownerPartyId ?? null;
}
