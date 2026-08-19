/**
 * Integration tests for POST /:id/convert-to-tenancy (T8) -- the HTTP route
 * wrapping convertReservationToTenancy (T7). Hits a real local Postgres.
 * Verifies the viewer 403 gate checks `operatorRole` presence (NOT `role`,
 * which the admin adapter always flattens to "admin" -- see
 * session-adapter.ts) and that the route maps service results to the right
 * HTTP status/body shape.
 *
 * Skipped by default. Run explicitly:
 *   cd apps/api && RUN_INTEGRATION=1 \
 *     DATABASE_URL="postgresql://yonghongtan@localhost:5432/kason_hub_dev?schema=public" \
 *     npx vitest run convert-route
 */
import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { getDb } from "@kason/db";
import { reservationsRoutes } from "../routes";
import type { ReservationSession } from "../types";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  // This suite creates real Tenancy rows. Refuse to run against anything but
  // the local dev DB, even by accident (money-critical write path).
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`convert-route.integration.test.ts: refusing non-local DB host "${host}"`);
  }
}

const ORG = "99990009-0009-4009-8009-000000000001";
const ADMIN_USER = "99990009-0009-4009-8009-000000000002";
const OWNER_PARTY = "99990009-0009-4009-8009-000000000003";
const PROPERTY = "99990009-0009-4009-8009-000000000004";
const APARTMENT = "99990009-0009-4009-8009-000000000005";
const UNIT = "99990009-0009-4009-8009-000000000006";
const TENANT_PARTY = "99990009-0009-4009-8009-000000000007";
const TENANT_ROLE = "99990009-0009-4009-8009-000000000008";
const RES_HAPPY = "99990009-0009-4009-8009-000000000101";

// Overlap fixtures -- a second unit with a pre-existing ACTIVE tenancy, and a
// signed reservation on that SAME unit, so posting convert without `overwrite`
// must 409 with the incumbent's details.
const APARTMENT_OVERLAP = "99990009-0009-4009-8009-000000000009";
const UNIT_OVERLAP = "99990009-0009-4009-8009-00000000000a";
const TENANCY_INCUMBENT = "99990009-0009-4009-8009-000000000103";
const RES_OVERLAP = "99990009-0009-4009-8009-000000000102";

const adminSession: ReservationSession = {
  orgId: ORG,
  userId: ADMIN_USER,
  partyId: OWNER_PARTY,
  role: "admin",
  operatorRole: "admin",
};

// A viewer never gets `operatorRole` set (session-adapter.ts only sets it for
// admin/manager/editor) -- this is the exact shape the admin adapter produces
// for a viewer session, flattened `role: "admin"` and all.
const viewerSession: ReservationSession = {
  orgId: ORG,
  userId: ADMIN_USER,
  partyId: OWNER_PARTY,
  role: "admin",
  operatorRole: undefined,
};

function makeApp(session: ReservationSession) {
  const app = new Hono<{ Variables: { session: ReservationSession } }>();
  app.use("*", async (c, next) => {
    c.set("session", session);
    await next();
  });
  app.route("/", reservationsRoutes);
  return app;
}

async function cleanup() {
  const db = getDb();
  await db.tenancy.deleteMany({ where: { organizationId: ORG } });
  await db.auditLog.deleteMany({ where: { organizationId: ORG } });
  await db.unitReservation.deleteMany({ where: { organizationId: ORG } });
  await db.partyRole.deleteMany({ where: { organizationId: ORG } });
  await db.listing.deleteMany({ where: { organizationId: ORG } });
  await db.apartment.deleteMany({ where: { organizationId: ORG } });
  await db.property.deleteMany({ where: { organizationId: ORG } });
  await db.party.deleteMany({ where: { organizationId: ORG } });
  await db.user.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function seed() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG,
      name: "Convert Route Test Org",
      slug: "convert-route-test-org-t8",
      status: "active",
      defaultCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur",
      locale: "en-MY",
      subscriptionPlan: "free",
    },
  });
  // AuditLog.actorUserId FK -> User.id (onDelete: Restrict): the acting admin
  // must exist or the audit insert inside the conversion tx rolls back on a
  // FK violation.
  await db.user.create({
    data: {
      id: ADMIN_USER,
      organizationId: ORG,
      email: "admin@convert-route-t8.test",
      fullName: "Convert Route Admin",
      passwordHash: "x",
      status: "active",
      role: "admin",
      userType: "operator",
    },
  });
  await db.party.create({
    data: { id: OWNER_PARTY, organizationId: ORG, displayName: "Owner Co", partyType: "agent", status: "active" },
  });
  await db.party.create({
    data: { id: TENANT_PARTY, organizationId: ORG, displayName: "Valid Tenant", partyType: "individual", status: "active" },
  });
  await db.partyRole.create({
    data: { id: TENANT_ROLE, organizationId: ORG, partyId: TENANT_PARTY, roleType: "tenant", status: "active" },
  });
  await db.property.create({
    data: {
      id: PROPERTY,
      organizationId: ORG,
      name: "Convert Route Test Property",
      propertyCode: "CVR8-1",
      propertyType: "residential",
      addressLine1: "1 Convert Route St",
      city: "Kuala Lumpur",
      country: "MY",
      status: "active",
      publishStatus: "draft",
    },
  });
  await db.apartment.create({
    data: { id: APARTMENT, organizationId: ORG, propertyId: PROPERTY, unitCode: "CVR-101", listingMode: "WHOLE" },
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
      ownerPartyId: OWNER_PARTY,
    },
  });
  await db.unitReservation.create({
    data: {
      id: RES_HAPPY,
      organizationId: ORG,
      referenceCode: "RES-T8-HAPPY",
      status: "signed",
      issuedByPartyId: OWNER_PARTY,
      expiresAt: new Date("2030-01-01T00:00:00Z"),
      publicToken: "tok-t8-happy",
      propertyId: PROPERTY,
      unitId: UNIT,
      proposedMoveIn: new Date("2026-07-06T00:00:00Z"),
      proposedMoveOut: new Date("2026-07-25T00:00:00Z"),
      reservationDeposit: "500.00",
      documentationFee: "100.00",
      rentalDeposit: "2400.00",
      utilityDeposit: "300.00",
      accessCardDeposit: "50.00",
      agreedMonthlyRent: "2800.00",
      signedAt: new Date("2026-07-01T00:00:00Z"),
    },
  });

  // Overlap fixtures: a different unit that already has an ACTIVE tenancy,
  // plus a signed reservation on that same unit.
  await db.apartment.create({
    data: { id: APARTMENT_OVERLAP, organizationId: ORG, propertyId: PROPERTY, unitCode: "CVR-102", listingMode: "WHOLE" },
  });
  await db.listing.create({
    data: {
      id: UNIT_OVERLAP,
      organizationId: ORG,
      apartmentId: APARTMENT_OVERLAP,
      listingType: "apartment",
      occupancyStatus: "occupied",
      listingStatus: "active",
      readyNow: true,
      currency: "MYR",
      ownerPartyId: OWNER_PARTY,
    },
  });
  await db.tenancy.create({
    data: {
      id: TENANCY_INCUMBENT,
      organizationId: ORG,
      propertyId: PROPERTY,
      unitId: UNIT_OVERLAP,
      tenantPartyId: TENANT_PARTY,
      tenancyCode: "TEN-T8-INCUMBENT",
      status: "active",
      billingStatus: "active",
      startDate: new Date("2026-01-01T00:00:00Z"),
      endDate: new Date("2026-11-30T00:00:00Z"),
      monthlyRentAmount: "2500.00",
    },
  });
  await db.unitReservation.create({
    data: {
      id: RES_OVERLAP,
      organizationId: ORG,
      referenceCode: "RES-T8-OVERLAP",
      status: "signed",
      issuedByPartyId: OWNER_PARTY,
      expiresAt: new Date("2030-01-01T00:00:00Z"),
      publicToken: "tok-t8-overlap",
      propertyId: PROPERTY,
      unitId: UNIT_OVERLAP,
      proposedMoveIn: new Date("2026-12-01T00:00:00Z"),
      proposedMoveOut: new Date("2027-05-31T00:00:00Z"),
      reservationDeposit: "500.00",
      documentationFee: "100.00",
      rentalDeposit: "2400.00",
      utilityDeposit: "300.00",
      accessCardDeposit: "50.00",
      agreedMonthlyRent: "3000.00",
      signedAt: new Date("2026-11-01T00:00:00Z"),
    },
  });
}

dn("POST /:id/convert-to-tenancy (integration, T8)", () => {
  beforeEach(async () => {
    await cleanup();
    await seed();
  });

  it("creates tenancy", async () => {
    const app = makeApp(adminSession);
    const res = await app.request(`/${RES_HAPPY}/convert-to-tenancy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantPartyId: TENANT_PARTY }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.id).toBeTruthy();

    const db = getDb();
    const tenancy = await db.tenancy.findUniqueOrThrow({ where: { id: body.data.id } });
    expect(tenancy.unitId).toBe(UNIT);
    expect(tenancy.tenantPartyId).toBe(TENANT_PARTY);
    expect(tenancy.reservationId).toBe(RES_HAPPY);
  });

  it("viewer forbidden", async () => {
    const app = makeApp(viewerSession);
    const res = await app.request(`/${RES_HAPPY}/convert-to-tenancy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantPartyId: TENANT_PARTY }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("FORBIDDEN");

    const count = await getDb().tenancy.count({ where: { reservationId: RES_HAPPY } });
    expect(count).toBe(0);
  });

  it("overlap 409", async () => {
    const app = makeApp(adminSession);
    const res = await app.request(`/${RES_OVERLAP}/convert-to-tenancy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantPartyId: TENANT_PARTY }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("UNIT_HAS_ACTIVE_TENANCY");
    expect(body.incumbent).toBeTruthy();
    expect(body.incumbent.tenantName).toBe("Valid Tenant");

    const count = await getDb().tenancy.count({ where: { unitId: UNIT_OVERLAP } });
    expect(count).toBe(1);
  });

  // Final-review Fix 3: the route used to only check tenantPartyId truthiness,
  // so a non-uuid string reached Prisma (partyId is a uuid column) and threw
  // P2023 -- caught by neither mapTenancyP2002 nor the tagged-error unwrap in
  // convert-reservation.service.ts, so it fell through to the generic 500
  // handler. A malformed id should be a clean 400, not a 500.
  it("non-uuid tenantPartyId returns 400 not 500", async () => {
    const app = makeApp(adminSession);
    const res = await app.request(`/${RES_HAPPY}/convert-to-tenancy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantPartyId: "not-a-uuid" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("TENANT_PARTY_INVALID");

    const count = await getDb().tenancy.count({ where: { reservationId: RES_HAPPY } });
    expect(count).toBe(0);
  });

  // Same P2023 class of bug on the :id route param (UnitReservation.id is
  // also a uuid column).
  it("non-uuid reservation id param returns 400 not 500", async () => {
    const app = makeApp(adminSession);
    const res = await app.request(`/not-a-uuid/convert-to-tenancy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantPartyId: TENANT_PARTY }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("RESERVATION_ID_INVALID");

    const count = await getDb().tenancy.count({ where: { reservationId: RES_HAPPY } });
    expect(count).toBe(0);
  });

  // Gate-order regression guard: the 403 viewer check must still fire BEFORE
  // any uuid parsing, so a viewer sending garbage still gets 403 (not 400).
  it("viewer 403 fires before uuid validation", async () => {
    const app = makeApp(viewerSession);
    const res = await app.request(`/not-a-uuid/convert-to-tenancy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantPartyId: "also-not-a-uuid" }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("FORBIDDEN");
  });
});
