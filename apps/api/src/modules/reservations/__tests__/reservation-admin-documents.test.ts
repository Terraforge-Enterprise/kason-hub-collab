/**
 * Task 6: admin read payload (profile fields + documents list) + the admin
 * document view-url route.
 *
 * Two layers:
 *  - Route-level, no DB (mocks `../service` and `../documents.service`):
 *    proves the `!session.operatorRole` gate 403s a viewer session and a
 *    portal-agent session, and that a passing admin session reaches the
 *    service. Always runs.
 *  - DB-backed (real Postgres, storage module mocked — same idiom as
 *    reservation-documents.service.test.ts): seeds a reservation + an
 *    uploaded doc and asserts the admin GET /:id payload carries
 *    `documents` + the six profile fields, and that a cross-org docId
 *    returns 404 from the view-url route. Skipped by default.
 *
 * Run the DB-backed cases explicitly:
 *   RUN_INTEGRATION=1 DATABASE_URL="..." \
 *     npx vitest run apps/api/src/modules/reservations/__tests__/reservation-admin-documents.test.ts
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { ReservationSession } from "../types";

// ── Route-level mocks — DB is never reached ─────────────────────────────────
vi.mock("../service", () => ({
  createReservationService: vi.fn(),
  listReservationsForAgent: vi.fn().mockResolvedValue([]),
  listReservationsForOrg: vi.fn().mockResolvedValue([]),
  listEligibleUnitsForAgent: vi.fn().mockResolvedValue([]),
  getReservationForOrg: vi.fn().mockResolvedValue(null),
  getUnsignedReservationPdfService: vi.fn(),
  cancelReservationService: vi.fn(),
  approveReservationService: vi.fn(),
  rejectReservationService: vi.fn(),
  resubmitReservationService: vi.fn(),
  adminEditAfterSigningService: vi.fn(),
  getReservationEditHistory: vi.fn(),
  getLinkedSignedReservationService: vi.fn(),
  listPickableReservationsService: vi.fn(),
}));

vi.mock("../documents.service", () => ({
  getReservationDocViewUrlForAdmin: vi.fn(),
}));

import { reservationsRoutes } from "../routes";
import { getReservationDocViewUrlForAdmin } from "../documents.service";

function makeApp(session: ReservationSession) {
  const app = new Hono<{ Variables: { session: ReservationSession } }>();
  app.use("*", async (c, next) => {
    c.set("session", session);
    await next();
  });
  app.route("/", reservationsRoutes);
  return app;
}

const adminSession: ReservationSession = {
  userId: "u1",
  orgId: "o1",
  partyId: "p1",
  role: "admin",
  operatorRole: "admin",
};

const viewerSession: ReservationSession = {
  userId: "u2",
  orgId: "o1",
  partyId: "p2",
  role: "admin",
  operatorRole: undefined,
};

const agentSession: ReservationSession = {
  userId: "u3",
  orgId: "o1",
  partyId: "p3",
  role: "agent",
};

// The view-url route now z.string().uuid()-validates :id and :docId (P2023
// hardening), so the admin-reaching cases must use real uuids.
const RES_UUID = "11111111-1111-4111-8111-111111111111";
const DOC_UUID = "22222222-2222-4222-8222-222222222222";

describe("GET /:id/documents/:docId/view-url — role gate (route-level, no DB)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("viewer role 403 — session with operatorRole: undefined is forbidden", async () => {
    const app = makeApp(viewerSession);
    const res = await app.request("/res-1/documents/doc-1/view-url");
    expect(res.status).toBe(403);
    expect(getReservationDocViewUrlForAdmin).not.toHaveBeenCalled();
  });

  it("portal agent view-url 403 — role:agent, no operatorRole, no image URL (PII min)", async () => {
    const app = makeApp(agentSession);
    const res = await app.request("/res-1/documents/doc-1/view-url");
    expect(res.status).toBe(403);
    expect(getReservationDocViewUrlForAdmin).not.toHaveBeenCalled();
  });

  it("admin session reaches the service and returns its result", async () => {
    vi.mocked(getReservationDocViewUrlForAdmin).mockResolvedValue({
      ok: true,
      data: { url: "https://sb/signed", expiresAt: "2026-07-17T00:30:00.000Z" },
      status: 200,
    });
    const app = makeApp(adminSession);
    const res = await app.request(`/${RES_UUID}/documents/${DOC_UUID}/view-url`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.url).toBe("https://sb/signed");
    expect(getReservationDocViewUrlForAdmin).toHaveBeenCalledWith("o1", RES_UUID, DOC_UUID);
  });

  it("cross-org view-url 404 — service reports not-found, route surfaces 404 (no URL)", async () => {
    vi.mocked(getReservationDocViewUrlForAdmin).mockResolvedValue({
      ok: false,
      error: "Not found",
      status: 404,
    });
    const app = makeApp(adminSession);
    const otherDocUuid = "33333333-3333-4333-8333-333333333333";
    const res = await app.request(`/${RES_UUID}/documents/${otherDocUuid}/view-url`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.url).toBeUndefined();
  });

  it("non-uuid :id → 400 INVALID_ID, service never reached", async () => {
    const app = makeApp(adminSession);
    const res = await app.request(`/not-a-uuid/documents/${DOC_UUID}/view-url`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_ID");
    expect(getReservationDocViewUrlForAdmin).not.toHaveBeenCalled();
  });

  it("non-uuid :docId → 400 INVALID_ID, service never reached", async () => {
    const app = makeApp(adminSession);
    const res = await app.request(`/${RES_UUID}/documents/not-a-uuid/view-url`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_ID");
    expect(getReservationDocViewUrlForAdmin).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// DB-backed tests — RUN_INTEGRATION=1 only.
// ---------------------------------------------------------------------------
vi.mock("../../../lib/storage", () => ({
  createSignedUploadUrl: vi.fn(async ({ storageKey, contentType }: { storageKey: string; contentType: string }) => ({
    uploadUrl: `https://sb/${storageKey}`,
    method: "PUT",
    headers: { "content-type": contentType },
    storageKey,
  })),
  createSignedDownloadUrl: vi.fn(async (k: string) => `https://sb/view/${k}`),
  deleteObject: vi.fn(async () => {}),
  requireBucket: vi.fn(() => "bucket"),
}));

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

dn("admin reservation payload + view-url (integration)", () => {
  let getDb: typeof import("@kason/db").getDb;
  let getReservationForOrgReal: typeof import("../service").getReservationForOrg;
  let getReservationDocViewUrlForAdminReal: typeof import("../documents.service").getReservationDocViewUrlForAdmin;

  const ORG = "88888888-8888-8888-8888-888888888888";
  const ORG_OTHER = "99999999-9999-9999-9999-999999999999";
  const AGENT_PARTY = "88888888-8888-8888-8888-888888888801";
  const PROPERTY = "88888888-8888-8888-8888-888888888802";
  const APARTMENT = "88888888-8888-8888-8888-888888888803";
  const UNIT = "88888888-8888-8888-8888-888888888804";

  const adminCtx: ReservationSession = {
    orgId: ORG,
    userId: "88888888-8888-8888-8888-888888888805",
    partyId: "",
    role: "admin",
    operatorRole: "admin",
  };

  async function seedOrg(orgId: string, suffix: string) {
    const db = getDb();
    await db.organization.create({
      data: {
        id: orgId,
        name: `Admin Docs Test ${suffix}`,
        slug: `admin-docs-test-${suffix}`,
        status: "active",
        defaultCurrency: "MYR",
        timezone: "Asia/Kuala_Lumpur",
        locale: "en-MY",
        subscriptionPlan: "free",
        reservationLinkExpiryDays: 7,
      },
    });
  }

  async function seedFixture() {
    const db = getDb();
    await seedOrg(ORG, "main");
    await seedOrg(ORG_OTHER, "other");
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
        name: "Admin Docs Test Property",
        propertyCode: "ADTP-1",
        propertyType: "residential",
        addressLine1: "1 Docs St",
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
        unitCode: "D-101",
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

  async function cleanup() {
    const db = getDb();
    await db.unitReservationDocument.deleteMany({
      where: { organizationId: { in: [ORG, ORG_OTHER] } },
    });
    await db.unitReservation.deleteMany({ where: { organizationId: { in: [ORG, ORG_OTHER] } } });
    await db.notificationQueue.deleteMany({ where: { organizationId: { in: [ORG, ORG_OTHER] } } });
    await db.referenceSequence.deleteMany({ where: { organizationId: { in: [ORG, ORG_OTHER] } } });
    await db.documentTemplate.deleteMany({ where: { organizationId: { in: [ORG, ORG_OTHER] } } });
    await db.listing.deleteMany({ where: { organizationId: ORG } });
    await db.apartment.deleteMany({ where: { organizationId: ORG } });
    await db.property.deleteMany({ where: { organizationId: ORG } });
    await db.party.deleteMany({ where: { organizationId: ORG } });
    await db.organization.deleteMany({ where: { id: { in: [ORG, ORG_OTHER] } } });
  }

  async function seedReservation() {
    const db = getDb();
    return db.unitReservation.create({
      data: {
        organizationId: ORG,
        referenceCode: `RES-DOCS-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
        status: "pending_customer",
        issuedByPartyId: AGENT_PARTY,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        publicToken: `admdocs${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`,
        propertyId: PROPERTY,
        unitId: UNIT,
        carPark: "P-9",
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
        occupation: "Engineer",
        monthlyIncome: "6500.00",
        emergencyContactName: "Jane Smith",
        emergencyContactPhone: "+60123456789",
        emergencyContactRelation: "Sister",
      },
    });
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    // `../service` and `../documents.service` are statically vi.mock()'d for
    // the route-level suite above (file-wide effect — vi.mock is hoisted and
    // applies to every import of that specifier in this file, including
    // dynamic import() reached from inside a describe block). Unmock them
    // here so this describe block's dynamic imports resolve to the REAL
    // service functions and hit real Postgres, per the brief's "call
    // getReservationForOrg(orgId, id, session) directly (service-level)"
    // instruction. resetModules() forces a fresh module instance so the
    // unmock takes effect on next import (vi.doUnmock alone doesn't evict an
    // already-cached mocked instance).
    vi.doUnmock("../service");
    vi.doUnmock("../documents.service");
    vi.resetModules();

    const dbMod = await import("@kason/db");
    getDb = dbMod.getDb;
    const svcMod = await import("../service");
    getReservationForOrgReal = svcMod.getReservationForOrg;
    const docSvcMod = await import("../documents.service");
    getReservationDocViewUrlForAdminReal = docSvcMod.getReservationDocViewUrlForAdmin;

    await cleanup();
    await seedFixture();
  });

  it("payload includes docs+profile — GET /:id lists the uploaded doc and applicant.nationality", async () => {
    const reservation = await seedReservation();
    const doc = await getDb().unitReservationDocument.create({
      data: {
        organizationId: ORG,
        reservationId: reservation.id,
        kind: "ic_front",
        fileKey: `reservations/${ORG}/${reservation.id}/id-docs/ic_front`,
        filename: "ic-front.jpg",
      },
    });

    const dto = await getReservationForOrgReal(ORG, reservation.id, adminCtx);
    expect(dto).not.toBeNull();
    expect(dto?.applicant.nationality).toBe("Malaysian");
    expect(dto?.applicant.occupation).toBe("Engineer");
    expect(dto?.applicant.monthlyIncome).toBe("6500");
    expect(dto?.applicant.emergencyContactName).toBe("Jane Smith");
    expect(dto?.applicant.emergencyContactPhone).toBe("+60123456789");
    expect(dto?.applicant.emergencyContactRelation).toBe("Sister");
    expect(dto?.documents).toHaveLength(1);
    expect(dto?.documents[0]).toMatchObject({
      id: doc.id,
      kind: "ic_front",
      filename: "ic-front.jpg",
    });
    expect(typeof dto?.documents[0].uploadedAt).toBe("string");
  });

  it("cross-org view-url 404 — a docId belonging to another org is not found", async () => {
    const reservation = await seedReservation();
    const otherDoc = await getDb().unitReservationDocument.create({
      data: {
        organizationId: ORG_OTHER,
        reservationId: reservation.id, // irrelevant FK target for this org-scope test
        kind: "ic_front",
        fileKey: `reservations/${ORG_OTHER}/foreign/id-docs/ic_front`,
        filename: "foreign.jpg",
      },
    });

    const result = await getReservationDocViewUrlForAdminReal(ORG, reservation.id, otherDoc.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(404);
  });

  it("admin can fetch a signed view-url for a doc within its own org", async () => {
    const reservation = await seedReservation();
    const doc = await getDb().unitReservationDocument.create({
      data: {
        organizationId: ORG,
        reservationId: reservation.id,
        kind: "ic_back",
        fileKey: `reservations/${ORG}/${reservation.id}/id-docs/ic_back`,
        filename: "ic-back.jpg",
      },
    });

    const result = await getReservationDocViewUrlForAdminReal(ORG, reservation.id, doc.id);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.url).toContain("ic_back");
      expect(typeof result.data.expiresAt).toBe("string");
    }
  });
});
