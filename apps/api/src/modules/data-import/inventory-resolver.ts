import { getDb } from "@kason/db";
import {
  createPropertyService,
  createUnitsBatchService,
} from "../inventory/inventory.service";
import { recordAudit } from "../../lib/audit";
import {
  findPropertyByCode,
  findApartmentByCode,
  findListing,
} from "./repository";
import type { ImportSession } from "./types";

/**
 * Step 0 note on InventorySession compatibility:
 * InventorySession = { userId: string; orgId: string; role: string }
 * ImportSession    = { orgId: string; userId: string; role: "admin"; userType: "operator" }
 *
 * ImportSession is a structural superset — role:"admin" satisfies role:string,
 * and the extra `userType` field is ignored by the inventory service. No cast
 * needed: TypeScript structural typing accepts ImportSession where
 * InventorySession is required.
 */

const DEFAULTS = { depositMonths: 2, utilitiesDepositMonths: 0 };

/**
 * Convert a property display name into a stable, URL-safe property code.
 * e.g. "UCSI 2" → "UCSI-2", "Riana South" → "RIANA-SOUTH"
 */
export function propertyCodeFor(name: string): string {
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 24);
}

/**
 * Ensure the named Property exists for this org. Returns the property id.
 * Find-or-create: if the property already exists (by propertyCode) return
 * its id without calling createPropertyService again.
 *
 * 409 from the service is treated as a race-safe "already exists" — we
 * re-query and return the existing id.
 */
export async function ensureProperty(
  session: ImportSession,
  name: string,
): Promise<string> {
  const code = propertyCodeFor(name);
  const existing = await findPropertyByCode(session.orgId, code);
  if (existing) return existing.id;

  const res = await createPropertyService(session, {
    name,
    propertyCode: code,
    propertyType: "condominium",
    addressLine1: name,
    city: "Kuala Lumpur",
    country: "Malaysia",
  });

  if (!res.ok) {
    // Race-safe: another process may have created it between our read and write.
    const again = await findPropertyByCode(session.orgId, code);
    if (again) return again.id;
    throw new Error(
      `ensureProperty failed for ${name}: ${JSON.stringify(res.error)}`,
    );
  }

  return res.data.id;
}

/**
 * Ensure a room Listing (Apartment + Listing) exists for the given unit and
 * listing type. Returns the listing id and whether it was newly created.
 *
 * If the apartment and listing already exist, returns immediately without
 * calling createUnitsBatchService.
 */
export async function ensureRoomListing(
  session: ImportSession,
  propertyId: string,
  unitCode: string,
  listingType: string,
  rentalRate: number | null,
): Promise<{ id: string; created: boolean }> {
  const apt = await findApartmentByCode(session.orgId, propertyId, unitCode);
  if (apt) {
    const existing = await findListing(session.orgId, apt.id, listingType);
    if (existing) return { id: existing.id, created: false };
  }

  const res = await createUnitsBatchService(session, {
    shared: { propertyId, unitCode },
    rooms: [
      {
        unitType: listingType,
        rentalRate: rentalRate ?? undefined,
        depositMonths: DEFAULTS.depositMonths,
        utilitiesDepositMonths: DEFAULTS.utilitiesDepositMonths,
      },
    ],
    applyToExistingSiblings: false,
  });

  if (!res.ok) {
    throw new Error(
      `ensureRoomListing failed ${unitCode}/${listingType}: ${res.error}`,
    );
  }

  // Re-query to get the canonical id regardless of whether the service
  // returned it (batch returns an array; we need the specific listing).
  const aptNow = await findApartmentByCode(session.orgId, propertyId, unitCode);
  const listing = aptNow
    ? await findListing(session.orgId, aptNow.id, listingType)
    : null;

  if (!listing) {
    throw new Error(
      `ensureRoomListing: listing not found after create ${unitCode}/${listingType}`,
    );
  }

  return { id: listing.id, created: true };
}

/**
 * Ensure a Carpark bay exists for the given unit and label.
 * Idempotent on (org, apartment, label): returns the existing bay without
 * any writes when the bay was already created.
 *
 * The bay's ownerPartyId is derived from any sibling Listing on the same
 * apartment that already has an owner assigned, mirroring the logic in
 * registerCarparkService.
 */
export async function ensureCarpark(
  session: ImportSession,
  propertyId: string,
  unitCode: string,
  label: string,
  monthlyRate: number,
): Promise<{ id: string; created: boolean }> {
  const db = getDb();

  // The apartment must already exist — ensureRoomListing ran before us.
  const apt = await findApartmentByCode(session.orgId, propertyId, unitCode);
  if (!apt) {
    throw new Error(`ensureCarpark: apartment not found for unit ${unitCode}`);
  }

  // Idempotency check.
  const existing = await db.carpark.findFirst({
    where: { organizationId: session.orgId, apartmentId: apt.id, label },
    select: { id: true },
  });
  if (existing) return { id: existing.id, created: false };

  // Resolve ownerPartyId from a sibling Listing that has an owner.
  //
  // NON-ARCHIVED siblings only. The bay below is created `status: "available"`
  // (active), and an active bay is an inheritance source for the apartment-owner
  // resolver (inventory.service.ts `resolveApartmentOwnerPartyId`). An archived
  // listing keeps whatever owner it had when it was archived — neither fan-out
  // writer updates it — so inheriting from one would mint a bay holding a STALE
  // owner and leak that owner to the next room created on this apartment.
  //
  // `listingStatus` is a non-nullable String, so `{ not: "archived" }` is NULL-safe.
  // `ownerPartyId` is nullable and `{ not: null }` is the deliberate owned-row filter.
  const aptDetail = await db.apartment.findFirst({
    where: { id: apt.id, organizationId: session.orgId },
    select: {
      listings: {
        where: {
          ownerPartyId: { not: null },
          listingStatus: { not: "archived" },
        },
        select: { ownerPartyId: true },
        orderBy: { id: "asc" }, // `take: 1` without an orderBy is nondeterministic
        take: 1,
      },
    },
  });
  const ownerPartyId = aptDetail?.listings[0]?.ownerPartyId ?? null;

  const result = await db.$transaction(async (tx) => {
    const carpark = await tx.carpark.create({
      data: {
        organizationId: session.orgId,
        propertyId,
        apartmentId: apt.id,
        ownerPartyId,
        label,
        monthlyRate,
        status: "available",
      },
      select: { id: true },
    });

    await recordAudit(tx, {
      organizationId: session.orgId,
      actorUserId: session.userId,
      actorRole: session.role,
      action: "data-import.carpark.create",
      entityType: "Carpark",
      entityId: carpark.id,
      meta: { source: "data-import", label, unitCode },
    });

    return carpark;
  });

  return { id: result.id, created: true };
}
