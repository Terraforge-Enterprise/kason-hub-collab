/**
 * Integration test for resubmitReservationService.
 *
 * Run explicitly:
 *   RUN_INTEGRATION=1 DATABASE_URL="postgresql://yonghongtan@localhost:5432/kason_hub_dev" \
 *     npx vitest run apps/api/src/modules/reservations/__tests__/service.resubmit.integration.test.ts
 */
import { describe, it, expect, beforeEach } from "vitest";
import { getDb } from "@kason/db";
import { resubmitReservationService } from "../service";
import type { ReservationSession } from "../types";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

const ORG = "77777777-7777-7777-7777-777777777777";
const AGENT_PARTY = "88888888-8888-8888-8888-888888888888";
const OTHER_AGENT_PARTY = "99999999-9999-9999-9999-999999999999";
const AGENT_USER = "77777777-7777-7777-7777-777777770001";
const OTHER_AGENT_USER = "77777777-7777-7777-7777-777777770002";
const PROPERTY = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const APARTMENT = "cccccccc-cccc-cccc-cccc-ccccccccccca";
const UNIT = "dddddddd-dddd-dddd-dddd-dddddddddddd";

const AGENT_SESSION: ReservationSession = {
  orgId: ORG,
  userId: AGENT_USER,
  partyId: AGENT_PARTY,
  role: "agent",
};

const OTHER_AGENT_SESSION: ReservationSession = {
  orgId: ORG,
  userId: OTHER_AGENT_USER,
  partyId: OTHER_AGENT_PARTY,
  role: "agent",
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
      name: "Resubmit Test Org",
      slug: "resubmit-test",
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
      displayName: "Main Agent",
      partyType: "agent",
      status: "active",
    },
  });

  await db.party.create({
    data: {
      id: OTHER_AGENT_PARTY,
      organizationId: ORG,
      displayName: "Other Agent",
      partyType: "agent",
      status: "active",
    },
  });

  await db.property.create({
    data: {
      id: PROPERTY,
      organizationId: ORG,
      name: "Resubmit Test Property",
      propertyCode: "RTP-1",
      propertyType: "residential",
      addressLine1: "1 Resubmit St",
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
      unitCode: "B-301",
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

/** Create a reservation directly in needs_amendment status (simulates a rejection from admin). */
async function createNeedsAmendmentReservation() {
  return createReservationWithStatus("needs_amendment");
}

/** Create a reservation in an arbitrary status (used by the pending_approval + 409 tests). */
async function createReservationWithStatus(
  status: "needs_amendment" | "pending_approval" | "pending_customer" | "signed",
) {
  const db = getDb();
  return db.unitReservation.create({
    data: {
      organizationId: ORG,
      referenceCode: `RES-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
      status,
      issuedByPartyId: AGENT_PARTY,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      publicToken: `test${Date.now().toString(36).padStart(19, "0")}`,
      propertyId: PROPERTY,
      unitId: UNIT,
      carPark: null,
      proposedMoveIn: new Date("2026-08-01T00:00:00Z"),
      proposedMoveOut: null,
      specialRemarks: null,
      reservationDeposit: "500.00",
      documentationFee: "100.00",
      rentalDeposit: "2400.00",
      utilityDeposit: "300.00",
      accessCardDeposit: "50.00",
      customTerms: ["Pre-existing custom clause."],
      applicantFullName: "Test Applicant",
      applicantNric: "900101-14-1234",
      applicantContact: "+60123456789",
      applicantEmail: "applicant@test.com",
    },
  });
}

dn("resubmitReservationService (integration)", () => {
  beforeEach(async () => {
    await seedFixture();
  });

  it("case 1: agent clears customTerms → pending_customer, no auto-email", async () => {
    const reservation = await createNeedsAmendmentReservation();

    const result = await resubmitReservationService(AGENT_SESSION, reservation.id, {
      customTerms: [],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe("pending_customer");

    const db = getDb();
    const row = await db.unitReservation.findUniqueOrThrow({ where: { id: reservation.id } });
    expect(row.status).toBe("pending_customer");
    expect(row.customTerms).toEqual([]);
    expect(row.approvalNote).toBeNull();
    expect(row.approvalReviewedAt).toBeNull();

    const txns = await db.unitReservationTransition.findMany({
      where: { reservationId: reservation.id },
    });
    expect(txns).toHaveLength(1);
    expect(txns[0].fromStatus).toBe("needs_amendment");
    expect(txns[0].toStatus).toBe("pending_customer");

    // No auto-email — agent shares the link manually.
    const emails = await db.notificationQueue.findMany({
      where: { organizationId: ORG, type: "reservation_sign_link" },
    });
    expect(emails).toHaveLength(0);
  });

  it("case 2: agent keeps customTerms on resubmit → pending_approval, no auto-email", async () => {
    const reservation = await createNeedsAmendmentReservation();
    const updated = ["Updated clause one.", "Updated clause two."];

    const result = await resubmitReservationService(AGENT_SESSION, reservation.id, {
      customTerms: updated,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe("pending_approval");

    const db = getDb();
    const row = await db.unitReservation.findUniqueOrThrow({ where: { id: reservation.id } });
    expect(row.status).toBe("pending_approval");
    expect(row.customTerms).toEqual(updated);

    const txns = await db.unitReservationTransition.findMany({
      where: { reservationId: reservation.id },
    });
    expect(txns).toHaveLength(1);
    expect(txns[0].fromStatus).toBe("needs_amendment");
    expect(txns[0].toStatus).toBe("pending_approval");

    const emails = await db.notificationQueue.findMany({
      where: { organizationId: ORG, type: "reservation_sign_link" },
    });
    expect(emails).toHaveLength(0);
  });

  it("case 3: non-issuing agent attempts resubmit → 403", async () => {
    const reservation = await createNeedsAmendmentReservation();

    const result = await resubmitReservationService(OTHER_AGENT_SESSION, reservation.id, {
      customTerms: [],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(403);
    expect(result.error).toBe("Not your reservation");

    // Status must be unchanged
    const db = getDb();
    const row = await db.unitReservation.findUniqueOrThrow({ where: { id: reservation.id } });
    expect(row.status).toBe("needs_amendment");
  });

  // F6 — agent self-edit while pending_approval (Awaiting Manager). The
  // manager hasn't yet reviewed, so the row must stay pending_approval (no
  // status change) and NO transition row gets logged (would pollute timeline
  // with from===to no-ops).
  it("case 4: agent edits pending_approval → stays pending_approval, no transition row", async () => {
    const reservation = await createReservationWithStatus("pending_approval");

    const result = await resubmitReservationService(AGENT_SESSION, reservation.id, {
      customTerms: ["Edited clause one.", "Edited clause two."],
      reservationDeposit: "750.00",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe("pending_approval");

    const db = getDb();
    const row = await db.unitReservation.findUniqueOrThrow({ where: { id: reservation.id } });
    expect(row.status).toBe("pending_approval");
    expect(row.customTerms).toEqual(["Edited clause one.", "Edited clause two."]);
    expect(row.reservationDeposit.toString()).toBe("750");

    // No-op transitions (from === to) are intentionally not logged.
    const txns = await db.unitReservationTransition.findMany({
      where: { reservationId: reservation.id },
    });
    expect(txns).toHaveLength(0);
  });

  // D5: agent can now self-edit pending_customer (sign link is out but
  // tenant hasn't signed yet). Stays pending_customer, no transition row
  // (no-op status change), approval metadata preserved (manager's approval
  // still stands).
  it("case 5: agent edits pending_customer → stays pending_customer, applicant fields updated, approval preserved", async () => {
    const reservation = await createReservationWithStatus("pending_customer");
    // Seed approval metadata so we can assert it survives the edit.
    const db = getDb();
    await db.unitReservation.update({
      where: { id: reservation.id },
      data: {
        approvalReviewedAt: new Date("2026-05-10T00:00:00Z"),
        approvalReviewedById: "11111111-1111-1111-1111-111111111111",
      },
    });

    const result = await resubmitReservationService(AGENT_SESSION, reservation.id, {
      customTerms: ["Pre-existing custom clause."],
      applicantFullName: "Edited Applicant Name",
      reservationDeposit: "600.00",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe("pending_customer");

    const row = await db.unitReservation.findUniqueOrThrow({ where: { id: reservation.id } });
    expect(row.status).toBe("pending_customer");
    expect(row.applicantFullName).toBe("Edited Applicant Name");
    expect(row.reservationDeposit.toString()).toBe("600");
    // Approval metadata preserved — manager's approval still stands.
    expect(row.approvalReviewedAt).not.toBeNull();
    expect(row.approvalReviewedById).toBe("11111111-1111-1111-1111-111111111111");

    // No transition row logged (status unchanged).
    const txns = await db.unitReservationTransition.findMany({
      where: { reservationId: reservation.id },
    });
    expect(txns).toHaveLength(0);
  });

  it("case 6: agent cannot resubmit a cancelled reservation → 409", async () => {
    const db = getDb();
    const reservation = await createNeedsAmendmentReservation();
    await db.unitReservation.update({
      where: { id: reservation.id },
      data: { status: "cancelled", cancelledAt: new Date() },
    });

    const result = await resubmitReservationService(AGENT_SESSION, reservation.id, {
      customTerms: [],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
  });

  // D2: agent edits on a signed reservation trigger the reset flow.
  // Status flips to pending_customer, the 7 signature fields null out, an
  // AuditLog row with action=agent_edit_signed_reset is written, and the
  // approval metadata is preserved (manager's earlier approval still stands).
  // The S3 cleanup is best-effort post-commit; the integration test can't
  // realistically mount a Supabase Storage in-process, so we assert the row
  // state and audit entry which are sufficient to lock the contract.
  it("case 7: agent edits a signed reservation → resets to pending_customer + audit row", async () => {
    const db = getDb();
    const reservation = await createReservationWithStatus("signed");
    await db.unitReservation.update({
      where: { id: reservation.id },
      data: {
        signedAt: new Date("2026-05-15T03:00:00Z"),
        signedFromIp: "127.0.0.1",
        signedUserAgent: "test-agent",
        signatureDrawingKey: `reservations/${reservation.id}/signature.png`,
        signatureTypedName: "Test Applicant",
        signatureAgreementTickedAt: new Date("2026-05-15T03:00:00Z"),
        signedPdfKey: `reservations/${reservation.id}/signed.pdf`,
        approvalReviewedAt: new Date("2026-05-10T00:00:00Z"),
        approvalReviewedById: "11111111-1111-1111-1111-111111111111",
      },
    });

    // Seed an actor user for the AuditLog FK.
    await db.user.upsert({
      where: { id: AGENT_USER },
      create: {
        id: AGENT_USER,
        organizationId: ORG,
        email: "agent@resubmit.test",
        fullName: "Resubmit Agent",
        passwordHash: "x",
        status: "active",
        role: "agent",
        userType: "agent",
      },
      update: {},
    });

    const result = await resubmitReservationService(AGENT_SESSION, reservation.id, {
      customTerms: [],
      applicantFullName: "Corrected Applicant Name",
      reason: "tenant phoned in a typo correction post-signing",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe("pending_customer");

    const row = await db.unitReservation.findUniqueOrThrow({ where: { id: reservation.id } });
    expect(row.status).toBe("pending_customer");
    expect(row.applicantFullName).toBe("Corrected Applicant Name");
    // Signature fields nulled.
    expect(row.signedAt).toBeNull();
    expect(row.signedFromIp).toBeNull();
    expect(row.signedUserAgent).toBeNull();
    expect(row.signatureDrawingKey).toBeNull();
    expect(row.signatureTypedName).toBeNull();
    expect(row.signatureAgreementTickedAt).toBeNull();
    expect(row.signedPdfKey).toBeNull();
    // Approval metadata preserved — manager's approval still stands.
    expect(row.approvalReviewedAt).not.toBeNull();
    expect(row.approvalReviewedById).toBe("11111111-1111-1111-1111-111111111111");

    // Transition row + audit row both written.
    const txns = await db.unitReservationTransition.findMany({
      where: { reservationId: reservation.id },
    });
    expect(txns).toHaveLength(1);
    expect(txns[0].fromStatus).toBe("signed");
    expect(txns[0].toStatus).toBe("pending_customer");

    const audits = await db.auditLog.findMany({
      where: {
        entityType: "UnitReservation",
        entityId: reservation.id,
        action: "agent_edit_signed_reset",
      },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0].meta).toMatchObject({
      reason: "tenant phoned in a typo correction post-signing",
    });
  });

  it("case 8: agent edits a signed reservation WITHOUT reason → 400", async () => {
    const reservation = await createReservationWithStatus("signed");
    const result = await resubmitReservationService(AGENT_SESSION, reservation.id, {
      customTerms: [],
      applicantFullName: "Anything",
      // reason: omitted
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/reason/i);
  });
});
