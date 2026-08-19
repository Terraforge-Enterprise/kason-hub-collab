/**
 * Integration test for createReservationService. Hits a real Postgres.
 *
 * Skipped by default. Run explicitly:
 *   RUN_INTEGRATION=1 DATABASE_URL="..." \
 *     npx vitest run apps/api/src/modules/reservations/__tests__/service.create.integration.test.ts
 */
import { describe, it, expect, beforeEach } from "vitest";
import { getDb } from "@kason/db";
import { createReservationService, getReservationForOrg } from "../service";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

const ORG = "22222222-2222-2222-2222-222222222222";
const AGENT_PARTY = "33333333-3333-3333-3333-333333333333";
const UNIT_NO_OWNER = "66666666-6666-6666-6666-666666666677";
const APARTMENT_NO_OWNER = "77777777-7777-7777-7777-777777777788";
const AGENT_USER = "44444444-4444-4444-4444-444444444444";
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
  await db.party.create({
    data: {
      id: AGENT_PARTY,
      organizationId: ORG,
      displayName: "Agent",
      partyType: "agent",
      status: "active",
    },
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
      readyNow: true,
      currency: "MYR",
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

dn("createReservationService (integration)", () => {
  beforeEach(async () => {
    await cleanup();
    await seedOrgWithUnit();
  });

  it("creates a reservation, does NOT auto-email the sign-link, inserts a transition", async () => {
    const result = await createReservationService(
      { orgId: ORG, userId: AGENT_USER, partyId: AGENT_PARTY, role: "agent" },
      {
        propertyId: PROPERTY,
        unitId: UNIT,
        carPark: "P-1",
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
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.referenceCode).toBe("RES-00001");
    expect(result.data.publicToken).toMatch(/^[A-Za-z0-9_-]{22}$/);

    const db = getDb();
    const txns = await db.unitReservationTransition.findMany({
      where: { reservationId: result.data.id },
    });
    expect(txns).toHaveLength(1);
    expect(txns[0].toStatus).toBe("pending_customer");

    // The sign-link is no longer auto-emailed on create — the agent shares it
    // manually from the reservation detail page (service.ts:159, commit
    // 94687060 "manual sign-link sharing"). Assert NO sign-link email queued.
    const emails = await db.notificationQueue.findMany({
      where: { organizationId: ORG, type: "reservation_sign_link" },
    });
    expect(emails).toHaveLength(0);
  });

  it("returns 422 when refPrefix is empty (RefPrefixUnconfiguredError)", async () => {
    await getDb().documentTemplate.update({
      where: { organizationId_docType: { organizationId: ORG, docType: "reservation_form" } },
      data: { refPrefix: "" },
    });
    const result = await createReservationService(
      { orgId: ORG, userId: AGENT_USER, partyId: AGENT_PARTY, role: "agent" },
      {
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
        customerEmail: "x@y.com",
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(422);
    expect(result.error).toMatch(/prefix/i);
  });

  it("stores agreedMonthlyRent on the reservation", async () => {
    const res = await createReservationService(
      { orgId: ORG, userId: AGENT_USER, partyId: AGENT_PARTY, role: "agent" },
      {
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
        customerEmail: "owner@example.com",
        agreedMonthlyRent: "2200",
      },
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      const db = getDb();
      const row = await db.unitReservation.findUniqueOrThrow({ where: { id: res.data.id } });
      expect(row.agreedMonthlyRent?.toString()).toBe("2200");

      // The DTO must surface agreedMonthlyRent so a tenancy can prefill from it.
      const dto = await getReservationForOrg(ORG, res.data.id, {
        orgId: ORG,
        userId: AGENT_USER,
        partyId: AGENT_PARTY,
        role: "admin",
      });
      expect(dto?.agreedMonthlyRent).toBe("2200");
    }
  });

  it("rejects reservation creation when the unit has no owner (UNIT_HAS_NO_OWNER)", async () => {
    // Seed a separate apartment + listing WITHOUT ownerPartyId
    const db = getDb();
    await db.apartment.create({
      data: {
        id: APARTMENT_NO_OWNER,
        organizationId: ORG,
        propertyId: PROPERTY,
        unitCode: "A-102",
        listingMode: "WHOLE",
      },
    });
    await db.listing.create({
      data: {
        id: UNIT_NO_OWNER,
        organizationId: ORG,
        apartmentId: APARTMENT_NO_OWNER,
        listingType: "apartment",
        occupancyStatus: "vacant",
        listingStatus: "active",
        readyNow: true,
        currency: "MYR",
        // ownerPartyId deliberately omitted
      },
    });
    const result = await createReservationService(
      { orgId: ORG, userId: AGENT_USER, partyId: AGENT_PARTY, role: "agent" },
      {
        propertyId: PROPERTY,
        unitId: UNIT_NO_OWNER,
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
        customerEmail: "noowner@example.com",
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    if ("code" in result) expect(result.code).toBe("UNIT_HAS_NO_OWNER");
  });
});
