/**
 * Integration test for R9 (move-out proration skip). Hits a real Postgres.
 *
 * Skipped by default. Run explicitly:
 *   RUN_INTEGRATION=1 DATABASE_URL="..." \
 *     npx vitest run apps/api/src/modules/billing/__tests__/post-monthly-rent.integration.test.ts
 *
 * Hand-rolled seed (mirrors service.create.integration.test.ts's seedOrgWithUnit()
 * pattern + this module's own local seed() in post-monthly-rent.test.ts) — there is
 * no shared seedTenancy helper. Uses its own ORG-scoped UUID set so it never collides
 * with post-monthly-rent.test.ts's integration fixtures (fileParallelism is disabled
 * for RUN_INTEGRATION=1 runs, but the fixtures stay isolated regardless).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { postMonthlyRentForTenancy } from "../post-monthly-rent";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`Refusing non-local DB host: ${host}`);
}

const ORG = "99999999-9999-4999-8999-999999999901";
const USER = "99999999-9999-4999-8999-999999999902";
const PROP = "99999999-9999-4999-8999-999999999903";
const APT = "99999999-9999-4999-8999-999999999904";
const ROOM = "99999999-9999-4999-8999-999999999905";
const PARTY = "99999999-9999-4999-8999-999999999906";
const TEN = "99999999-9999-4999-8999-999999999907";

async function cleanup() {
  const db = getDb();
  await db.chargeEvent.deleteMany({ where: { organizationId: ORG } });
  await db.charge.deleteMany({ where: { organizationId: ORG } });
  await db.tenancy.deleteMany({ where: { organizationId: ORG } });
  await db.listing.deleteMany({ where: { organizationId: ORG } });
  await db.apartment.deleteMany({ where: { organizationId: ORG } });
  await db.property.deleteMany({ where: { organizationId: ORG } });
  await db.party.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

// Seeds org + property + apartment + listing(unit) + party(owner+tenant) + an active
// tenancy with an explicit startDate AND endDate, so a queried month can fall entirely
// outside the occupancy window.
async function seedActiveTenancy(opts: { start: string; end: string; rent: number }) {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG, name: "R9 TR", slug: "r9-tr", status: "active",
      defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free",
    },
  });
  await db.property.create({
    data: {
      id: PROP, organizationId: ORG, name: "R9 Property", propertyCode: "R9-P1", propertyType: "residential",
      addressLine1: "1 Test St", city: "Kuala Lumpur", country: "MY", status: "active", publishStatus: "draft",
    },
  });
  await db.apartment.create({
    data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "R9-A1", listingMode: "WHOLE" },
  });
  await db.party.create({
    data: { id: PARTY, organizationId: ORG, displayName: "R9 Tenant", partyType: "individual", status: "active" },
  });
  await db.listing.create({
    data: {
      id: ROOM, organizationId: ORG, apartmentId: APT, listingType: "unit",
      occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: PARTY,
    },
  });
  await db.tenancy.create({
    data: {
      id: TEN, organizationId: ORG, propertyId: PROP, unitId: ROOM, tenantPartyId: PARTY, tenancyCode: "R9-T1",
      status: "active", billingStatus: "current",
      startDate: new Date(`${opts.start}T00:00:00.000Z`),
      endDate: new Date(`${opts.end}T00:00:00.000Z`),
      monthlyRentAmount: opts.rent.toFixed(2),
      numberOfPax: 1,
    },
  });
  return { tenancyId: TEN, orgId: ORG, actorUserId: USER };
}

dn("postMonthlyRentForTenancy skip", () => {
  beforeEach(async () => {
    await cleanup();
  });

  it("outside range skips posting (no charge row, created:false)", async () => {
    const { tenancyId, orgId, actorUserId } = await seedActiveTenancy({ start: "2026-07-06", end: "2026-07-25", rent: 2800 });
    const r = await getDb().$transaction((tx) =>
      postMonthlyRentForTenancy(tx, orgId, tenancyId, new Date(Date.UTC(2026, 8, 1)), actorUserId),
    );
    expect(r.created).toBe(false);
    expect(await getDb().charge.count({ where: { tenancyId, chargeType: "rent" } })).toBe(0);
  });
});
