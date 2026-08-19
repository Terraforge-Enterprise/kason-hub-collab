/**
 * Integration test for tenant-create "from reservation" (T4). Hits a real
 * Postgres. Verifies createTenantService, when given `reservationId`,
 * race-safely links UnitReservation.tenantPartyId to the newly created
 * tenant Party inside ONE transaction — and rolls back cleanly (no orphan
 * Party) when the reservation isn't pickable (already linked).
 *
 * Skipped by default. Run explicitly:
 *   RUN_INTEGRATION=1 DATABASE_URL="..." \
 *     npx vitest run tenant-from-reservation
 */
import { describe, it, expect, beforeEach } from "vitest";
import { getDb } from "@kason/db";
import { createTenantService } from "../parties.service";
import type { PartiesSession } from "../parties.types";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

const ORG = "cc111111-1111-1111-1111-111111111111";
const AGENT_PARTY = "cc222222-2222-2222-2222-222222222222";
const EXISTING_TENANT_PARTY = "cc333333-3333-3333-3333-333333333333";
const PROPERTY = "cc444444-4444-4444-4444-444444444444";
const APARTMENT = "cc555555-5555-5555-5555-555555555555";
const UNIT = "cc666666-6666-6666-6666-666666666666";
const RESERVATION_PICKABLE = "cc777777-7777-7777-7777-777777777777";
const RESERVATION_LINKED = "cc888888-8888-8888-8888-888888888888";

const session: PartiesSession = {
  orgId: ORG,
  userId: "cc000000-0000-0000-0000-000000000001",
  role: "admin",
};

async function seedOrgWithReservations() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG,
      name: "Test",
      slug: "tenant-from-reservation",
      status: "active",
      defaultCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur",
      locale: "en-MY",
      subscriptionPlan: "free",
      reservationLinkExpiryDays: 7,
    },
  });
  await db.party.create({
    data: {
      id: AGENT_PARTY,
      organizationId: ORG,
      displayName: "Agent",
      partyType: "agent",
      status: "active",
    },
  });
  await db.party.create({
    data: {
      id: EXISTING_TENANT_PARTY,
      organizationId: ORG,
      displayName: "Existing Tenant",
      partyType: "tenant",
      status: "active",
    },
  });
  await db.property.create({
    data: {
      id: PROPERTY,
      organizationId: ORG,
      name: "Test Property",
      propertyCode: "TFR-1",
      propertyType: "residential",
      addressLine1: "1 Test St",
      city: "Kuala Lumpur",
      country: "MY",
      status: "active",
      publishStatus: "draft",
    },
  });
  await db.apartment.create({
    data: {
      id: APARTMENT,
      organizationId: ORG,
      propertyId: PROPERTY,
      unitCode: "TFR-101",
      listingMode: "WHOLE",
    },
  });
  await db.listing.create({
    data: {
      id: UNIT,
      organizationId: ORG,
      apartmentId: APARTMENT,
      listingType: "apartment",
      occupancyStatus: "vacant",
      listingStatus: "active",
      readyNow: true,
      currency: "MYR",
      ownerPartyId: AGENT_PARTY,
    },
  });

  const base = {
    organizationId: ORG,
    issuedByPartyId: AGENT_PARTY,
    expiresAt: new Date("2026-12-31T00:00:00Z"),
    propertyId: PROPERTY,
    unitId: UNIT,
    proposedMoveIn: new Date("2026-06-01T00:00:00Z"),
    reservationDeposit: "500.00",
    documentationFee: "100.00",
    rentalDeposit: "2400.00",
    utilityDeposit: "300.00",
    accessCardDeposit: "50.00",
  };

  await db.unitReservation.create({
    data: {
      ...base,
      id: RESERVATION_PICKABLE,
      referenceCode: "TFR-00001",
      status: "signed",
      publicToken: "tfr-pickable-token",
    },
  });
  await db.unitReservation.create({
    data: {
      ...base,
      id: RESERVATION_LINKED,
      referenceCode: "TFR-00002",
      status: "signed",
      publicToken: "tfr-linked-token",
      tenantPartyId: EXISTING_TENANT_PARTY,
    },
  });
}

async function cleanup() {
  const db = getDb();
  await db.unitReservation.deleteMany({ where: { organizationId: ORG } });
  // Tenancy → Listing is onDelete: Restrict, so any leftover Tenancy for this
  // org (e.g. left by a convert-from-reservation path or cross-run pollution)
  // must be deleted BEFORE the Listing, or listing.deleteMany trips
  // Tenancy_unitId_fkey. Harmless no-op when none exist.
  await db.tenancy.deleteMany({ where: { organizationId: ORG } });
  await db.listing.deleteMany({ where: { organizationId: ORG } });
  await db.apartment.deleteMany({ where: { organizationId: ORG } });
  await db.property.deleteMany({ where: { organizationId: ORG } });
  await db.party.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

dn("createTenantService — tenant-create from reservation (integration)", () => {
  beforeEach(async () => {
    await cleanup();
    await seedOrgWithReservations();
  });

  it("links on create", async () => {
    const result = await createTenantService(session, {
      displayName: "New Tenant One",
      primaryPhone: "",
      reservationId: RESERVATION_PICKABLE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(201);

    const db = getDb();
    const row = await db.unitReservation.findUniqueOrThrow({ where: { id: RESERVATION_PICKABLE } });
    expect(row.tenantPartyId).toBe((result.data as { id: string }).id);
  });

  it("already linked rejected, no orphan", async () => {
    const db = getDb();
    const before = await db.party.count({ where: { organizationId: ORG, partyType: "tenant" } });

    const result = await createTenantService(session, {
      displayName: "New Tenant Two",
      primaryPhone: "",
      reservationId: RESERVATION_LINKED,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);

    const after = await db.party.count({ where: { organizationId: ORG, partyType: "tenant" } });
    expect(after).toBe(before);

    const row = await db.unitReservation.findUniqueOrThrow({ where: { id: RESERVATION_LINKED } });
    expect(row.tenantPartyId).toBe(EXISTING_TENANT_PARTY);
  });

  it("no reservation unchanged", async () => {
    const db = getDb();
    const before = await db.party.count({ where: { organizationId: ORG, partyType: "tenant" } });

    const result = await createTenantService(session, {
      displayName: "New Tenant Three",
      primaryPhone: "",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(201);

    const after = await db.party.count({ where: { organizationId: ORG, partyType: "tenant" } });
    expect(after).toBe(before + 1);

    const pickable = await db.unitReservation.findUniqueOrThrow({ where: { id: RESERVATION_PICKABLE } });
    expect(pickable.tenantPartyId).toBeNull();
  });
});
