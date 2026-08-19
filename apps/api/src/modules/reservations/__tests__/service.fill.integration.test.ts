/**
 * Integration test for fillReservationByTokenService. Hits a real Postgres.
 *
 * Skipped by default. Run explicitly:
 *   RUN_INTEGRATION=1 DATABASE_URL="..." \
 *     npx vitest run apps/api/src/modules/reservations/__tests__/service.fill.integration.test.ts
 */
import { describe, it, expect, beforeEach } from "vitest";
import { getDb } from "@kason/db";
import {
  createReservationService,
  fillReservationByTokenService,
  signReservationByTokenService,
  getReservationForOrg,
} from "../service";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

const ORG = "22222222-2222-2222-2222-222222222222";
const AGENT_PARTY = "33333333-3333-3333-3333-333333333333";
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
      currency: "MYR",
      // Agent reservations require a ready-now active listing
      // (service.ts createReservationService agent gate). Without this the
      // setup's agent createReservationService returns 403 ("setup failed").
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

const SECTION_B = {
  applicantFullName: "John Tan",
  applicantNric: "900101011234",
  applicantContact: "+60123456789",
  applicantEmail: "john@example.com",
  applicantAddressLine1: "12, Jalan Bukit Bintang",
  applicantCity: "Kuala Lumpur",
  applicantPostcode: "55100",
  applicantState: "Wilayah Persekutuan Kuala Lumpur",
  applicantCountry: "Malaysia",
  nationality: "Malaysian",
  emergencyContactName: "Jane Doe",
  emergencyContactPhone: "+60123456789",
};

dn("fillReservationByTokenService (integration)", () => {
  beforeEach(async () => {
    await cleanup();
    await seedOrgWithUnit();
  });

  it("fills Section B for a pending reservation", async () => {
    const created = await createReservationService(
      { orgId: ORG, userId: AGENT_USER, partyId: AGENT_PARTY, role: "agent" },
      SECTION_A,
    );
    if (!created.ok) throw new Error("setup failed");

    const result = await fillReservationByTokenService(created.data.publicToken, SECTION_B);
    expect(result.ok).toBe(true);

    const row = await getDb().unitReservation.findUniqueOrThrow({
      where: { id: created.data.id },
    });
    expect(row.applicantFullName).toBe(SECTION_B.applicantFullName);
    expect(row.applicantEmail).toBe(SECTION_B.applicantEmail);
  });

  it("persists the tenant address (Line2 optional)", async () => {
    const created = await createReservationService(
      { orgId: ORG, userId: AGENT_USER, partyId: AGENT_PARTY, role: "agent" },
      SECTION_A,
    );
    if (!created.ok) throw new Error("setup failed");

    const result = await fillReservationByTokenService(created.data.publicToken, SECTION_B);
    expect(result.ok).toBe(true);

    const row = await getDb().unitReservation.findUniqueOrThrow({
      where: { id: created.data.id },
    });
    expect(row.applicantAddressLine1).toBe("12, Jalan Bukit Bintang");
    expect(row.applicantCity).toBe("Kuala Lumpur");
    expect(row.applicantPostcode).toBe("55100");
    expect(row.applicantState).toBe("Wilayah Persekutuan Kuala Lumpur");
    expect(row.applicantCountry).toBe("Malaysia");
    expect(row.applicantAddressLine2).toBeNull();
  });

  it("is idempotent — second fill overwrites previous data", async () => {
    const created = await createReservationService(
      { orgId: ORG, userId: AGENT_USER, partyId: AGENT_PARTY, role: "agent" },
      SECTION_A,
    );
    if (!created.ok) throw new Error("setup failed");

    await fillReservationByTokenService(created.data.publicToken, SECTION_B);
    const second = await fillReservationByTokenService(created.data.publicToken, {
      ...SECTION_B,
      applicantFullName: "John Tan Updated",
    });
    expect(second.ok).toBe(true);

    const row = await getDb().unitReservation.findUniqueOrThrow({
      where: { id: created.data.id },
    });
    expect(row.applicantFullName).toBe("John Tan Updated");
  });

  it("blocks signing when the address is incomplete", async () => {
    const created = await createReservationService(
      { orgId: ORG, userId: AGENT_USER, partyId: AGENT_PARTY, role: "agent" },
      SECTION_A,
    );
    if (!created.ok) throw new Error("setup failed");

    // Fill everything the sign guard checks EXCEPT applicantCity.
    await getDb().unitReservation.update({
      where: { id: created.data.id },
      data: {
        applicantFullName: "John Tan",
        applicantNric: "900101011234",
        applicantContact: "+60123456789",
        applicantEmail: "john@example.com",
        applicantAddressLine1: "12, Jalan Bukit Bintang",
        applicantCity: null,
        applicantPostcode: "55100",
        applicantState: "Selangor",
        applicantCountry: "Malaysia",
      },
    });

    const result = await signReservationByTokenService(
      created.data.publicToken,
      { typedName: "John Tan", agreementTicked: true, signaturePngBase64: "data:image/png;base64,AAAA" },
      { ip: "127.0.0.1", userAgent: "test" },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
    expect(result.error).toBe("Section B is incomplete");

    const row = await getDb().unitReservation.findUniqueOrThrow({ where: { id: created.data.id } });
    expect(row.status).toBe("pending_customer");
  });

  it("returns 404 for an invalid token", async () => {
    const result = await fillReservationByTokenService("0123456789abcdef01234A", SECTION_B);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(404);
  });

  it("returns 404 for a malformed token", async () => {
    const result = await fillReservationByTokenService("nope", SECTION_B);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(404);
  });

  it("toDto exposes the address", async () => {
    const created = await createReservationService(
      { orgId: ORG, userId: AGENT_USER, partyId: AGENT_PARTY, role: "agent" },
      SECTION_A,
    );
    if (!created.ok) throw new Error("setup failed");
    await fillReservationByTokenService(created.data.publicToken, SECTION_B);

    const dto = await getReservationForOrg(ORG, created.data.id, {
      orgId: ORG,
      userId: AGENT_USER,
      partyId: AGENT_PARTY,
      role: "admin",
      operatorRole: "admin",
    });
    expect(dto?.applicant.addressLine1).toBe("12, Jalan Bukit Bintang");
    expect(dto?.applicant.city).toBe("Kuala Lumpur");
    expect(dto?.applicant.country).toBe("Malaysia");
  });
});
