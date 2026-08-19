/**
 * Test for the reservation document service (server-derived storage keys,
 * token-gated upload/mark/delete, admin view-url).
 *
 * `buildReservationDocKey` is a pure function — it always runs.
 *
 * Everything else touches the real DB (reservation lookup by publicToken,
 * UnitReservationDocument upsert/delete). Those cases are DB-backed
 * integration tests, skipped by default (apps/api aliases @kason/db to a
 * mock outside RUN_INTEGRATION, and the mock has no real reservation).
 * Run explicitly:
 *   RUN_INTEGRATION=1 DATABASE_URL="..." \
 *     npx vitest run apps/api/src/modules/reservations/__tests__/reservation-documents.service.test.ts
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

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

import { buildReservationDocKey } from "../documents.service";

// ---------------------------------------------------------------------------
// Pure-function tests — no DB, always run.
// ---------------------------------------------------------------------------
describe("buildReservationDocKey (pure)", () => {
  it("derives deterministic key", () => {
    expect(buildReservationDocKey("org1", "res1", "ic_front")).toBe(
      "reservations/org1/res1/id-docs/ic_front",
    );
  });

  it("derives distinct keys per kind", () => {
    expect(buildReservationDocKey("org1", "res1", "passport_front")).toBe(
      "reservations/org1/res1/id-docs/passport_front",
    );
    expect(buildReservationDocKey("org1", "res1", "passport_back")).toBe(
      "reservations/org1/res1/id-docs/passport_back",
    );
  });

  it("rejects a non-enum kind (path-traversal backstop)", () => {
    expect(() => buildReservationDocKey("org1", "res1", "../../evil")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// DB-backed tests — RUN_INTEGRATION=1 only.
// ---------------------------------------------------------------------------
const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

dn("reservation documents service (integration)", () => {
  let getDb: typeof import("@kason/db").getDb;
  let requestReservationUploadUrlByToken: typeof import("../documents.service").requestReservationUploadUrlByToken;
  let markReservationDocUploadedByToken: typeof import("../documents.service").markReservationDocUploadedByToken;
  let deleteReservationDocByToken: typeof import("../documents.service").deleteReservationDocByToken;
  let getReservationDocViewUrlForAdmin: typeof import("../documents.service").getReservationDocViewUrlForAdmin;
  let createReservationService: typeof import("../service").createReservationService;
  let storageMocks: typeof import("../../../lib/storage");

  const ORG = "22222222-2222-2222-2222-222222222222";
  const AGENT_PARTY = "33333333-3333-3333-3333-333333333333";
  const AGENT_USER = "44444444-4444-4444-4444-444444444444";
  const PROPERTY = "55555555-5555-5555-5555-555555555555";
  const APARTMENT = "77777777-7777-7777-7777-777777777777";
  const UNIT = "66666666-6666-6666-6666-666666666666";

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
    await db.unitReservationDocument.deleteMany({ where: { organizationId: ORG } });
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

  // Creates a real reservation via the existing create service (guarantees a
  // valid 22-char publicToken + expiresAt honoring the org's config), then
  // optionally forces the row to a specific status for negative-path tests.
  async function seedReservation(opts: { status?: "pending_customer" | "signed" } = {}) {
    const created = await createReservationService(
      { orgId: ORG, userId: AGENT_USER, partyId: AGENT_PARTY, role: "agent" },
      SECTION_A,
    );
    if (!created.ok) throw new Error("seedReservation setup failed");

    if (opts.status && opts.status !== "pending_customer") {
      await getDb().unitReservation.update({
        where: { id: created.data.id },
        data: { status: opts.status },
      });
    }

    return {
      id: created.data.id,
      token: created.data.publicToken,
      status: opts.status ?? "pending_customer",
    };
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    const dbMod = await import("@kason/db");
    getDb = dbMod.getDb;
    const svcMod = await import("../documents.service");
    requestReservationUploadUrlByToken = svcMod.requestReservationUploadUrlByToken;
    markReservationDocUploadedByToken = svcMod.markReservationDocUploadedByToken;
    deleteReservationDocByToken = svcMod.deleteReservationDocByToken;
    getReservationDocViewUrlForAdmin = svcMod.getReservationDocViewUrlForAdmin;
    const resSvcMod = await import("../service");
    createReservationService = resSvcMod.createReservationService;
    storageMocks = await import("../../../lib/storage");

    await cleanup();
    await seedOrgWithUnit();
  });

  describe("requestReservationUploadUrlByToken", () => {
    it("rejects upload on non-pending", async () => {
      const res = await seedReservation({ status: "signed" });
      const r = await requestReservationUploadUrlByToken(res.token, {
        kind: "ic_front",
        contentType: "image/jpeg",
        filename: "ic.jpg",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.status).toBe(409);
    });

    it("returns 404 for an unknown/malformed token", async () => {
      const r = await requestReservationUploadUrlByToken("nope", {
        kind: "ic_front",
        contentType: "image/jpeg",
        filename: "ic.jpg",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.status).toBe(404);
    });

    it("mints a signed upload URL using a server-derived key for a pending reservation", async () => {
      const res = await seedReservation();
      const r = await requestReservationUploadUrlByToken(res.token, {
        kind: "ic_front",
        contentType: "image/jpeg",
        filename: "ic.jpg",
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.data.uploadUrl).toBe(
          `https://sb/reservations/${ORG}/${res.id}/id-docs/ic_front`,
        );
        expect(r.data.method).toBe("PUT");
      }
      expect(storageMocks.createSignedUploadUrl).toHaveBeenCalledWith({
        storageKey: `reservations/${ORG}/${res.id}/id-docs/ic_front`,
        contentType: "image/jpeg",
      });
    });
  });

  describe("markReservationDocUploadedByToken", () => {
    it("creates exactly one row per (reservationId, kind) across two mark-uploaded calls", async () => {
      const res = await seedReservation();

      const first = await markReservationDocUploadedByToken(res.token, {
        kind: "ic_front",
        filename: "ic-v1.jpg",
      });
      expect(first.ok).toBe(true);

      const second = await markReservationDocUploadedByToken(res.token, {
        kind: "ic_front",
        filename: "ic-v2.jpg",
      });
      expect(second.ok).toBe(true);

      const rows = await getDb().unitReservationDocument.findMany({
        where: { reservationId: res.id, kind: "ic_front" },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].filename).toBe("ic-v2.jpg");
    });

    it("server-derives the fileKey — does not accept a client-supplied key", async () => {
      const res = await seedReservation();
      const r = await markReservationDocUploadedByToken(res.token, {
        kind: "passport_front",
        filename: "passport.jpg",
      });
      expect(r.ok).toBe(true);

      const row = await getDb().unitReservationDocument.findUniqueOrThrow({
        where: { reservationId_kind: { reservationId: res.id, kind: "passport_front" } },
      });
      expect(row.fileKey).toBe(`reservations/${ORG}/${res.id}/id-docs/passport_front`);
    });

    it("rejects mark-uploaded on non-pending", async () => {
      const res = await seedReservation({ status: "signed" });
      const r = await markReservationDocUploadedByToken(res.token, {
        kind: "ic_front",
        filename: "ic.jpg",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.status).toBe(409);
    });
  });

  describe("deleteReservationDocByToken", () => {
    it("deletes the storage object and the DB row", async () => {
      const res = await seedReservation();
      await markReservationDocUploadedByToken(res.token, {
        kind: "ic_back",
        filename: "ic-back.jpg",
      });

      const r = await deleteReservationDocByToken(res.token, "ic_back");
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.data.deleted).toBe(true);

      expect(storageMocks.deleteObject).toHaveBeenCalledWith(
        "bucket",
        `reservations/${ORG}/${res.id}/id-docs/ic_back`,
      );

      const row = await getDb().unitReservationDocument.findUnique({
        where: { reservationId_kind: { reservationId: res.id, kind: "ic_back" } },
      });
      expect(row).toBeNull();
    });

    it("returns 404 when there is no document for that kind", async () => {
      const res = await seedReservation();
      const r = await deleteReservationDocByToken(res.token, "passport_back");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.status).toBe(404);
    });

    it("rejects delete on non-pending", async () => {
      const res = await seedReservation({ status: "signed" });
      const r = await deleteReservationDocByToken(res.token, "ic_front");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.status).toBe(409);
    });
  });

  describe("getReservationDocViewUrlForAdmin", () => {
    it("returns a signed view URL for an org-scoped doc", async () => {
      const res = await seedReservation();
      const marked = await markReservationDocUploadedByToken(res.token, {
        kind: "ic_front",
        filename: "ic.jpg",
      });
      if (!marked.ok) throw new Error("setup failed");

      const r = await getReservationDocViewUrlForAdmin(ORG, res.id, marked.data.id);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.data.url).toBe(
          `https://sb/view/reservations/${ORG}/${res.id}/id-docs/ic_front`,
        );
        expect(typeof r.data.expiresAt).toBe("string");
      }
    });

    it("returns 404 when the doc does not belong to the given org", async () => {
      const res = await seedReservation();
      const marked = await markReservationDocUploadedByToken(res.token, {
        kind: "ic_front",
        filename: "ic.jpg",
      });
      if (!marked.ok) throw new Error("setup failed");

      const r = await getReservationDocViewUrlForAdmin(
        "99999999-9999-9999-9999-999999999999",
        res.id,
        marked.data.id,
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.status).toBe(404);
    });

    it("returns 404 when the docId is unknown", async () => {
      const res = await seedReservation();
      const r = await getReservationDocViewUrlForAdmin(
        ORG,
        res.id,
        "00000000-0000-0000-0000-000000000000",
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.status).toBe(404);
    });
  });
});
