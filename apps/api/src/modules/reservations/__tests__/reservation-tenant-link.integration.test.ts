/**
 * Integration test for UnitReservation.tenantPartyId (T2). Hits a real
 * Postgres. Verifies the column/FK/index the 20260707120000 migration adds:
 *   1. it can be set and read back through Prisma
 *   2. deleting the linked tenant Party sets it NULL (ON DELETE SET NULL)
 *      without deleting the reservation row
 *
 * Skipped by default. Run explicitly:
 *   RUN_INTEGRATION=1 DATABASE_URL="..." \
 *     npx vitest run reservation-tenant-link
 */
import { describe, it, expect, beforeEach } from "vitest";
import { getDb } from "@kason/db";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

const ORG = "aa111111-1111-1111-1111-111111111111";
const AGENT_PARTY = "aa222222-2222-2222-2222-222222222222";
const TENANT_PARTY = "aa333333-3333-3333-3333-333333333333";
const PROPERTY = "aa444444-4444-4444-4444-444444444444";
const APARTMENT = "aa555555-5555-5555-5555-555555555555";
const UNIT = "aa666666-6666-6666-6666-666666666666";
const RESERVATION = "aa777777-7777-7777-7777-777777777777";

async function seedOrgWithUnit() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG,
      name: "Test",
      slug: "reservation-tenant-link",
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
      id: TENANT_PARTY,
      organizationId: ORG,
      displayName: "Tenant",
      partyType: "tenant",
      status: "active",
    },
  });
  await db.property.create({
    data: {
      id: PROPERTY,
      organizationId: ORG,
      name: "Test Property",
      propertyCode: "RTL-1",
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
      unitCode: "RTL-101",
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
  await db.unitReservation.create({
    data: {
      id: RESERVATION,
      organizationId: ORG,
      referenceCode: "RTL-00001",
      status: "signed",
      issuedByPartyId: AGENT_PARTY,
      expiresAt: new Date("2026-12-31T00:00:00Z"),
      publicToken: "reservation-tenant-link-token",
      propertyId: PROPERTY,
      unitId: UNIT,
      proposedMoveIn: new Date("2026-06-01T00:00:00Z"),
      reservationDeposit: "500.00",
      documentationFee: "100.00",
      rentalDeposit: "2400.00",
      utilityDeposit: "300.00",
      accessCardDeposit: "50.00",
    },
  });
}

async function cleanup() {
  const db = getDb();
  await db.unitReservation.deleteMany({ where: { organizationId: ORG } });
  await db.listing.deleteMany({ where: { organizationId: ORG } });
  await db.apartment.deleteMany({ where: { organizationId: ORG } });
  await db.property.deleteMany({ where: { organizationId: ORG } });
  await db.party.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

dn("UnitReservation.tenantPartyId (integration)", () => {
  beforeEach(async () => {
    await cleanup();
    await seedOrgWithUnit();
  });

  it("column exists and links: set + read back via Prisma", async () => {
    const db = getDb();
    await db.unitReservation.update({
      where: { id: RESERVATION },
      data: { tenantPartyId: TENANT_PARTY },
    });

    const row = await db.unitReservation.findUniqueOrThrow({
      where: { id: RESERVATION },
    });
    expect(row.tenantPartyId).toBe(TENANT_PARTY);

    const withRelation = await db.unitReservation.findUniqueOrThrow({
      where: { id: RESERVATION },
      include: { tenantParty: true },
    });
    expect(withRelation.tenantParty?.id).toBe(TENANT_PARTY);
    expect(withRelation.tenantParty?.displayName).toBe("Tenant");
  });

  it("SetNull on tenant delete: deleting the linked Party nulls tenantPartyId, reservation survives", async () => {
    const db = getDb();
    await db.unitReservation.update({
      where: { id: RESERVATION },
      data: { tenantPartyId: TENANT_PARTY },
    });

    await db.party.delete({ where: { id: TENANT_PARTY } });

    const row = await db.unitReservation.findUniqueOrThrow({
      where: { id: RESERVATION },
    });
    expect(row.tenantPartyId).toBeNull();
    expect(row.id).toBe(RESERVATION);
  });
});
