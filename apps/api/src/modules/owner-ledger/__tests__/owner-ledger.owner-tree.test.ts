/**
 * Integration tests for resolveOwnerTree (owner-ledger.repository.ts).
 *
 * Requires a real local Postgres with all Phase-2 migrations applied.
 *
 * Skipped by default in `npx vitest run`. Run explicitly:
 *   RUN_INTEGRATION=1 DATABASE_URL="postgresql://yonghongtan@localhost:5432/kason_hub_dev" \
 *     npx vitest run apps/api/src/modules/owner-ledger
 *
 * Setup: creates a minimal org + owner party + property + apartments + listings
 * + tenancies for clean-slate isolation; removes all in afterAll.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getDb } from "@kason/db";
import { resolveOwnerTree } from "../owner-ledger.repository";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

// ─── Stable test fixture UUIDs ────────────────────────────────────────────────

const ORG = "bbbbbbbb-0000-4000-8000-000000000001";
const OWNER_PARTY = "bbbbbbbb-0000-4000-8000-000000000002";
const OTHER_OWNER_PARTY = "bbbbbbbb-0000-4000-8000-000000000003";
const PROPERTY = "bbbbbbbb-0000-4000-8000-000000000004";
const APT_WHOLE = "bbbbbbbb-0000-4000-8000-000000000005";
const APT_PART = "bbbbbbbb-0000-4000-8000-000000000006";
const LISTING_WHOLE = "bbbbbbbb-0000-4000-8000-000000000010";
const LISTING_ROOM_OCCUPIED = "bbbbbbbb-0000-4000-8000-000000000011";
const LISTING_ROOM_VACANT = "bbbbbbbb-0000-4000-8000-000000000012";
const LISTING_ARCHIVED = "bbbbbbbb-0000-4000-8000-000000000014";
const TENANT_PARTY = "bbbbbbbb-0000-4000-8000-000000000020";
const TENANCY_WHOLE = "bbbbbbbb-0000-4000-8000-000000000030";
const TENANCY_ROOM = "bbbbbbbb-0000-4000-8000-000000000031";

// ─── Seed / teardown ──────────────────────────────────────────────────────────

async function seedAll() {
  const db = getDb();

  // 1. Organisation
  await db.organization.upsert({
    where: { id: ORG },
    create: {
      id: ORG,
      name: "OwnerTree Test Org",
      slug: `owner-tree-test-${ORG.slice(0, 8)}`,
      status: "active",
      defaultCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur",
      locale: "en-MY",
      subscriptionPlan: "free",
    },
    update: {},
  });

  // 2. Owner party
  await db.party.upsert({
    where: { id: OWNER_PARTY },
    create: {
      id: OWNER_PARTY,
      organizationId: ORG,
      partyType: "owner",
      displayName: "Test Owner",
      status: "active",
    },
    update: {},
  });

  // 3. Other owner party (cross-owner isolation test)
  await db.party.upsert({
    where: { id: OTHER_OWNER_PARTY },
    create: {
      id: OTHER_OWNER_PARTY,
      organizationId: ORG,
      partyType: "owner",
      displayName: "Other Owner",
      status: "active",
    },
    update: {},
  });

  // 4. Property
  await db.property.upsert({
    where: { id: PROPERTY },
    create: {
      id: PROPERTY,
      organizationId: ORG,
      name: "Test Property",
      propertyCode: `TP-${ORG.slice(0, 6)}`,
      propertyType: "residential",
      addressLine1: "123 Test St",
      city: "Kuala Lumpur",
      country: "MY",
      status: "active",
      publishStatus: "published",
    },
    update: {},
  });

  // 5. LandlordTenancy linking owner to property
  await db.landlordTenancy.upsert({
    where: { id: "bbbbbbbb-0000-4000-8000-000000000040" },
    create: {
      id: "bbbbbbbb-0000-4000-8000-000000000040",
      organizationId: ORG,
      propertyId: PROPERTY,
      landlordId: OWNER_PARTY,
      startDate: new Date("2024-01-01"),
      monthlyRent: "0",
      status: "active",
    },
    update: {},
  });

  // 6. Apartment WHOLE
  await db.apartment.upsert({
    where: { id: APT_WHOLE },
    create: {
      id: APT_WHOLE,
      organizationId: ORG,
      propertyId: PROPERTY,
      unitCode: "A-01",
      listingMode: "WHOLE",
    },
    update: {},
  });

  // 7. Apartment PARTITIONED
  await db.apartment.upsert({
    where: { id: APT_PART },
    create: {
      id: APT_PART,
      organizationId: ORG,
      propertyId: PROPERTY,
      unitCode: "A-02",
      listingMode: "PARTITIONED",
    },
    update: {},
  });

  // 8. Listing for WHOLE apartment (occupied, non-archived, non-carpark)
  await db.listing.upsert({
    where: { id: LISTING_WHOLE },
    create: {
      id: LISTING_WHOLE,
      organizationId: ORG,
      apartmentId: APT_WHOLE,
      listingType: "master",
      occupancyStatus: "occupied",
      listingStatus: "active",
      currency: "MYR",
      ownerPartyId: OWNER_PARTY,
    },
    update: {},
  });

  // 9. Tenant party
  await db.party.upsert({
    where: { id: TENANT_PARTY },
    create: {
      id: TENANT_PARTY,
      organizationId: ORG,
      partyType: "tenant",
      displayName: "Alice Tenant",
      status: "active",
    },
    update: {},
  });

  // 10. Active tenancy on the WHOLE listing
  await db.tenancy.upsert({
    where: { id: TENANCY_WHOLE },
    create: {
      id: TENANCY_WHOLE,
      organizationId: ORG,
      propertyId: PROPERTY,
      unitId: LISTING_WHOLE,
      tenantPartyId: TENANT_PARTY,
      tenancyCode: `TC-WHOLE-${ORG.slice(0, 6)}`,
      status: "active",
      billingStatus: "current",
      startDate: new Date("2025-01-01"),
      monthlyRentAmount: "1200",
    },
    update: {},
  });

  // 11. Occupied room listing (PARTITIONED, real room)
  await db.listing.upsert({
    where: { id: LISTING_ROOM_OCCUPIED },
    create: {
      id: LISTING_ROOM_OCCUPIED,
      organizationId: ORG,
      apartmentId: APT_PART,
      listingType: "medium",
      occupancyStatus: "occupied",
      listingStatus: "active",
      currency: "MYR",
      ownerPartyId: OWNER_PARTY,
    },
    update: {},
  });

  // 12. Active tenancy on the occupied room
  await db.tenancy.upsert({
    where: { id: TENANCY_ROOM },
    create: {
      id: TENANCY_ROOM,
      organizationId: ORG,
      propertyId: PROPERTY,
      unitId: LISTING_ROOM_OCCUPIED,
      tenantPartyId: TENANT_PARTY,
      tenancyCode: `TC-ROOM-${ORG.slice(0, 6)}`,
      status: "active",
      billingStatus: "current",
      startDate: new Date("2025-01-01"),
      monthlyRentAmount: "700",
    },
    update: {},
  });

  // 13. Vacant room listing (PARTITIONED, no tenancy)
  await db.listing.upsert({
    where: { id: LISTING_ROOM_VACANT },
    create: {
      id: LISTING_ROOM_VACANT,
      organizationId: ORG,
      apartmentId: APT_PART,
      listingType: "small",
      occupancyStatus: "vacant",
      listingStatus: "active",
      currency: "MYR",
      ownerPartyId: OWNER_PARTY,
    },
    update: {},
  });

  // 14. Archived listing — must be EXCLUDED
  await db.listing.upsert({
    where: { id: LISTING_ARCHIVED },
    create: {
      id: LISTING_ARCHIVED,
      organizationId: ORG,
      apartmentId: APT_PART,
      listingType: "master",
      occupancyStatus: "vacant",
      listingStatus: "archived",
      currency: "MYR",
      // Owned by the same owner — proves archived is excluded by listingStatus, NOT by ownership.
      ownerPartyId: OWNER_PARTY,
    },
    update: {},
  });
}

async function teardownAll() {
  const db = getDb();
  // Delete in reverse FK order
  await db.tenancy.deleteMany({ where: { organizationId: ORG } });
  await db.listing.deleteMany({ where: { organizationId: ORG } });
  await db.apartment.deleteMany({ where: { organizationId: ORG } });
  await db.landlordTenancy.deleteMany({ where: { organizationId: ORG } });
  await db.property.deleteMany({ where: { organizationId: ORG } });
  await db.party.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

dn("resolveOwnerTree — integration", () => {
  beforeAll(async () => {
    await teardownAll();
    await seedAll();
  });

  afterAll(async () => {
    await teardownAll();
  });

  it("(a) returns both properties with correct structure", async () => {
    const tree = await resolveOwnerTree(ORG, OWNER_PARTY);
    expect(tree.properties).toHaveLength(1);
    const prop = tree.properties[0]!;
    expect(prop.id).toBe(PROPERTY);
    expect(prop.name).toBe("Test Property");
    expect(prop.units).toHaveLength(2);
  });

  it("(b) WHOLE apartment has one room with occupied tenancy", async () => {
    const tree = await resolveOwnerTree(ORG, OWNER_PARTY);
    const wholeUnit = tree.properties[0]!.units.find((u) => u.apartmentId === APT_WHOLE)!;
    expect(wholeUnit.listingMode).toBe("WHOLE");
    expect(wholeUnit.rooms).toHaveLength(1);
    const room = wholeUnit.rooms[0]!;
    expect(room.listingId).toBe(LISTING_WHOLE);
    expect(room.tenancy).not.toBeNull();
    expect(room.tenancy!.tenancyId).toBe(TENANCY_WHOLE);
    expect(room.tenancy!.tenantDisplayName).toBe("Alice Tenant");
  });

  it("(c) PARTITIONED apartment: archived listings excluded", async () => {
    const tree = await resolveOwnerTree(ORG, OWNER_PARTY);
    const partUnit = tree.properties[0]!.units.find((u) => u.apartmentId === APT_PART)!;
    expect(partUnit.listingMode).toBe("PARTITIONED");
    // Only the two room listings (occupied + vacant) should appear; archived is excluded
    expect(partUnit.rooms).toHaveLength(2);
    const listingIds = partUnit.rooms.map((r) => r.listingId).sort();
    expect(listingIds).toEqual([LISTING_ROOM_OCCUPIED, LISTING_ROOM_VACANT].sort());
  });

  it("(d) vacant room has tenancy: null", async () => {
    const tree = await resolveOwnerTree(ORG, OWNER_PARTY);
    const partUnit = tree.properties[0]!.units.find((u) => u.apartmentId === APT_PART)!;
    const vacantRoom = partUnit.rooms.find((r) => r.listingId === LISTING_ROOM_VACANT)!;
    expect(vacantRoom.tenancy).toBeNull();
  });

  it("(e) occupied room carries active tenancy", async () => {
    const tree = await resolveOwnerTree(ORG, OWNER_PARTY);
    const partUnit = tree.properties[0]!.units.find((u) => u.apartmentId === APT_PART)!;
    const occupiedRoom = partUnit.rooms.find((r) => r.listingId === LISTING_ROOM_OCCUPIED)!;
    expect(occupiedRoom.tenancy).not.toBeNull();
    expect(occupiedRoom.tenancy!.tenancyId).toBe(TENANCY_ROOM);
    expect(occupiedRoom.tenancy!.tenantDisplayName).toBe("Alice Tenant");
  });

  it("(f) cross-owner request: returns empty properties array", async () => {
    const tree = await resolveOwnerTree(ORG, OTHER_OWNER_PARTY);
    expect(tree.properties).toHaveLength(0);
  });
});
