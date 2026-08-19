/**
 * Integration tests for GET /:tenantPartyId/linked-to-tenant -- actually
 * mounted as GET /linked-to-tenant/:tenantPartyId (T13/R5). Hits a real local
 * Postgres. This is the backend affordance that lets the web rewire
 * auto-derive tenancy terms from the SELECTED TENANT's own linked signed
 * reservation, instead of trusting a free-pick reservation select that could
 * belong to an unrelated applicant (money mis-assignment foot-gun).
 *
 * Verifies:
 *   - a tenant created-from a signed, not-yet-converted reservation resolves
 *     that reservation, with the applicant's NRIC masked (never raw) before
 *     it leaves the service layer;
 *   - once the reservation has been converted (a Tenancy row references it),
 *     the same tenant resolves null -- the `tenancy: { is: null }` filter;
 *   - a tenant with no linked reservation at all resolves null;
 *   - a tenantPartyId that is only linked to a reservation in ANOTHER org
 *     resolves null for a same-id lookup scoped to this org (cross-org
 *     isolation -- the lookup must never leak across org boundaries);
 *   - a tenant whose linked reservation is not yet signed (pending_customer)
 *     resolves null -- only "signed" is a valid derive source.
 *
 * Skipped by default. Run explicitly:
 *   cd apps/api && RUN_INTEGRATION=1 \
 *     DATABASE_URL="postgresql://yonghongtan@localhost:5432/kason_hub_dev?schema=public" \
 *     npx vitest run linked-to-tenant
 */
import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { getDb } from "@kason/db";
import { reservationsRoutes } from "../routes";
import { maskIdNumber } from "../../../lib/ic-reveal";
import type { ReservationSession } from "../types";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  // Read-only suite, but stay consistent with the other reservation
  // integration tests -- refuse anything but a local DB host, even by
  // accident.
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`linked-to-tenant.integration.test.ts: refusing non-local DB host "${host}"`);
  }
}

const ORG = "cc111111-1111-1111-1111-111111111111";
const AGENT_PARTY = "cc111111-1111-1111-1111-111111111112";
const PROPERTY = "cc111111-1111-1111-1111-111111111113";
const APARTMENT = "cc111111-1111-1111-1111-111111111114";
const UNIT = "cc111111-1111-1111-1111-111111111115";

const TENANT_UNCONVERTED = "cc222222-2222-2222-2222-222222222221";
const RES_UNCONVERTED = "cc222222-2222-2222-2222-222222222222";

const TENANT_CONVERTED = "cc333333-3333-3333-3333-333333333331";
const RES_CONVERTED = "cc333333-3333-3333-3333-333333333332";
const TENANCY_FOR_CONVERTED = "cc333333-3333-3333-3333-333333333333";

const TENANT_NO_RESERVATION = "cc444444-4444-4444-4444-444444444441";

const TENANT_PENDING = "cc555555-5555-5555-5555-555555555551";
const RES_PENDING = "cc555555-5555-5555-5555-555555555552";

// Second org -- proves the lookup never leaks a linked reservation across
// org boundaries even when the exact tenantPartyId is reused as a lookup key
// against a DIFFERENT (foreign) org's session.
const ORG2 = "cc666666-6666-6666-6666-666666666661";
const AGENT_PARTY_ORG2 = "cc666666-6666-6666-6666-666666666662";
const PROPERTY_ORG2 = "cc666666-6666-6666-6666-666666666663";
const APARTMENT_ORG2 = "cc666666-6666-6666-6666-666666666664";
const UNIT_ORG2 = "cc666666-6666-6666-6666-666666666665";
const TENANT_ORG2 = "cc666666-6666-6666-6666-666666666666";
const RES_ORG2 = "cc666666-6666-6666-6666-666666666667";

const APPLICANT_NRIC = "880101-14-1234";

const adminSession: ReservationSession = {
  orgId: ORG,
  userId: "cc000000-0000-0000-0000-000000000001",
  partyId: AGENT_PARTY,
  role: "admin",
  operatorRole: "admin",
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
  await db.tenancy.deleteMany({ where: { organizationId: { in: [ORG, ORG2] } } });
  await db.unitReservation.deleteMany({ where: { organizationId: { in: [ORG, ORG2] } } });
  await db.listing.deleteMany({ where: { organizationId: { in: [ORG, ORG2] } } });
  await db.apartment.deleteMany({ where: { organizationId: { in: [ORG, ORG2] } } });
  await db.property.deleteMany({ where: { organizationId: { in: [ORG, ORG2] } } });
  await db.party.deleteMany({ where: { organizationId: { in: [ORG, ORG2] } } });
  await db.organization.deleteMany({ where: { id: { in: [ORG, ORG2] } } });
}

async function seedOrg(
  orgId: string,
  agentPartyId: string,
  propertyId: string,
  apartmentId: string,
  unitId: string,
  propertyCode: string,
  unitCode: string,
) {
  const db = getDb();
  await db.organization.create({
    data: {
      id: orgId,
      name: "Test",
      slug: `linked-to-tenant-${orgId.slice(0, 8)}`,
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
      id: agentPartyId,
      organizationId: orgId,
      displayName: "Agent",
      partyType: "agent",
      status: "active",
    },
  });
  await db.property.create({
    data: {
      id: propertyId,
      organizationId: orgId,
      name: "Test Property",
      propertyCode,
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
      id: apartmentId,
      organizationId: orgId,
      propertyId,
      unitCode,
      listingMode: "WHOLE",
    },
  });
  await db.listing.create({
    data: {
      id: unitId,
      organizationId: orgId,
      apartmentId,
      listingType: "apartment",
      occupancyStatus: "vacant",
      listingStatus: "active",
      readyNow: true,
      currency: "MYR",
      ownerPartyId: agentPartyId,
    },
  });
}

async function seed() {
  const db = getDb();
  await seedOrg(ORG, AGENT_PARTY, PROPERTY, APARTMENT, UNIT, "LTT-1", "LTT-101");
  await seedOrg(
    ORG2,
    AGENT_PARTY_ORG2,
    PROPERTY_ORG2,
    APARTMENT_ORG2,
    UNIT_ORG2,
    "LTT-2",
    "LTT-201",
  );

  for (const partyId of [
    TENANT_UNCONVERTED,
    TENANT_CONVERTED,
    TENANT_NO_RESERVATION,
    TENANT_PENDING,
  ]) {
    await db.party.create({
      data: {
        id: partyId,
        organizationId: ORG,
        displayName: "Tenant",
        partyType: "individual",
        status: "active",
      },
    });
  }
  await db.party.create({
    data: {
      id: TENANT_ORG2,
      organizationId: ORG2,
      displayName: "Tenant Org2",
      partyType: "individual",
      status: "active",
    },
  });

  const base = {
    organizationId: ORG,
    issuedByPartyId: AGENT_PARTY,
    expiresAt: new Date("2026-12-31T00:00:00Z"),
    propertyId: PROPERTY,
    unitId: UNIT,
    proposedMoveIn: new Date("2026-06-01T00:00:00Z"),
    proposedMoveOut: new Date("2027-05-31T00:00:00Z"),
    reservationDeposit: "500.00",
    documentationFee: "100.00",
    rentalDeposit: "2400.00",
    utilityDeposit: "300.00",
    accessCardDeposit: "50.00",
    agreedMonthlyRent: "2500.00",
    applicantFullName: "Jane Applicant",
    applicantNric: APPLICANT_NRIC,
    applicantContact: "0123456789",
    applicantEmail: "jane@example.com",
  };

  // Signed, not yet converted -- the happy path.
  await db.unitReservation.create({
    data: {
      ...base,
      id: RES_UNCONVERTED,
      referenceCode: "LTT-00001",
      status: "signed",
      publicToken: "ltt-unconverted-token",
      tenantPartyId: TENANT_UNCONVERTED,
      signedAt: new Date("2026-05-01T00:00:00Z"),
    },
  });

  // Signed AND already converted -- a Tenancy row references it via
  // reservationId, so `tenancy: { is: null }` must exclude it.
  await db.unitReservation.create({
    data: {
      ...base,
      id: RES_CONVERTED,
      referenceCode: "LTT-00002",
      status: "signed",
      publicToken: "ltt-converted-token",
      tenantPartyId: TENANT_CONVERTED,
      signedAt: new Date("2026-05-01T00:00:00Z"),
    },
  });
  await db.tenancy.create({
    data: {
      id: TENANCY_FOR_CONVERTED,
      organizationId: ORG,
      propertyId: PROPERTY,
      unitId: UNIT,
      tenantPartyId: TENANT_CONVERTED,
      tenancyCode: "LTT-TEN-1",
      status: "active",
      billingStatus: "active",
      startDate: base.proposedMoveIn,
      endDate: base.proposedMoveOut,
      monthlyRentAmount: base.agreedMonthlyRent,
      reservationId: RES_CONVERTED,
    },
  });

  // Linked but NOT signed (pending_customer) -- not a valid derive source.
  await db.unitReservation.create({
    data: {
      ...base,
      id: RES_PENDING,
      referenceCode: "LTT-00003",
      status: "pending_customer",
      publicToken: "ltt-pending-token",
      tenantPartyId: TENANT_PENDING,
    },
  });

  // Reservation in ORG2, linked to a tenant party that ALSO lives in ORG2.
  // Used to prove a session scoped to ORG cannot resolve it even though the
  // tenantPartyId is a real, linked, signed reservation -- just in the wrong
  // org.
  await db.unitReservation.create({
    data: {
      organizationId: ORG2,
      issuedByPartyId: AGENT_PARTY_ORG2,
      expiresAt: new Date("2026-12-31T00:00:00Z"),
      propertyId: PROPERTY_ORG2,
      unitId: UNIT_ORG2,
      proposedMoveIn: new Date("2026-06-01T00:00:00Z"),
      reservationDeposit: "500.00",
      documentationFee: "100.00",
      rentalDeposit: "2400.00",
      utilityDeposit: "300.00",
      accessCardDeposit: "50.00",
      agreedMonthlyRent: "1900.00",
      applicantFullName: "Org2 Applicant",
      applicantNric: "770101-14-9999",
      applicantContact: "0199999999",
      applicantEmail: "org2@example.com",
      id: RES_ORG2,
      referenceCode: "LTT-00004",
      status: "signed",
      publicToken: "ltt-org2-token",
      tenantPartyId: TENANT_ORG2,
      signedAt: new Date("2026-05-01T00:00:00Z"),
    },
  });

  // TENANT_NO_RESERVATION has no UnitReservation row referencing it at all.
}

dn("GET /linked-to-tenant/:tenantPartyId (integration, T13/R5)", () => {
  beforeEach(async () => {
    await cleanup();
    await seed();
  });

  it("resolves the signed, not-yet-converted reservation linked to the tenant, NRIC masked", async () => {
    const app = makeApp(adminSession);
    const res = await app.request(`/linked-to-tenant/${TENANT_UNCONVERTED}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).not.toBeNull();
    expect(body.data.id).toBe(RES_UNCONVERTED);
    expect(body.data.applicant.nricMasked).toBe(maskIdNumber(APPLICANT_NRIC));
    expect(body.data.applicant.nricMasked).not.toBe(APPLICANT_NRIC);
    expect(body.data.applicant.nricMasked).not.toContain("880101");
    expect(body.data.unit.label).toContain("LTT-101");
  });

  it("resolves null once the linked reservation has already been converted (Tenancy exists)", async () => {
    const app = makeApp(adminSession);
    const res = await app.request(`/linked-to-tenant/${TENANT_CONVERTED}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toBeNull();
  });

  it("resolves null for a tenant with no linked reservation", async () => {
    const app = makeApp(adminSession);
    const res = await app.request(`/linked-to-tenant/${TENANT_NO_RESERVATION}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toBeNull();
  });

  it("resolves null for a linked reservation that belongs to ANOTHER org (cross-org isolation)", async () => {
    const app = makeApp(adminSession); // scoped to ORG, not ORG2
    const res = await app.request(`/linked-to-tenant/${TENANT_ORG2}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toBeNull();
  });

  it("resolves null for a tenant whose linked reservation is not yet signed (pending_customer)", async () => {
    const app = makeApp(adminSession);
    const res = await app.request(`/linked-to-tenant/${TENANT_PENDING}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toBeNull();
  });
});
