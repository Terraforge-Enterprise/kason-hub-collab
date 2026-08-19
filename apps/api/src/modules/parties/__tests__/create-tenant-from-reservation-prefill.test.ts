/**
 * Integration test for Task 13 (R6): createTenantService, when creating a
 * tenant "from reservation" (input.reservationId set), defaults the six
 * profile fields (nationality, occupation, monthlyIncome,
 * emergencyContactName, emergencyContactPhone, emergencyContactRelation)
 * from the linked reservation WHEN the create input omits them. Input-
 * supplied values must never be overwritten by the reservation's.
 *
 * Hits a real Postgres. Skipped by default. Run explicitly:
 *   RUN_INTEGRATION=1 DATABASE_URL="..." \
 *     npx vitest run create-tenant-from-reservation-prefill
 */
import { describe, it, expect, beforeEach } from "vitest";
import { getDb } from "@kason/db";
import { createTenantService } from "../parties.service";
import type { PartiesSession } from "../parties.types";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

const ORG = "dd111111-1111-1111-1111-111111111111";
const AGENT_PARTY = "dd222222-2222-2222-2222-222222222222";
const PROPERTY = "dd444444-4444-4444-4444-444444444444";
const APARTMENT = "dd555555-5555-5555-5555-555555555555";
const UNIT = "dd666666-6666-6666-6666-666666666666";
const RESERVATION_WITH_PROFILE = "dd777777-7777-7777-7777-777777777777";
const RESERVATION_NULL_INCOME = "dd888888-8888-8888-8888-888888888888";

const session: PartiesSession = {
  orgId: ORG,
  userId: "dd000000-0000-0000-0000-000000000001",
  role: "admin",
};

async function seedOrgWithReservations() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG,
      name: "Test",
      slug: "create-tenant-from-reservation-prefill",
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
  await db.property.create({
    data: {
      id: PROPERTY,
      organizationId: ORG,
      name: "Test Property",
      propertyCode: "CTFP-1",
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
      unitCode: "CTFP-101",
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
    status: "signed",
  };

  await db.unitReservation.create({
    data: {
      ...base,
      id: RESERVATION_WITH_PROFILE,
      referenceCode: "CTFP-00001",
      publicToken: "ctfp-with-profile-token",
      nationality: "Malaysian",
      occupation: "Engineer",
      monthlyIncome: "5000.00",
      emergencyContactName: "Jane Doe",
      emergencyContactPhone: "+60123456789",
      emergencyContactRelation: "Sister",
    },
  });
  await db.unitReservation.create({
    data: {
      ...base,
      id: RESERVATION_NULL_INCOME,
      referenceCode: "CTFP-00002",
      publicToken: "ctfp-null-income-token",
      nationality: "Malaysian",
      occupation: "Teacher",
      monthlyIncome: null,
      emergencyContactName: "John Doe",
      emergencyContactPhone: "+60129876543",
      emergencyContactRelation: "Brother",
    },
  });
}

async function cleanup() {
  const db = getDb();
  await db.unitReservation.deleteMany({ where: { organizationId: ORG } });
  await db.tenancy.deleteMany({ where: { organizationId: ORG } });
  await db.listing.deleteMany({ where: { organizationId: ORG } });
  await db.apartment.deleteMany({ where: { organizationId: ORG } });
  await db.property.deleteMany({ where: { organizationId: ORG } });
  await db.party.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

dn("createTenantService — prefill from reservation profile fields (R6, integration)", () => {
  beforeEach(async () => {
    await cleanup();
    await seedOrgWithReservations();
  });

  it("prefills from reservation when input omits the six profile fields", async () => {
    const result = await createTenantService(session, {
      displayName: "Prefilled Tenant",
      primaryPhone: "",
      reservationId: RESERVATION_WITH_PROFILE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(201);

    const db = getDb();
    const party = await db.party.findUniqueOrThrow({ where: { id: (result.data as { id: string }).id } });
    expect(party.nationality).toBe("Malaysian");
    expect(party.occupation).toBe("Engineer");
    expect(party.monthlyIncome?.toString()).toBe("5000");
    expect(party.emergencyContactName).toBe("Jane Doe");
    expect(party.emergencyContactPhone).toBe("+60123456789");
    expect(party.emergencyContactRelation).toBe("Sister");
  });

  it("null income stays null: reservation monthlyIncome null → Party.monthlyIncome null", async () => {
    const result = await createTenantService(session, {
      displayName: "Null Income Tenant",
      primaryPhone: "",
      reservationId: RESERVATION_NULL_INCOME,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const db = getDb();
    const party = await db.party.findUniqueOrThrow({ where: { id: (result.data as { id: string }).id } });
    expect(party.monthlyIncome).toBeNull();
    // other fields still prefilled
    expect(party.nationality).toBe("Malaysian");
    expect(party.occupation).toBe("Teacher");
  });

  it("input-supplied values are never overwritten by the reservation's", async () => {
    const result = await createTenantService(session, {
      displayName: "Explicit Tenant",
      primaryPhone: "",
      reservationId: RESERVATION_WITH_PROFILE,
      nationality: "Singaporean",
      occupation: "Doctor",
      monthlyIncome: "9999.00",
      emergencyContactName: "Explicit Contact",
      emergencyContactPhone: "+60111111111",
      emergencyContactRelation: "Friend",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const db = getDb();
    const party = await db.party.findUniqueOrThrow({ where: { id: (result.data as { id: string }).id } });
    expect(party.nationality).toBe("Singaporean");
    expect(party.occupation).toBe("Doctor");
    expect(party.monthlyIncome?.toString()).toBe("9999");
    expect(party.emergencyContactName).toBe("Explicit Contact");
    expect(party.emergencyContactPhone).toBe("+60111111111");
    expect(party.emergencyContactRelation).toBe("Friend");
  });
});
