/**
 * Route test for the public token-gated reservation document endpoints:
 *   POST   /:token/upload-url
 *   POST   /:token/documents/mark-uploaded
 *   DELETE /:token/documents/:kind
 *
 * The happy/409 cases resolve a real seeded reservation via
 * documents.service -> needs the real DB. apps/api aliases @kason/db to a
 * mock unless RUN_INTEGRATION=1, so those cases are guarded and skipped by
 * default. Run explicitly:
 *   RUN_INTEGRATION=1 DATABASE_URL="..." \
 *     npx vitest run apps/api/src/modules/reservations/__tests__/public-reservation-documents.routes.test.ts
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../lib/storage", () => ({
  createSignedUploadUrl: vi.fn(
    async ({ storageKey, contentType }: { storageKey: string; contentType: string }) => ({
      uploadUrl: `https://sb/${storageKey}`,
      method: "PUT",
      headers: { "content-type": contentType },
      storageKey,
    }),
  ),
  createSignedDownloadUrl: vi.fn(async (k: string) => `https://sb/view/${k}`),
  deleteObject: vi.fn(async () => {}),
  requireBucket: vi.fn(() => "bucket"),
}));

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

dn("public reservation document routes (integration)", () => {
  let publicReservationsRoutes: typeof import("../public.routes").publicReservationsRoutes;
  let getDb: typeof import("@kason/db").getDb;
  let createReservationService: typeof import("../service").createReservationService;

  const ORG = "aaaaaaaa-1111-1111-1111-111111111111";
  const AGENT_PARTY = "aaaaaaaa-2222-2222-2222-222222222222";
  const AGENT_USER = "aaaaaaaa-3333-3333-3333-333333333333";
  const PROPERTY = "aaaaaaaa-4444-4444-4444-444444444444";
  const APARTMENT = "aaaaaaaa-5555-5555-5555-555555555555";
  const UNIT = "aaaaaaaa-6666-6666-6666-666666666666";

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
        slug: "t-routes-docs",
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
        propertyCode: "TP-RD1",
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
    const routesMod = await import("../public.routes");
    publicReservationsRoutes = routesMod.publicReservationsRoutes;
    const svcMod = await import("../service");
    createReservationService = svcMod.createReservationService;

    await cleanup();
    await seedOrgWithUnit();
  });

  describe("POST /:token/upload-url", () => {
    it("issues upload url", async () => {
      const res = await seedReservation();
      const r = await publicReservationsRoutes.request(`/${res.token}/upload-url`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "ic_front", contentType: "image/jpeg", filename: "ic.jpg" }),
      });
      expect(r.status).toBe(200);
      const json = await r.json();
      expect(json.data.uploadUrl).toBe(
        `https://sb/reservations/${ORG}/${res.id}/id-docs/ic_front`,
      );
    });

    it("409 on non-pending", async () => {
      const res = await seedReservation({ status: "signed" });
      const r = await publicReservationsRoutes.request(`/${res.token}/upload-url`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "ic_front", contentType: "image/jpeg", filename: "ic.jpg" }),
      });
      expect(r.status).toBe(409);
    });

    it("404 on bad token", async () => {
      const r = await publicReservationsRoutes.request(`/not-a-real-token-xxxxxx/upload-url`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "ic_front", contentType: "image/jpeg", filename: "ic.jpg" }),
      });
      expect(r.status).toBe(404);
    });

    it("400 on invalid body", async () => {
      const res = await seedReservation();
      const r = await publicReservationsRoutes.request(`/${res.token}/upload-url`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "not_a_kind", contentType: "image/jpeg", filename: "ic.jpg" }),
      });
      expect(r.status).toBe(400);
    });
  });

  describe("POST /:token/documents/mark-uploaded", () => {
    it("marks upload", async () => {
      const res = await seedReservation();
      const r = await publicReservationsRoutes.request(`/${res.token}/documents/mark-uploaded`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "ic_front", filename: "ic.jpg" }),
      });
      expect(r.status).toBe(201);
      const json = await r.json();
      expect(json.data.kind).toBe("ic_front");
      expect(json.data.filename).toBe("ic.jpg");
    });
  });

  describe("DELETE /:token/documents/:kind", () => {
    it("deletes existing doc", async () => {
      const res = await seedReservation();
      await publicReservationsRoutes.request(`/${res.token}/documents/mark-uploaded`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "ic_back", filename: "ic-back.jpg" }),
      });

      const r = await publicReservationsRoutes.request(`/${res.token}/documents/ic_back`, {
        method: "DELETE",
      });
      expect(r.status).toBe(204);
    });

    it("rejects bad kind", async () => {
      const res = await seedReservation();
      const r = await publicReservationsRoutes.request(`/${res.token}/documents/not_a_kind`, {
        method: "DELETE",
      });
      expect(r.status).toBe(400);
    });
  });
});
