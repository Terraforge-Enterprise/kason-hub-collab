/**
 * Integration test for `hasReservation` on the tenant list (T5, R3). Hits a
 * real Postgres. Verifies getTenantsService derives `hasReservation` from
 * the `reservationsCreatedFrom` back-relation (T2's UnitReservation.tenantPartyId
 * link) — status-independent, link-based per spec R3.
 *
 * Seed pattern (fixed UUIDs, dn/RUN gate, explicit cleanup) mirrors
 * tenant-from-reservation.integration.test.ts, extended with a
 * PartyRole("tenant") row per party since listTenants() filters on
 * `roles: { some: { roleType: "tenant" } }`.
 *
 * Skipped by default. Run explicitly:
 *   RUN_INTEGRATION=1 DATABASE_URL="postgresql://yonghongtan@localhost:5432/kason_hub_dev?schema=public" \
 *     npx vitest run tenant-has-reservation
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getDb } from "@kason/db";
import { getTenantsService } from "../parties.service";
import type { PartiesSession } from "../parties.types";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

const ORG = "ee111111-1111-1111-1111-111111111111";
const AGENT_PARTY = "ee222222-2222-2222-2222-222222222222";
const TENANT_TAGGED = "ee333333-3333-3333-3333-333333333333";
const TENANT_UNTAGGED = "ee444444-4444-4444-4444-444444444444";
const PROPERTY = "ee555555-5555-5555-5555-555555555555";
const APARTMENT = "ee666666-6666-6666-6666-666666666666";
const UNIT = "ee777777-7777-7777-7777-777777777777";
const RESERVATION = "ee888888-8888-8888-8888-888888888888";

const session: PartiesSession = {
  orgId: ORG,
  userId: "ee000000-0000-0000-0000-000000000001",
  role: "admin",
};

async function seedOrg() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG,
      name: "Test",
      slug: "tenant-has-reservation",
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
      id: TENANT_TAGGED,
      organizationId: ORG,
      displayName: "Tagged Tenant",
      partyType: "tenant",
      status: "active",
    },
  });
  await db.partyRole.create({
    data: { organizationId: ORG, partyId: TENANT_TAGGED, roleType: "tenant", status: "active" },
  });
  await db.party.create({
    data: {
      id: TENANT_UNTAGGED,
      organizationId: ORG,
      displayName: "Untagged Tenant",
      partyType: "tenant",
      status: "active",
    },
  });
  await db.partyRole.create({
    data: { organizationId: ORG, partyId: TENANT_UNTAGGED, roleType: "tenant", status: "active" },
  });
  await db.property.create({
    data: {
      id: PROPERTY,
      organizationId: ORG,
      name: "Test Property",
      propertyCode: "THR-1",
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
      unitCode: "THR-101",
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
      referenceCode: "THR-00001",
      status: "signed",
      issuedByPartyId: AGENT_PARTY,
      expiresAt: new Date("2026-12-31T00:00:00Z"),
      publicToken: "tenant-has-reservation-token",
      propertyId: PROPERTY,
      unitId: UNIT,
      proposedMoveIn: new Date("2026-06-01T00:00:00Z"),
      reservationDeposit: "500.00",
      documentationFee: "100.00",
      rentalDeposit: "2400.00",
      utilityDeposit: "300.00",
      accessCardDeposit: "50.00",
      tenantPartyId: TENANT_TAGGED,
    },
  });
}

async function cleanup() {
  const db = getDb();
  await db.unitReservation.deleteMany({ where: { organizationId: ORG } });
  await db.listing.deleteMany({ where: { organizationId: ORG } });
  await db.apartment.deleteMany({ where: { organizationId: ORG } });
  await db.property.deleteMany({ where: { organizationId: ORG } });
  await db.partyRole.deleteMany({ where: { organizationId: ORG } });
  await db.party.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

dn("getTenantsService — hasReservation tag (integration, R3)", () => {
  beforeEach(async () => {
    await cleanup();
    await seedOrg();
  });
  afterAll(cleanup);

  it("tagged — a tenant linked from a reservation has hasReservation === true", async () => {
    const rows = await getTenantsService(session);
    const tagged = rows.find((r) => r.id === TENANT_TAGGED);
    expect(tagged).toBeDefined();
    expect(tagged?.hasReservation).toBe(true);
  });

  it("untagged — a tenant with no linked reservation has hasReservation === false", async () => {
    const rows = await getTenantsService(session);
    const untagged = rows.find((r) => r.id === TENANT_UNTAGGED);
    expect(untagged).toBeDefined();
    expect(untagged?.hasReservation).toBe(false);
  });
});
