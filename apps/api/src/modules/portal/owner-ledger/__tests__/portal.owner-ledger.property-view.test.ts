/**
 * Integration test for getOwnerPropertyView — CROSS-OWNER LEAK regression.
 *
 * This endpoint (GET /portal/owner-ledger/properties/:id) previously resolved
 * owner→units the property-level way (active LandlordTenancy + EVERY listing in
 * the property). In a multi-owner building that leaked co-owners' units —
 * tenant displayName, rent, deposits. The route test mocks getOwnerPropertyView
 * so it cannot catch the leak; this hits a real DB.
 *
 * Requires a real local Postgres with all Phase-2 migrations applied.
 *
 * Skipped by default. Run explicitly:
 *   RUN_INTEGRATION=1 DATABASE_URL="postgresql://yonghongtan@localhost:5432/kason_hub_dev" \
 *     npx vitest run src/modules/portal/owner-ledger/__tests__
 *
 * Setup: ONE property, TWO apartments each with one whole-unit listing owned by
 * a DIFFERENT owner (Listing.ownerPartyId + a PartyRole(owner) each), each with
 * an active tenancy + held deposit. Asserts:
 *   - getOwnerPropertyView(ownerA, prop) returns ONLY owner A's unit; never
 *     owner B's unitCode or tenant.
 *   - same for owner B (symmetry).
 *   - an owner with NO listing in the property gets null (404).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getDb } from "@kason/db";
import { getOwnerPropertyView } from "../portal.owner-ledger.repository";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

// ─── Stable fixture UUIDs ─────────────────────────────────────────────────────
// Prefix "dddddddd" (portal property-view) to avoid colliding with other suites.
// (Must be valid hex — earlier non-hex prefixes are rejected by Postgres uuid.)

const ORG = "dddddddd-0000-4000-8000-000000000001";

const OWNER_A = "dddddddd-0000-4000-8000-000000000010";
const OWNER_B = "dddddddd-0000-4000-8000-000000000011";
const OWNER_C = "dddddddd-0000-4000-8000-000000000012"; // owns nothing here → null

const TENANT_A = "dddddddd-0000-4000-8000-000000000018";
const TENANT_B = "dddddddd-0000-4000-8000-000000000019";

const PROPERTY = "dddddddd-0000-4000-8000-000000000020"; // ONE shared, multi-owner property

const APT_A = "dddddddd-0000-4000-8000-000000000030"; // unit A-01, owned by OWNER_A
const APT_B = "dddddddd-0000-4000-8000-000000000031"; // unit B-01, owned by OWNER_B

const LISTING_A = "dddddddd-0000-4000-8000-000000000060";
const LISTING_B = "dddddddd-0000-4000-8000-000000000061";

const TENANCY_A = "dddddddd-0000-4000-8000-000000000070";
const TENANCY_B = "dddddddd-0000-4000-8000-000000000071";

const DEPOSIT_A = "dddddddd-0000-4000-8000-000000000080";
const DEPOSIT_B = "dddddddd-0000-4000-8000-000000000081";

// ─── Seed / teardown ──────────────────────────────────────────────────────────

async function seedAll() {
  const db = getDb();

  await db.organization.upsert({
    where: { id: ORG },
    create: {
      id: ORG,
      name: "PropView Test Org",
      slug: `pv-${ORG.slice(0, 8)}`,
      status: "active",
      defaultCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur",
      locale: "en-MY",
      subscriptionPlan: "free",
    },
    update: {},
  });

  // Parties: two owners + a third owner who owns nothing, plus two tenants.
  for (const [id, partyType, displayName] of [
    [OWNER_A, "owner", "Alice Owner"],
    [OWNER_B, "owner", "Bob Owner"],
    [OWNER_C, "owner", "Carol Owner"],
    [TENANT_A, "tenant", "Tan Wei (A tenant)"],
    [TENANT_B, "tenant", "Lim Hua (B tenant)"],
  ] as [string, string, string][]) {
    await db.party.upsert({
      where: { id },
      create: { id, organizationId: ORG, partyType, displayName, status: "active" },
      update: {},
    });
  }

  // PartyRole(owner) for each owner (the re-point pattern pairs ownerPartyId on
  // the Listing with an owner PartyRole).
  for (const owner of [OWNER_A, OWNER_B, OWNER_C]) {
    await db.partyRole.upsert({
      where: { id: `${owner}` /* role id reuses party id for stability */ },
      create: { id: owner, organizationId: ORG, partyId: owner, roleType: "owner", status: "active" },
      update: {},
    });
  }

  // ONE property, shared across both owners.
  await db.property.upsert({
    where: { id: PROPERTY },
    create: {
      id: PROPERTY,
      organizationId: ORG,
      name: "Shared Tower",
      propertyCode: `PC-PV${PROPERTY.slice(-6)}`,
      propertyType: "residential",
      addressLine1: "1 Test St",
      city: "KL",
      country: "MY",
      status: "active",
      publishStatus: "published",
    },
    update: {},
  });

  // Two apartments (units) in that property.
  for (const [id, code] of [
    [APT_A, "A-01"],
    [APT_B, "B-01"],
  ] as [string, string][]) {
    await db.apartment.upsert({
      where: { id },
      create: { id, organizationId: ORG, propertyId: PROPERTY, unitCode: code, listingMode: "WHOLE" },
      update: {},
    });
  }

  // One whole-unit listing per apartment, owned by a DIFFERENT owner.
  for (const [id, aptId, owner] of [
    [LISTING_A, APT_A, OWNER_A],
    [LISTING_B, APT_B, OWNER_B],
  ] as [string, string, string][]) {
    await db.listing.upsert({
      where: { id },
      create: {
        id,
        organizationId: ORG,
        apartmentId: aptId,
        listingType: "whole",
        occupancyStatus: "occupied",
        listingStatus: "active",
        currency: "MYR",
        ownerPartyId: owner,
      },
      update: {},
    });
  }

  // One active tenancy per listing (distinct tenant displayName per owner —
  // this is the field the leak exposed).
  for (const [id, unitId, tenant, code] of [
    [TENANCY_A, LISTING_A, TENANT_A, "TC-PV-A"],
    [TENANCY_B, LISTING_B, TENANT_B, "TC-PV-B"],
  ] as [string, string, string, string][]) {
    await db.tenancy.upsert({
      where: { id },
      create: {
        id,
        organizationId: ORG,
        propertyId: PROPERTY,
        unitId,
        tenantPartyId: tenant,
        tenancyCode: code,
        status: "active",
        billingStatus: "current",
        startDate: new Date("2025-01-01"),
        monthlyRentAmount: "2000.00",
      },
      update: {},
    });
  }

  // One held deposit per tenancy (also leaked previously).
  for (const [id, tenancyId, party, unitId] of [
    [DEPOSIT_A, TENANCY_A, TENANT_A, LISTING_A],
    [DEPOSIT_B, TENANCY_B, TENANT_B, LISTING_B],
  ] as [string, string, string, string][]) {
    await db.deposit.upsert({
      where: { id },
      create: {
        id,
        organizationId: ORG,
        tenancyId,
        partyId: party,
        unitId,
        type: "security",
        amount: "4000.00",
        status: "held",
      },
      update: {},
    });
  }
}

async function teardownAll() {
  const db = getDb();
  await db.deposit.deleteMany({ where: { organizationId: ORG } });
  await db.tenancy.deleteMany({ where: { organizationId: ORG } });
  await db.listing.deleteMany({ where: { organizationId: ORG } });
  await db.apartment.deleteMany({ where: { organizationId: ORG } });
  await db.property.deleteMany({ where: { organizationId: ORG } });
  await db.partyRole.deleteMany({ where: { organizationId: ORG } });
  await db.party.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

dn("getOwnerPropertyView — cross-owner isolation (per-unit ownerPartyId)", () => {
  beforeAll(async () => {
    await teardownAll();
    await seedAll();
  });

  afterAll(async () => {
    await teardownAll();
  });

  it("owner A sees ONLY A's unit — never owner B's unitCode or tenant", async () => {
    const view = await getOwnerPropertyView(ORG, OWNER_A, PROPERTY);
    expect(view).not.toBeNull();
    // Exactly one unit, and it's A's.
    expect(view!.units).toHaveLength(1);
    expect(view!.units[0]!.unitCode).toBe("A-01");
    expect(view!.units[0]!.currentTenancy?.tenantDisplayName).toBe("Tan Wei (A tenant)");
    // Owner B's unit + tenant + deposit are absent (the leak fix).
    const codes = view!.units.map((u) => u.unitCode);
    expect(codes).not.toContain("B-01");
    const tenants = view!.units.map((u) => u.currentTenancy?.tenantDisplayName);
    expect(tenants).not.toContain("Lim Hua (B tenant)");
  });

  it("owner B sees ONLY B's unit — symmetric isolation", async () => {
    const view = await getOwnerPropertyView(ORG, OWNER_B, PROPERTY);
    expect(view).not.toBeNull();
    expect(view!.units).toHaveLength(1);
    expect(view!.units[0]!.unitCode).toBe("B-01");
    expect(view!.units[0]!.currentTenancy?.tenantDisplayName).toBe("Lim Hua (B tenant)");
    const codes = view!.units.map((u) => u.unitCode);
    expect(codes).not.toContain("A-01");
  });

  it("owner with NO listing in the property gets null (404)", async () => {
    const view = await getOwnerPropertyView(ORG, OWNER_C, PROPERTY);
    expect(view).toBeNull();
  });
});
