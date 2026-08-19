/**
 * Integration tests for getUnsignedReservationPdfService.
 *
 * Run explicitly:
 *   RUN_INTEGRATION=1 DATABASE_URL="..." \
 *     npx vitest run apps/api/src/modules/reservations/__tests__/service.unsigned-pdf.integration.test.ts
 */
import { describe, it, expect, beforeEach } from "vitest";
import { getDb } from "@kason/db";
import { getUnsignedReservationPdfService } from "../service";
import type { ReservationSession } from "../types";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

// Unique UUIDs — chosen to avoid conflicts with other integration test files.
// service.resubmit.integration.test.ts already uses ORG=77777777-...,
// AGENT_PARTY=88888888-... and OTHER_AGENT_PARTY=99999999-..., so we
// pick a non-overlapping "aaaa..." prefix here.
const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ADMIN_USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab";
const AGENT_PARTY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac";
const PROPERTY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaad";
const APARTMENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaf";
const UNIT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaae";

const PENDING_RESERVATION_ID = "11111111-aaaa-bbbb-cccc-dddddddddddd";
const SIGNED_RESERVATION_ID = "22222222-aaaa-bbbb-cccc-dddddddddddd";

const adminSession: ReservationSession = {
  orgId: ORG,
  userId: ADMIN_USER,
  partyId: "",
  role: "admin",
  operatorRole: "admin",
};

const agentSession: ReservationSession = {
  orgId: ORG,
  userId: "user-agent",
  partyId: AGENT_PARTY,
  role: "agent",
};

async function seedFixture(): Promise<{
  pendingCustomerId: string;
  signedId: string;
}> {
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
      name: "Unsigned PDF Test Org",
      slug: "unsigned-pdf-test",
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
      name: "PDF Test Property",
      propertyCode: "PTP-1",
      propertyType: "residential",
      addressLine1: "1 PDF Test St",
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

  const now = new Date();
  const expires = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  // pending_customer row — applicantFullName populated so the PDF body renders cleanly
  await db.unitReservation.create({
    data: {
      id: PENDING_RESERVATION_ID,
      organizationId: ORG,
      referenceCode: "RES-00001",
      status: "pending_customer",
      issuedByPartyId: AGENT_PARTY,
      issuedAt: now,
      expiresAt: expires,
      publicToken: "unsigned-pdf-test-pending-token-1",
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
      applicantFullName: "Test Applicant",
      applicantNric: "900101-14-5678",
      applicantContact: "+60123456789",
      applicantEmail: "test.applicant@example.com",
      disabledClauseIndexes: [],
      termsAddendum: null,
    },
  });

  // signed row — to test the 409 conflict path
  await db.unitReservation.create({
    data: {
      id: SIGNED_RESERVATION_ID,
      organizationId: ORG,
      referenceCode: "RES-00002",
      status: "signed",
      issuedByPartyId: AGENT_PARTY,
      issuedAt: now,
      expiresAt: expires,
      publicToken: "unsigned-pdf-test-signed-token-2",
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
      applicantFullName: "Signed Applicant",
      applicantNric: "880101-14-9999",
      applicantContact: "+60198765432",
      applicantEmail: "signed.applicant@example.com",
      signedAt: now,
      disabledClauseIndexes: [],
      termsAddendum: null,
    },
  });

  return {
    pendingCustomerId: PENDING_RESERVATION_ID,
    signedId: SIGNED_RESERVATION_ID,
  };
}

dn("getUnsignedReservationPdfService (integration)", () => {
  let pendingCustomerId: string;
  let signedId: string;

  beforeEach(async () => {
    const seed = await seedFixture();
    pendingCustomerId = seed.pendingCustomerId;
    signedId = seed.signedId;
  });

  it("returns 200 for the issuing agent (agents share the unsigned PDF manually)", async () => {
    // The sign-link is no longer auto-emailed — the issuing agent now shares
    // it manually, and "Download PDF" is one of the channels. The agent may
    // pull the unsigned PDF for THEIR OWN reservation (service.ts
    // getUnsignedReservationPdfService). agentSession.partyId === AGENT_PARTY,
    // which is the reservation's issuedByPartyId.
    const r = await getUnsignedReservationPdfService(agentSession, pendingCustomerId);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.pdf).toBeInstanceOf(Buffer);
    expect(r.pdf.subarray(0, 4).toString("ascii")).toBe("%PDF");
  });

  it("returns 403 for a non-issuing agent", async () => {
    // A different agent (not the reservation's issuer) is still blocked.
    const otherAgentSession: ReservationSession = {
      orgId: ORG,
      userId: "user-other-agent",
      partyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaab0",
      role: "agent",
    };
    const r = await getUnsignedReservationPdfService(otherAgentSession, pendingCustomerId);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected fail");
    expect(r.status).toBe(403);
  });

  it("returns 404 for a non-existent reservation", async () => {
    const r = await getUnsignedReservationPdfService(
      adminSession,
      "00000000-0000-0000-0000-000000000000",
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected fail");
    expect(r.status).toBe(404);
  });

  it("returns 409 when the reservation is not pending_customer", async () => {
    const r = await getUnsignedReservationPdfService(adminSession, signedId);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected fail");
    expect(r.status).toBe(409);
  });

  it("returns a non-empty PDF buffer for a pending_customer reservation", async () => {
    const r = await getUnsignedReservationPdfService(adminSession, pendingCustomerId);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.pdf).toBeInstanceOf(Buffer);
    expect(r.pdf.length).toBeGreaterThan(1000); // sanity: PDF is at least 1KB
    expect(r.filename).toMatch(/-unsigned\.pdf$/);
    // First 4 bytes of a PDF are "%PDF"
    expect(r.pdf.subarray(0, 4).toString("ascii")).toBe("%PDF");
  });
});
