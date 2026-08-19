/**
 * Integration test for createReservationService approval gate.
 *
 * Run explicitly:
 *   RUN_INTEGRATION=1 DATABASE_URL="..." \
 *     npx vitest run apps/api/src/modules/reservations/__tests__/service.approval.integration.test.ts
 */
import { describe, it, expect, beforeEach } from "vitest";
import { getDb } from "@kason/db";
import { createReservationService } from "../service";
import type { ReservationSession } from "../types";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

const ORG = "33333333-3333-3333-3333-333333333333";
const AGENT_PARTY = "44444444-4444-4444-4444-444444444444";
const AGENT_USER = "55555555-5555-5555-5555-555555555500";
// Use unique IDs that don't conflict with service.create.integration.test.ts
const PROPERTY = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const APARTMENT = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaab";
const UNIT = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

const SESSION: ReservationSession = {
  orgId: ORG,
  userId: AGENT_USER,
  partyId: AGENT_PARTY,
  role: "agent",
};

const BASE_INPUT = {
  propertyId: PROPERTY,
  unitId: UNIT,
  carPark: null,
  proposedMoveIn: "2026-07-01T00:00:00Z",
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

async function seedFixture() {
  const db = getDb();

  // Idempotent cleanup: delete in reverse FK order
  await db.unitReservationTransition.deleteMany({ where: { organizationId: ORG } });
  await db.unitReservation.deleteMany({ where: { organizationId: ORG } });
  await db.notificationQueue.deleteMany({ where: { organizationId: ORG } });
  await db.referenceSequence.deleteMany({ where: { organizationId: ORG } });
  await db.documentTemplate.deleteMany({ where: { organizationId: ORG } });
  await db.listing.deleteMany({ where: { organizationId: ORG } });
  await db.apartment.deleteMany({ where: { organizationId: ORG } });
  await db.property.deleteMany({ where: { organizationId: ORG } });
  await db.party.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });

  await db.organization.create({
    data: {
      id: ORG,
      name: "Approval Test Org",
      slug: "approval-test",
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
      name: "Approval Test Property",
      propertyCode: "ATP-1",
      propertyType: "residential",
      addressLine1: "1 Approval St",
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
      unitCode: "A-201",
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
      readyNow: true,
      ownerPartyId: AGENT_PARTY,
    },
  });
}

dn("createReservationService – approval gate (integration)", () => {
  beforeEach(async () => {
    await seedFixture();
  });

  it("empty customTerms → status pending_customer, zero auto-email (manual share only)", async () => {
    const result = await createReservationService(SESSION, {
      ...BASE_INPUT,
      customTerms: [],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const db = getDb();
    const row = await db.unitReservation.findUniqueOrThrow({ where: { id: result.data.id } });
    expect(row.status).toBe("pending_customer");
    expect(row.customTerms).toEqual([]);

    const txns = await db.unitReservationTransition.findMany({
      where: { reservationId: result.data.id },
    });
    expect(txns).toHaveLength(1);
    expect(txns[0].toStatus).toBe("pending_customer");

    // No auto-email — agent shares the link manually.
    const emails = await db.notificationQueue.findMany({
      where: { organizationId: ORG, type: "reservation_sign_link" },
    });
    expect(emails).toHaveLength(0);
  });

  it("non-empty customTerms → status pending_approval, list persisted, no auto-email", async () => {
    const customTerms = ["Custom clause 1.", "Custom clause 2."];
    const result = await createReservationService(SESSION, {
      ...BASE_INPUT,
      customTerms,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const db = getDb();
    const row = await db.unitReservation.findUniqueOrThrow({ where: { id: result.data.id } });
    expect(row.status).toBe("pending_approval");
    expect(row.customTerms).toEqual(customTerms);

    const txns = await db.unitReservationTransition.findMany({
      where: { reservationId: result.data.id },
    });
    expect(txns).toHaveLength(1);
    expect(txns[0].toStatus).toBe("pending_approval");

    const emails = await db.notificationQueue.findMany({
      where: { organizationId: ORG, type: "reservation_sign_link" },
    });
    expect(emails).toHaveLength(0);
  });
});
