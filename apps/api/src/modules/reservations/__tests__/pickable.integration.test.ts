/**
 * Integration test for GET /api/admin/reservations/pickable (T3).
 * Hits a real Postgres. Verifies listPickableReservationsService returns
 * only SIGNED reservations with tenantPartyId IS NULL, with the applicant's
 * NRIC masked before it ever leaves the service layer.
 *
 * Skipped by default. Run explicitly:
 *   RUN_INTEGRATION=1 DATABASE_URL="..." \
 *     npx vitest run pickable
 */
import { describe, it, expect, beforeEach } from "vitest";
import { getDb } from "@kason/db";
import { listPickableReservationsService } from "../service";
import { maskIdNumber } from "../../../lib/ic-reveal";
import type { ReservationSession } from "../types";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

const ORG = "bb111111-1111-1111-1111-111111111111";
const AGENT_PARTY = "bb222222-2222-2222-2222-222222222222";
const TENANT_PARTY = "bb333333-3333-3333-3333-333333333333";
const PROPERTY = "bb444444-4444-4444-4444-444444444444";
const APARTMENT = "bb555555-5555-5555-5555-555555555555";
const UNIT = "bb666666-6666-6666-6666-666666666666";
const RESERVATION_UNLINKED = "bb777777-7777-7777-7777-777777777777";
const RESERVATION_LINKED = "bb888888-8888-8888-8888-888888888888";
const RESERVATION_PENDING = "bb999999-9999-9999-9999-999999999999";

const APPLICANT_NRIC = "901231-14-5566";

const SESSION: ReservationSession = {
  orgId: ORG,
  userId: "bb000000-0000-0000-0000-000000000001",
  partyId: AGENT_PARTY,
  role: "admin",
  operatorRole: "admin",
};

async function seedOrgWithReservations() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG,
      name: "Test",
      slug: "pickable-reservations",
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
      propertyCode: "PKB-1",
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
      unitCode: "PKB-101",
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
    applicantFullName: "Jane Applicant",
    applicantNric: APPLICANT_NRIC,
    applicantContact: "0123456789",
    applicantEmail: "jane@example.com",
  };

  await db.unitReservation.create({
    data: {
      ...base,
      id: RESERVATION_UNLINKED,
      referenceCode: "PKB-00001",
      status: "signed",
      publicToken: "pickable-unlinked-token",
    },
  });
  await db.unitReservation.create({
    data: {
      ...base,
      id: RESERVATION_LINKED,
      referenceCode: "PKB-00002",
      status: "signed",
      publicToken: "pickable-linked-token",
      tenantPartyId: TENANT_PARTY,
    },
  });
  await db.unitReservation.create({
    data: {
      ...base,
      id: RESERVATION_PENDING,
      referenceCode: "PKB-00003",
      status: "pending_customer",
      publicToken: "pickable-pending-token",
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

dn("GET /api/admin/reservations/pickable (integration)", () => {
  beforeEach(async () => {
    await cleanup();
    await seedOrgWithReservations();
  });

  it("lists signed unlinked reservations, NRIC masked", async () => {
    const data = await listPickableReservationsService(SESSION);
    const row = data.find((r) => r.id === RESERVATION_UNLINKED);
    expect(row).toBeDefined();
    expect(row!.applicant.nricMasked).toBe(maskIdNumber(APPLICANT_NRIC));
    expect(row!.applicant.nricMasked).not.toBe(APPLICANT_NRIC);
    expect(row!.applicant.nricMasked).not.toContain("901231");
    expect(row!.unit.label).toContain("PKB-101");
  });

  it("excludes linked reservations (tenantPartyId set)", async () => {
    const data = await listPickableReservationsService(SESSION);
    expect(data.some((r) => r.id === RESERVATION_LINKED)).toBe(false);
  });

  it("excludes unsigned (pending_customer) reservations", async () => {
    const data = await listPickableReservationsService(SESSION);
    expect(data.some((r) => r.id === RESERVATION_PENDING)).toBe(false);
  });
});
