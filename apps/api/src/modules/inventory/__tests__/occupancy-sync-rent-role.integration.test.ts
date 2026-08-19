/**
 * Integration tests for syncOccupancyTenancy's ENABLE_PHASE2_RESERVATION_GATED_TENANCY
 * gate (T10, R6/R11): under the flag, marking a unit "occupied" must (1) require an
 * EXPLICIT monthlyRent > 0 -- no silent default to unit.rentalRate (the exact
 * silent-inheritance that produced the original wrong-rent incident) -- and (2)
 * validate the chosen tenant by PartyRole (roleType="tenant"), not Party.partyType.
 * Flag off must stay byte-for-byte today's behaviour. Hits a real local Postgres.
 *
 * Skipped by default. Run explicitly:
 *   cd apps/api && RUN_INTEGRATION=1 \
 *     DATABASE_URL="postgresql://yonghongtan@localhost:5432/kason_hub_dev?schema=public" \
 *     npx vitest run occupancy-sync-rent-role
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { getDb } from "@kason/db";

const isPhase2FlagEnabled = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/feature-flags", () => ({ isPhase2FlagEnabled }));

// Import AFTER the mock is registered so syncOccupancyTenancy picks up the
// mocked isPhase2FlagEnabled binding.
import { syncOccupancyTenancy } from "../occupancy-tenancy-sync";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  // This suite creates real Tenancy rows. Refuse to run against anything but
  // the local dev DB, even by accident (money-critical write path).
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`occupancy-sync-rent-role.integration.test.ts: refusing non-local DB host "${host}"`);
  }
}

const ORG = "a1111111-1111-4111-8111-000000000001";
const PROPERTY = "a1111111-1111-4111-8111-000000000002";
const APARTMENT = "a1111111-1111-4111-8111-000000000003";
const UNIT = "a1111111-1111-4111-8111-000000000004";
const OWNER_PARTY = "a1111111-1111-4111-8111-000000000005";
// Holds BOTH partyType="tenant" (old-path key) AND a tenant PartyRole (new-path
// key), so it passes tenant validation under either flag state -- isolates the
// rent assertion in "requires explicit rent" from the role-check change.
const TENANT_PARTY_BY_TYPE = "a1111111-1111-4111-8111-000000000006";
// partyType="individual" (deliberately NOT "tenant") + a tenant PartyRole --
// proves the role check accepts a party the OLD partyType check would reject.
const TENANT_PARTY_BY_ROLE = "a1111111-1111-4111-8111-000000000007";
// partyType="tenant" but NO tenant PartyRole -- the migration-gap case that
// currently 500s under the flag. Self-heal must create the role and proceed.
const TENANT_PARTY_TYPE_NO_ROLE = "a1111111-1111-4111-8111-000000000008";
// partyType="individual" AND no tenant role -- a genuine non-tenant. Self-heal
// must NOT accept it; the reject-and-throw stays.
const NON_TENANT_NO_ROLE = "a1111111-1111-4111-8111-000000000009";

async function cleanup() {
  const db = getDb();
  await db.tenancy.deleteMany({ where: { organizationId: ORG } });
  await db.partyRole.deleteMany({ where: { organizationId: ORG } });
  await db.listing.deleteMany({ where: { organizationId: ORG } });
  await db.apartment.deleteMany({ where: { organizationId: ORG } });
  await db.property.deleteMany({ where: { organizationId: ORG } });
  await db.party.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function seed() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG,
      name: "Occupancy Rent Role Test Org",
      slug: "occ-rent-role-test-org-t10",
      status: "active",
      defaultCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur",
      locale: "en-MY",
      subscriptionPlan: "free",
    },
  });
  await db.party.create({
    data: { id: OWNER_PARTY, organizationId: ORG, displayName: "Owner Co", partyType: "owner", status: "active" },
  });
  await db.property.create({
    data: {
      id: PROPERTY,
      organizationId: ORG,
      name: "Occupancy Rent Role Test Property",
      propertyCode: "ORR10-1",
      propertyType: "residential",
      addressLine1: "1 Occupancy St",
      city: "Kuala Lumpur",
      country: "MY",
      status: "active",
      publishStatus: "draft",
    },
  });
  await db.apartment.create({
    data: { id: APARTMENT, organizationId: ORG, propertyId: PROPERTY, unitCode: "ORR-101", listingMode: "WHOLE" },
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
      ownerPartyId: OWNER_PARTY,
      rentalRate: 2800,
    },
  });
  await db.party.create({
    data: { id: TENANT_PARTY_BY_TYPE, organizationId: ORG, displayName: "Tenant By Type", partyType: "tenant", status: "active" },
  });
  await db.partyRole.create({
    data: { organizationId: ORG, partyId: TENANT_PARTY_BY_TYPE, roleType: "tenant", status: "active" },
  });
  await db.party.create({
    data: { id: TENANT_PARTY_BY_ROLE, organizationId: ORG, displayName: "Tenant By Role Only", partyType: "individual", status: "active" },
  });
  await db.partyRole.create({
    data: { organizationId: ORG, partyId: TENANT_PARTY_BY_ROLE, roleType: "tenant", status: "active" },
  });
  // partyType="tenant" but deliberately NO PartyRole -- the self-heal case.
  await db.party.create({
    data: { id: TENANT_PARTY_TYPE_NO_ROLE, organizationId: ORG, displayName: "Tenant Type No Role", partyType: "tenant", status: "active" },
  });
  // Genuine non-tenant, no role -- must stay rejected.
  await db.party.create({
    data: { id: NON_TENANT_NO_ROLE, organizationId: ORG, displayName: "Not A Tenant", partyType: "individual", status: "active" },
  });
}

dn("syncOccupancyTenancy — explicit rent + tenant-by-role under flag (T10, R6/R11, integration)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await cleanup();
    await seed();
  });

  it("requires explicit rent", async () => {
    isPhase2FlagEnabled.mockReturnValue(true);
    const db = getDb();

    await expect(
      syncOccupancyTenancy({
        tx: db as unknown as never,
        orgId: ORG,
        unit: { id: UNIT, propertyId: PROPERTY, occupancyStatus: "vacant", rentalRate: 2800, ownerPartyId: OWNER_PARTY },
        incoming: {
          occupancyStatus: "occupied",
          tenantPartyId: TENANT_PARTY_BY_TYPE,
          moveInDate: new Date("2026-08-01"),
          moveOutDate: new Date("2026-08-31"),
          // monthlyRent deliberately omitted.
        },
      }),
    ).rejects.toThrow(/OCCUPANCY_RENT_REQUIRED|explicit monthlyRent/i);

    // No tenancy at all -- NOT the silently-defaulted 2800, and NOT a 0.
    const rows = await db.tenancy.findMany({ where: { organizationId: ORG, unitId: UNIT } });
    expect(rows).toHaveLength(0);
  });

  it("tenant by role", async () => {
    isPhase2FlagEnabled.mockReturnValue(true);
    const db = getDb();

    await syncOccupancyTenancy({
      tx: db as unknown as never,
      orgId: ORG,
      unit: { id: UNIT, propertyId: PROPERTY, occupancyStatus: "vacant", rentalRate: 2800, ownerPartyId: OWNER_PARTY },
      incoming: {
        occupancyStatus: "occupied",
        tenantPartyId: TENANT_PARTY_BY_ROLE,
        moveInDate: new Date("2026-08-01"),
        moveOutDate: new Date("2026-08-31"),
        monthlyRent: 3200,
      },
    });

    const rows = await db.tenancy.findMany({ where: { organizationId: ORG, unitId: UNIT } });
    expect(rows).toHaveLength(1);
    expect(rows[0].tenantPartyId).toBe(TENANT_PARTY_BY_ROLE);
    expect(rows[0].status).toBe("active");
    expect(rows[0].monthlyRentAmount.toString()).toBe("3200");
  });

  it("flag off unchanged", async () => {
    isPhase2FlagEnabled.mockReturnValue(false);
    const db = getDb();

    await syncOccupancyTenancy({
      tx: db as unknown as never,
      orgId: ORG,
      unit: { id: UNIT, propertyId: PROPERTY, occupancyStatus: "vacant", rentalRate: 2800, ownerPartyId: OWNER_PARTY },
      incoming: {
        occupancyStatus: "occupied",
        tenantPartyId: TENANT_PARTY_BY_TYPE,
        moveInDate: new Date("2026-08-01"),
        moveOutDate: new Date("2026-08-31"),
        // No monthlyRent supplied -- today's behaviour silently defaults to rentalRate.
      },
    });

    const rows = await db.tenancy.findMany({ where: { organizationId: ORG, unitId: UNIT } });
    expect(rows).toHaveLength(1);
    expect(rows[0].tenantPartyId).toBe(TENANT_PARTY_BY_TYPE);
    expect(rows[0].monthlyRentAmount.toString()).toBe("2800");
  });

  it("self-heals a partyType=tenant party missing its tenant role", async () => {
    isPhase2FlagEnabled.mockReturnValue(true);
    const db = getDb();

    const before = await db.partyRole.findMany({
      where: { organizationId: ORG, partyId: TENANT_PARTY_TYPE_NO_ROLE, roleType: "tenant" },
    });
    expect(before).toHaveLength(0);

    await syncOccupancyTenancy({
      tx: db as unknown as never,
      orgId: ORG,
      unit: { id: UNIT, propertyId: PROPERTY, occupancyStatus: "vacant", rentalRate: 2800, ownerPartyId: OWNER_PARTY },
      incoming: {
        occupancyStatus: "occupied",
        tenantPartyId: TENANT_PARTY_TYPE_NO_ROLE,
        moveInDate: new Date("2026-08-01"),
        moveOutDate: new Date("2026-08-31"),
        monthlyRent: 3000,
      },
    });

    // The save succeeds (was a 500) and the tenancy is created.
    const rows = await db.tenancy.findMany({ where: { organizationId: ORG, unitId: UNIT } });
    expect(rows).toHaveLength(1);
    expect(rows[0].tenantPartyId).toBe(TENANT_PARTY_TYPE_NO_ROLE);
    // Exactly one tenant role now exists -- self-healed, not duplicated.
    const after = await db.partyRole.findMany({
      where: { organizationId: ORG, partyId: TENANT_PARTY_TYPE_NO_ROLE, roleType: "tenant" },
    });
    expect(after).toHaveLength(1);
    expect(after[0].status).toBe("active");
  });

  it("still rejects a party that is not a tenant and has no role", async () => {
    isPhase2FlagEnabled.mockReturnValue(true);
    const db = getDb();

    await expect(
      syncOccupancyTenancy({
        tx: db as unknown as never,
        orgId: ORG,
        unit: { id: UNIT, propertyId: PROPERTY, occupancyStatus: "vacant", rentalRate: 2800, ownerPartyId: OWNER_PARTY },
        incoming: {
          occupancyStatus: "occupied",
          tenantPartyId: NON_TENANT_NO_ROLE,
          moveInDate: new Date("2026-08-01"),
          moveOutDate: new Date("2026-08-31"),
          monthlyRent: 3000,
        },
      }),
    ).rejects.toThrow(/does not hold a tenant role/i);

    // No tenancy, and NO role silently minted for a non-tenant.
    const rows = await db.tenancy.findMany({ where: { organizationId: ORG, unitId: UNIT } });
    expect(rows).toHaveLength(0);
    const roles = await db.partyRole.findMany({ where: { organizationId: ORG, partyId: NON_TENANT_NO_ROLE } });
    expect(roles).toHaveLength(0);
  });

  it("logs a warning naming the party when backfilling the missing role", async () => {
    isPhase2FlagEnabled.mockReturnValue(true);
    const db = getDb();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await syncOccupancyTenancy({
      tx: db as unknown as never,
      orgId: ORG,
      unit: { id: UNIT, propertyId: PROPERTY, occupancyStatus: "vacant", rentalRate: 2800, ownerPartyId: OWNER_PARTY },
      incoming: {
        occupancyStatus: "occupied",
        tenantPartyId: TENANT_PARTY_TYPE_NO_ROLE,
        moveInDate: new Date("2026-08-01"),
        moveOutDate: new Date("2026-08-31"),
        monthlyRent: 3000,
      },
    });

    const logged = warn.mock.calls.map((c) => c.join(" ")).join("\n");
    warn.mockRestore();
    expect(logged).toContain(TENANT_PARTY_TYPE_NO_ROLE);
  });
});
