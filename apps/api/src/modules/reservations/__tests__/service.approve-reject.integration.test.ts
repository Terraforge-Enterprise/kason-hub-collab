/**
 * Integration tests for approveReservationService + rejectReservationService.
 *
 * Spec §10: "Approve flow asserts email is queued only after approval.
 * Reject flow asserts no email and `needs_amendment` status."
 *
 * Run explicitly:
 *   RUN_INTEGRATION=1 DATABASE_URL="..." \
 *     npx vitest run apps/api/src/modules/reservations/__tests__/service.approve-reject.integration.test.ts
 */
import { describe, it, expect, beforeEach } from "vitest";
import { getDb } from "@kason/db";
import {
  approveReservationService,
  rejectReservationService,
} from "../service";
import { rejectReservationSchema } from "../validation";
import type { ReservationSession } from "../types";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

// Unique UUIDs — distinct prefix to avoid collisions with the other
// reservation integration test files (22..., 33..., 77..., aaaa...).
const ORG = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MANAGER_USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc";
const EDITOR_USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbd";
const AGENT_PARTY = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbe";
const PROPERTY = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbf";
const APARTMENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbca";
const UNIT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbc0";

const managerSession: ReservationSession = {
  orgId: ORG,
  userId: MANAGER_USER,
  partyId: "",
  role: "admin",
  operatorRole: "manager",
};

const editorSession: ReservationSession = {
  orgId: ORG,
  userId: EDITOR_USER,
  partyId: "",
  role: "admin",
  operatorRole: "editor",
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
      name: "Approve-Reject Test Org",
      slug: "approve-reject-test",
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
      name: "Approve-Reject Test Property",
      propertyCode: "ARTP-1",
      propertyType: "residential",
      addressLine1: "1 Approve-Reject St",
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
      unitCode: "C-401",
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

/** Create a reservation directly in pending_approval status (simulates a customized-T&Cs create). */
async function createPendingApprovalReservation(opts?: {
  status?: "pending_approval" | "pending_customer";
}) {
  const db = getDb();
  const status = opts?.status ?? "pending_approval";
  return db.unitReservation.create({
    data: {
      organizationId: ORG,
      referenceCode: `RES-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
      status,
      issuedByPartyId: AGENT_PARTY,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      publicToken: `apprej${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`,
      propertyId: PROPERTY,
      unitId: UNIT,
      carPark: null,
      proposedMoveIn: new Date("2026-09-01T00:00:00Z"),
      proposedMoveOut: null,
      specialRemarks: null,
      reservationDeposit: "500.00",
      documentationFee: "100.00",
      rentalDeposit: "2400.00",
      utilityDeposit: "300.00",
      accessCardDeposit: "50.00",
      disabledClauseIndexes: [0],
      termsAddendum: null,
      applicantFullName: "Applicant Name",
      applicantNric: "900101-14-2222",
      applicantContact: "+60198765432",
      applicantEmail: "applicant@approve-reject.test",
    },
  });
}

dn("approveReservationService (integration)", () => {
  beforeEach(async () => {
    await seedFixture();
  });

  it("transitions pending_approval → pending_customer, does NOT auto-email the sign-link, stamps reviewer", async () => {
    const reservation = await createPendingApprovalReservation();

    const result = await approveReservationService(managerSession, reservation.id);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.status).toBe("pending_customer");

    const db = getDb();
    const row = await db.unitReservation.findUniqueOrThrow({ where: { id: reservation.id } });
    expect(row.status).toBe("pending_customer");
    expect(row.approvalReviewedAt).toBeInstanceOf(Date);
    expect(row.approvalReviewedById).toBe(MANAGER_USER);
    expect(row.approvalNote).toBeNull();

    const txns = await db.unitReservationTransition.findMany({
      where: { reservationId: reservation.id },
    });
    expect(txns).toHaveLength(1);
    expect(txns[0].fromStatus).toBe("pending_approval");
    expect(txns[0].toStatus).toBe("pending_customer");

    // Approval no longer auto-emails the sign-link — the agent shares it
    // manually after approval (service.ts approveReservationService, commit
    // 94687060 "manual sign-link sharing"). Assert NO sign-link email queued.
    const emails = await db.notificationQueue.findMany({
      where: { organizationId: ORG, type: "reservation_sign_link" },
    });
    expect(emails).toHaveLength(0);
  });

  it("returns 403 when called by an editor operatorRole", async () => {
    const reservation = await createPendingApprovalReservation();

    const result = await approveReservationService(editorSession, reservation.id);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected fail");
    expect(result.status).toBe(403);

    // No mutation, no email
    const db = getDb();
    const row = await db.unitReservation.findUniqueOrThrow({ where: { id: reservation.id } });
    expect(row.status).toBe("pending_approval");
    const emails = await db.notificationQueue.findMany({
      where: { organizationId: ORG, type: "reservation_sign_link" },
    });
    expect(emails).toHaveLength(0);
  });

  it("returns 409 when reservation is already pending_customer", async () => {
    const reservation = await createPendingApprovalReservation({ status: "pending_customer" });

    const result = await approveReservationService(managerSession, reservation.id);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected fail");
    expect(result.status).toBe(409);

    // No new email queued
    const emails = await getDb().notificationQueue.findMany({
      where: { organizationId: ORG, type: "reservation_sign_link" },
    });
    expect(emails).toHaveLength(0);
  });
});

dn("rejectReservationService (integration)", () => {
  beforeEach(async () => {
    await seedFixture();
  });

  it("transitions pending_approval → needs_amendment, stores note, DOES NOT queue email", async () => {
    const reservation = await createPendingApprovalReservation();

    const result = await rejectReservationService(
      managerSession,
      reservation.id,
      "Please restore clause 5",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.status).toBe("needs_amendment");

    const db = getDb();
    const row = await db.unitReservation.findUniqueOrThrow({ where: { id: reservation.id } });
    expect(row.status).toBe("needs_amendment");
    expect(row.approvalNote).toBe("Please restore clause 5");
    expect(row.approvalReviewedAt).toBeInstanceOf(Date);
    expect(row.approvalReviewedById).toBe(MANAGER_USER);

    const txns = await db.unitReservationTransition.findMany({
      where: { reservationId: reservation.id },
    });
    expect(txns).toHaveLength(1);
    expect(txns[0].fromStatus).toBe("pending_approval");
    expect(txns[0].toStatus).toBe("needs_amendment");
    expect(txns[0].note).toBe("Please restore clause 5");

    // Critical assertion: no sign-link email
    const emails = await db.notificationQueue.findMany({
      where: { organizationId: ORG, type: "reservation_sign_link" },
    });
    expect(emails).toHaveLength(0);
  });

  it("returns 403 when called by an editor operatorRole", async () => {
    const reservation = await createPendingApprovalReservation();

    const result = await rejectReservationService(editorSession, reservation.id, "some note");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected fail");
    expect(result.status).toBe(403);

    // No mutation
    const db = getDb();
    const row = await db.unitReservation.findUniqueOrThrow({ where: { id: reservation.id } });
    expect(row.status).toBe("pending_approval");
    expect(row.approvalNote).toBeNull();
  });

  it("rejectReservationSchema rejects an empty note (route-level guard)", () => {
    // The service itself does not enforce min-length on note (it writes the
    // string as-is). The 400 happens at the route via this schema. Verify
    // the schema's parse output so a refactor that drops the min(1) would
    // be caught here.
    const parsed = rejectReservationSchema.safeParse({ note: "" });
    expect(parsed.success).toBe(false);
  });
});
