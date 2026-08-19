/**
 * Task 7: admin-edit + resubmit persist the new Section-B profile fields
 * (nationality, emergencyContactName/Phone/Relation, occupation, monthlyIncome).
 *
 * Mirrors service.admin-edit.integration.test.ts (admin-edit path) and
 * service.resubmit.integration.test.ts (resubmit path) fixture patterns.
 *
 * Run explicitly:
 *   RUN_INTEGRATION=1 DATABASE_URL="..." \
 *     npx vitest run apps/api/src/modules/reservations/__tests__/reservation-admin-edit-profile.test.ts
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { getDb } from "@kason/db";
import { adminEditAfterSigningService, resubmitReservationService } from "../service";
import type { ReservationSession } from "../types";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

// Unique UUID prefix (eeee...) — distinct from sibling integration tests.
const ORG = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const ADMIN_USER = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeed";
const AGENT_USER = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee0";
const AGENT_PARTY = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeec";
const PROPERTY = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeef";
const APARTMENT = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeed0a";
const UNIT = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeed00";

const adminCtx: ReservationSession = {
  orgId: ORG,
  userId: ADMIN_USER,
  partyId: "",
  role: "admin",
  operatorRole: "admin",
};

const agentCtx: ReservationSession = {
  orgId: ORG,
  userId: AGENT_USER,
  partyId: AGENT_PARTY,
  role: "agent",
};

async function seedFixture() {
  const db = getDb();
  // Reverse-FK cleanup.
  await db.auditLog.deleteMany({ where: { organizationId: ORG } });
  await db.unitReservationTransition.deleteMany({ where: { organizationId: ORG } });
  await db.unitReservation.deleteMany({ where: { organizationId: ORG } });
  await db.notificationQueue.deleteMany({ where: { organizationId: ORG } });
  await db.referenceSequence.deleteMany({ where: { organizationId: ORG } });
  await db.documentTemplate.deleteMany({ where: { organizationId: ORG } });
  await db.listing.deleteMany({ where: { organizationId: ORG } });
  await db.apartment.deleteMany({ where: { organizationId: ORG } });
  await db.property.deleteMany({ where: { organizationId: ORG } });
  await db.party.deleteMany({ where: { organizationId: ORG } });
  await db.user.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });

  await db.organization.create({
    data: {
      id: ORG,
      name: "Profile-Fields Test Org",
      slug: "profile-fields-test",
      status: "active",
      defaultCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur",
      locale: "en-MY",
      subscriptionPlan: "free",
      reservationLinkExpiryDays: 7,
    },
  });
  // Actor user — AuditLog has an FK onto User; the integration test must seed
  // the admin actor or the audit insert will fail at the FK boundary.
  await db.user.create({
    data: {
      id: ADMIN_USER,
      organizationId: ORG,
      email: "admin@profile-fields.test",
      fullName: "Profile Admin",
      passwordHash: "x",
      status: "active",
      role: "admin",
      userType: "operator",
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
      name: "Profile-Fields Test Property",
      propertyCode: "PFTP-1",
      propertyType: "residential",
      addressLine1: "1 Profile St",
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
      unitCode: "F-101",
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

async function seedReservation(status: "signed" | "needs_amendment" = "signed") {
  const db = getDb();
  return db.unitReservation.create({
    data: {
      organizationId: ORG,
      referenceCode: `RES-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
      status,
      issuedByPartyId: AGENT_PARTY,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      publicToken: `profedit${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`,
      propertyId: PROPERTY,
      unitId: UNIT,
      carPark: "P-12",
      proposedMoveIn: new Date("2026-09-01T00:00:00Z"),
      proposedMoveOut: null,
      specialRemarks: null,
      reservationDeposit: "500.00",
      documentationFee: "100.00",
      rentalDeposit: "2400.00",
      utilityDeposit: "300.00",
      accessCardDeposit: "50.00",
      applicantFullName: "Tenan Smith",
      applicantNric: "900101-14-2222",
      applicantContact: "+60198765432",
      applicantEmail: "tenant@example.test",
      nationality: "Malaysian",
      ...(status === "signed"
        ? {
            signedAt: new Date(),
            signedFromIp: "127.0.0.1",
            signedUserAgent: "test",
            signatureDrawingKey: `reservations/seeded/${Date.now()}/sig.png`,
            signatureTypedName: "Tenan Smith",
            signatureAgreementTickedAt: new Date(),
            signedPdfKey: `reservations/seeded/${Date.now()}/signed.pdf`,
          }
        : {}),
    },
  });
}

dn("admin-edit + resubmit persist new profile fields (integration)", () => {
  beforeAll(async () => {
    await seedFixture();
  });
  beforeEach(async () => {
    const db = getDb();
    await db.auditLog.deleteMany({ where: { organizationId: ORG } });
    await db.unitReservationTransition.deleteMany({ where: { organizationId: ORG } });
    await db.unitReservation.deleteMany({ where: { organizationId: ORG } });
  });

  it("admin edit nationality: updates the column and writes one audit row", async () => {
    const signed = await seedReservation("signed");

    const result = await adminEditAfterSigningService(adminCtx, signed.id, {
      patch: { nationality: "Singaporean" },
      reason: "correcting nationality typo",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.status).toBe(200);

    const db = getDb();
    const after = await db.unitReservation.findUniqueOrThrow({ where: { id: signed.id } });
    expect(after.nationality).toBe("Singaporean");

    const auditRows = await db.auditLog.findMany({
      where: {
        entityType: "UnitReservation",
        entityId: signed.id,
        action: "admin_edit_signed_reset",
      },
    });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].meta).toMatchObject({
      reason: "correcting nationality typo",
    });
  });

  it("admin edit: updates all six new profile fields together", async () => {
    const signed = await seedReservation("signed");

    const result = await adminEditAfterSigningService(adminCtx, signed.id, {
      patch: {
        nationality: "Indonesian",
        emergencyContactName: "Jane Doe",
        emergencyContactPhone: "+60123456789",
        emergencyContactRelation: "Sister",
        occupation: "Software Engineer",
        monthlyIncome: "8000.00",
      },
      reason: "backfilling profile fields collected over the phone",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");

    const db = getDb();
    const after = await db.unitReservation.findUniqueOrThrow({ where: { id: signed.id } });
    expect(after.nationality).toBe("Indonesian");
    expect(after.emergencyContactName).toBe("Jane Doe");
    expect(after.emergencyContactPhone).toBe("+60123456789");
    expect(after.emergencyContactRelation).toBe("Sister");
    expect(after.occupation).toBe("Software Engineer");
    expect(after.monthlyIncome?.toString()).toBe("8000");
  });

  it("absent fields untouched: a patch with no profile fields leaves the profile columns unchanged", async () => {
    const signed = await seedReservation("signed");

    const result = await adminEditAfterSigningService(adminCtx, signed.id, {
      patch: { reservationDeposit: "550.00" },
      reason: "adjusting reservation deposit only",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");

    const db = getDb();
    const after = await db.unitReservation.findUniqueOrThrow({ where: { id: signed.id } });
    // The unrelated field changed...
    expect(after.reservationDeposit.toString()).toBe("550");
    // ...but the profile columns are untouched from their seeded values.
    expect(after.nationality).toBe("Malaysian");
    expect(after.emergencyContactName).toBeNull();
    expect(after.emergencyContactPhone).toBeNull();
    expect(after.emergencyContactRelation).toBeNull();
    expect(after.occupation).toBeNull();
    expect(after.monthlyIncome).toBeNull();
  });

  it("resubmit: agent patches the new profile fields on a needs_amendment reservation", async () => {
    const draft = await seedReservation("needs_amendment");

    const result = await resubmitReservationService(agentCtx, draft.id, {
      customTerms: [],
      nationality: "Filipino",
      emergencyContactName: "John Smith",
      emergencyContactPhone: "+60129876543",
      emergencyContactRelation: "Brother",
      occupation: "Nurse",
      monthlyIncome: "5500.00",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");

    const db = getDb();
    const after = await db.unitReservation.findUniqueOrThrow({ where: { id: draft.id } });
    expect(after.nationality).toBe("Filipino");
    expect(after.emergencyContactName).toBe("John Smith");
    expect(after.emergencyContactPhone).toBe("+60129876543");
    expect(after.emergencyContactRelation).toBe("Brother");
    expect(after.occupation).toBe("Nurse");
    expect(after.monthlyIncome?.toString()).toBe("5500");
  });

  it("resubmit: absent profile fields leave the columns unchanged", async () => {
    const draft = await seedReservation("needs_amendment");

    const result = await resubmitReservationService(agentCtx, draft.id, {
      customTerms: [],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");

    const db = getDb();
    const after = await db.unitReservation.findUniqueOrThrow({ where: { id: draft.id } });
    expect(after.nationality).toBe("Malaysian");
    expect(after.emergencyContactName).toBeNull();
  });
});
