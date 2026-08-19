/**
 * Integration test for cancelReservationService. Hits a real Postgres.
 *
 * Skipped by default. Run explicitly:
 *   RUN_INTEGRATION=1 DATABASE_URL="..." \
 *     npx vitest run apps/api/src/modules/reservations/__tests__/service.cancel.integration.test.ts
 */
import { describe, it, expect, beforeEach } from "vitest";
import { getDb } from "@kason/db";
import { cancelReservationService, createReservationService } from "../service";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

const ORG = "22222222-2222-2222-2222-222222222222";
const AGENT_PARTY = "33333333-3333-3333-3333-333333333333";
const AGENT_USER = "44444444-4444-4444-4444-444444444444";
const OTHER_AGENT_PARTY = "77777777-7777-7777-7777-777777777777";
const OTHER_AGENT_USER = "88888888-8888-8888-8888-888888888888";
const PROPERTY = "55555555-5555-5555-5555-555555555555";
const APARTMENT = "77777777-7777-7777-7777-777777777777";
const UNIT = "66666666-6666-6666-6666-666666666666";

async function seedOrgWithUnit() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG,
      name: "Test",
      slug: "t",
      status: "active",
      defaultCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur",
      locale: "en-MY",
      subscriptionPlan: "free",
      reservationLinkExpiryDays: 7,
    },
  });
  await db.documentTemplate.create({
    data: {
      organizationId: ORG,
      docType: "reservation_form",
      title: "Unit Reservation Form",
      refPrefix: "RES",
      refSeparator: "-",
      refPadding: 5,
      refIncludeYear: false,
      headerFields: {},
      orgAddressLines: [],
    },
  });
  await db.party.createMany({
    data: [
      {
        id: AGENT_PARTY,
        organizationId: ORG,
        displayName: "Agent A",
        partyType: "agent",
        status: "active",
      },
      {
        id: OTHER_AGENT_PARTY,
        organizationId: ORG,
        displayName: "Agent B",
        partyType: "agent",
        status: "active",
      },
    ],
  });
  await db.property.create({
    data: {
      id: PROPERTY,
      organizationId: ORG,
      name: "Test Property",
      propertyCode: "TP-1",
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
      unitCode: "A-101",
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
      currency: "MYR",
      // Agent reservations require a ready-now active listing
      // (service.ts createReservationService agent gate). Without this the
      // setup's agent createReservationService returns 403 and every test
      // early-returns vacuously.
      readyNow: true,
      ownerPartyId: AGENT_PARTY,
    },
  });
}

async function cleanup() {
  const db = getDb();
  await db.unitReservation.deleteMany({ where: { organizationId: ORG } });
  await db.notificationQueue.deleteMany({ where: { organizationId: ORG } });
  await db.referenceSequence.deleteMany({ where: { organizationId: ORG } });
  await db.documentTemplate.deleteMany({ where: { organizationId: ORG } });
  await db.listing.deleteMany({ where: { organizationId: ORG } });
  await db.apartment.deleteMany({ where: { organizationId: ORG } });
  await db.property.deleteMany({ where: { organizationId: ORG } });
  await db.party.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

const SECTION_A = {
  propertyId: PROPERTY,
  unitId: UNIT,
  carPark: null,
  proposedMoveIn: "2026-06-01T00:00:00Z",
  proposedMoveOut: null,
  specialRemarks: null,
  reservationDeposit: "500.00",
  documentationFee: "100.00",
  rentalDeposit: "2400.00",
  utilityDeposit: "300.00",
  accessCardDeposit: "50.00",
  agreedMonthlyRent: "2200.00",
  customerEmail: "customer@example.com",
};

dn("cancelReservationService (integration)", () => {
  beforeEach(async () => {
    await cleanup();
    await seedOrgWithUnit();
  });

  it("cancels a pending_customer reservation by its issuing agent", async () => {
    const created = await createReservationService(
      { orgId: ORG, userId: AGENT_USER, partyId: AGENT_PARTY, role: "agent" },
      SECTION_A,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = await cancelReservationService(
      { orgId: ORG, userId: AGENT_USER, partyId: AGENT_PARTY, role: "agent" },
      created.data.id,
      "Customer changed mind",
    );
    expect(result.ok).toBe(true);

    const row = await getDb().unitReservation.findUniqueOrThrow({
      where: { id: created.data.id },
    });
    expect(row.status).toBe("cancelled");
    expect(row.cancelReason).toBe("Customer changed mind");
    expect(row.cancelledById).toBe(AGENT_USER);
    expect(row.cancelledAt).not.toBeNull();

    const txns = await getDb().unitReservationTransition.findMany({
      where: { reservationId: created.data.id },
      orderBy: { changedAt: "asc" },
    });
    expect(txns.map((t) => t.toStatus)).toEqual(["pending_customer", "cancelled"]);
  });

  it("returns 409 on second cancel attempt", async () => {
    const created = await createReservationService(
      { orgId: ORG, userId: AGENT_USER, partyId: AGENT_PARTY, role: "agent" },
      SECTION_A,
    );
    if (!created.ok) return;

    await cancelReservationService(
      { orgId: ORG, userId: AGENT_USER, partyId: AGENT_PARTY, role: "agent" },
      created.data.id,
      "First cancel",
    );
    const second = await cancelReservationService(
      { orgId: ORG, userId: AGENT_USER, partyId: AGENT_PARTY, role: "agent" },
      created.data.id,
      "Second cancel",
    );
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.status).toBe(409);
  });

  it("returns 403 when a different agent tries to cancel", async () => {
    const created = await createReservationService(
      { orgId: ORG, userId: AGENT_USER, partyId: AGENT_PARTY, role: "agent" },
      SECTION_A,
    );
    if (!created.ok) return;

    const result = await cancelReservationService(
      { orgId: ORG, userId: OTHER_AGENT_USER, partyId: OTHER_AGENT_PARTY, role: "agent" },
      created.data.id,
      "Should not be allowed",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(403);
  });

  it("admin can cancel any reservation in the org", async () => {
    const created = await createReservationService(
      { orgId: ORG, userId: AGENT_USER, partyId: AGENT_PARTY, role: "agent" },
      SECTION_A,
    );
    if (!created.ok) return;

    const result = await cancelReservationService(
      // userId is persisted to UnitReservation.cancelledById (@db.Uuid), so it
      // must be a valid UUID (no FK — the row need not exist in User).
      {
        orgId: ORG,
        userId: "aaaaaaaa-0000-4000-8000-000000000001",
        partyId: "aaaaaaaa-0000-4000-8000-000000000002",
        role: "admin",
      },
      created.data.id,
      "Admin override",
    );
    expect(result.ok).toBe(true);
  });

  it("returns 404 for an id not in this org", async () => {
    const result = await cancelReservationService(
      { orgId: ORG, userId: AGENT_USER, partyId: AGENT_PARTY, role: "agent" },
      "99999999-9999-9999-9999-999999999999",
      "Reason",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(404);
  });
});
