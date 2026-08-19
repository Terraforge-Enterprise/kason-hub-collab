/**
 * P4 Task 4: getApartmentContextService — integration (real local Postgres).
 * Opt-in via RUN_INTEGRATION=1. Fixed UUIDs prefix f8.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getDb } from "@kason/db";
import type { OwnerLedgerActorCtx } from "../owner-ledger.types";
import { getApartmentContextService } from "../owner-ledger.service";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

const ORG       = "f8000000-0000-4000-8000-000000000001";
const OWNER     = "f8000000-0000-4000-8000-000000000004";
const TENANT    = "f8000000-0000-4000-8000-000000000005";
const PROPERTY  = "f8000000-0000-4000-8000-000000000006";
const APT       = "f8000000-0000-4000-8000-0000000000a1";
const LISTING_1 = "f8000000-0000-4000-8000-0000000000a2"; // occupied
const LISTING_2 = "f8000000-0000-4000-8000-0000000000a4"; // vacant
const TENANCY_1 = "f8000000-0000-4000-8000-0000000000a3";

const ctx: OwnerLedgerActorCtx = {
  orgId: ORG,
  actorUserId: "f8000000-0000-4000-8000-000000000002",
  actorRole: "manager",
};

async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  await db.tenancy.deleteMany({ where: org });
  await db.listing.deleteMany({ where: org });
  await db.apartment.deleteMany({ where: org });
  await db.property.deleteMany({ where: org });
  await db.party.deleteMany({ where: org });
  await db.organization.deleteMany({ where: { id: ORG } });
}

dn("getApartmentContextService (P4)", () => {
  beforeAll(async () => {
    await cleanup();
    const db = getDb();
    await db.organization.create({
      data: {
        id: ORG, name: "Ctx Org", slug: "ctx-org",
        status: "active", defaultCurrency: "MYR",
        timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free",
      },
    });
    await db.party.create({ data: { id: OWNER, organizationId: ORG, displayName: "Ctx Owner", partyType: "individual", status: "active" } });
    await db.party.create({ data: { id: TENANT, organizationId: ORG, displayName: "Ctx Tenant", partyType: "individual", status: "active" } });
    await db.property.create({
      data: {
        id: PROPERTY, organizationId: ORG, name: "Ctx Residences",
        propertyCode: "CX1", propertyType: "apartment",
        addressLine1: "8 Ctx St", city: "KL", country: "MY",
        status: "active", publishStatus: "draft",
      },
    });
    await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROPERTY, unitCode: "C-08-01", listingMode: "PARTITIONED" } });
    await db.listing.create({ data: { id: LISTING_1, organizationId: ORG, apartmentId: APT, listingType: "master", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER } });
    await db.listing.create({ data: { id: LISTING_2, organizationId: ORG, apartmentId: APT, listingType: "middle", occupancyStatus: "vacant", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER } });
    await db.tenancy.create({ data: { id: TENANCY_1, organizationId: ORG, propertyId: PROPERTY, unitId: LISTING_1, tenantPartyId: TENANT, tenancyCode: "CX-T1", status: "active", billingStatus: "current", startDate: new Date("2025-01-01T00:00:00.000Z"), monthlyRentAmount: "800.00" } });
  });

  afterAll(cleanup);

  it("resolves unit, property, owner, and only the OCCUPIED room's tenancy", async () => {
    const res = await getApartmentContextService(ctx, APT);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.unitCode).toBe("C-08-01");
    expect(res.data.listingMode).toBe("PARTITIONED");
    expect(res.data.propertyName).toBe("Ctx Residences");
    expect(res.data.ownerPartyId).toBe(OWNER);
    expect(res.data.ownerName).toBe("Ctx Owner");
    expect(res.data.activeTenancies).toEqual([
      {
        tenancyId: TENANCY_1,
        listingId: LISTING_1,
        listingType: "master",
        tenantPartyId: TENANT,
        tenantDisplayName: "Ctx Tenant",
      },
    ]);
  });

  it("404s an unknown apartment id", async () => {
    const res = await getApartmentContextService(ctx, "f8000000-0000-4000-8000-0000000000ff");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(404);
  });

  it("404s a cross-org apartment id (org scoping)", async () => {
    const res = await getApartmentContextService({ ...ctx, orgId: "f8000000-0000-4000-8000-0000000000ee" }, APT);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(404);
  });
});
