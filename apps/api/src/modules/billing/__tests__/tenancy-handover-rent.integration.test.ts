/**
 * Period-aware tenancy selection — the A-03-03 "rental shows RM 0.00" defect.
 *
 * Money-critical. Reproduces, against a REAL Postgres, the two ways the old
 * `status: "active"` selection lost money when a tenancy was replaced:
 *
 *  (a) REPLACEMENT — the unit's July occupant ends and a new tenancy starts Aug 1.
 *      Selecting by current status priced JULY against the August tenancy → zero
 *      occupied days → RM0.00, while July's real occupant (now `ended`) was never
 *      billed at all. Neither failure raised an error.
 *
 *  (b) HANDOVER — an outgoing tenancy (Jul 1-14) is replaced mid-month (Jul 15 on).
 *      Only ONE tenancy was ever considered, so the outgoing tenant's 14 days simply
 *      vanished. The two prorated shares must sum to exactly one month's rent.
 *
 * Real local Postgres only. Seeds its OWN org (never the shared dev seed) and tears
 * down org-scoped, per the convention in bill-issuance.integration.test.ts.
 * Run: from apps/api
 *   set -a; . ../../.env; set +a; RUN_INTEGRATION=1 npx vitest run \
 *     src/modules/billing/__tests__/tenancy-handover-rent.integration.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { listTenanciesForPeriod } from "../auto-draft.repository";
import { resolveMonthlyRentAmount } from "../post-monthly-rent";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`Refusing non-local DB host: ${host}`);
}

// Dedicated fixture namespace — cleanup is org-scoped and total.
const ORG = "c9200000-0000-4000-8000-000000000001";
const PROP = "c9200000-0000-4000-8000-000000000002";
const APT_1 = "c9200000-0000-4000-8000-000000000003";
const UNIT_1 = "c9200000-0000-4000-8000-000000000004";
const APT_2 = "c9200000-0000-4000-8000-000000000005";
const UNIT_2 = "c9200000-0000-4000-8000-000000000006";
const PARTY_OUT = "c9200000-0000-4000-8000-000000000007";
const PARTY_IN = "c9200000-0000-4000-8000-000000000008";
const TEN_JULY = "c9200000-0000-4000-8000-000000000009";
const TEN_AUGUST = "c9200000-0000-4000-8000-00000000000a";
const TEN_FIRST_HALF = "c9200000-0000-4000-8000-00000000000b";
const TEN_SECOND_HALF = "c9200000-0000-4000-8000-00000000000c";

const JULY = new Date("2026-07-01T00:00:00.000Z");
const AUGUST = new Date("2026-08-01T00:00:00.000Z");
const RENT = "2200.00";

async function cleanup() {
  const db = getDb();
  await db.tenancy.deleteMany({ where: { organizationId: ORG } });
  await db.listing.deleteMany({ where: { organizationId: ORG } });
  await db.apartment.deleteMany({ where: { organizationId: ORG } });
  await db.property.deleteMany({ where: { organizationId: ORG } });
  await db.party.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function seed() {
  const db = getDb();
  await db.organization.create({ data: { id: ORG, name: "PAT", slug: "pat-period-aware", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" } });
  await db.property.create({ data: { id: PROP, organizationId: ORG, name: "P", propertyCode: "P-PAT", propertyType: "residential", addressLine1: "1", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
  await db.party.create({ data: { id: PARTY_OUT, organizationId: ORG, displayName: "Outgoing Tenant", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: PARTY_IN, organizationId: ORG, displayName: "Incoming Tenant", partyType: "individual", status: "active" } });

  // (a) Replacement — mirrors A-03-03 exactly.
  await db.apartment.create({ data: { id: APT_1, organizationId: ORG, propertyId: PROP, unitCode: "A-03-03", listingMode: "WHOLE" } });
  await db.listing.create({ data: { id: UNIT_1, organizationId: ORG, apartmentId: APT_1, listingType: "Studio", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR" } });
  await db.tenancy.create({ data: { id: TEN_JULY, organizationId: ORG, propertyId: PROP, unitId: UNIT_1, tenantPartyId: PARTY_OUT, tenancyCode: "PAT-JUL", status: "ended", billingStatus: "active", startDate: JULY, endDate: new Date("2026-07-31T16:55:43.898Z"), monthlyRentAmount: RENT } });
  await db.tenancy.create({ data: { id: TEN_AUGUST, organizationId: ORG, propertyId: PROP, unitId: UNIT_1, tenantPartyId: PARTY_IN, tenancyCode: "PAT-AUG", status: "active", billingStatus: "active", startDate: AUGUST, endDate: new Date("2027-08-31T00:00:00.000Z"), monthlyRentAmount: RENT } });

  // (b) Mid-month handover.
  await db.apartment.create({ data: { id: APT_2, organizationId: ORG, propertyId: PROP, unitCode: "A-03-04", listingMode: "WHOLE" } });
  await db.listing.create({ data: { id: UNIT_2, organizationId: ORG, apartmentId: APT_2, listingType: "Studio", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR" } });
  await db.tenancy.create({ data: { id: TEN_FIRST_HALF, organizationId: ORG, propertyId: PROP, unitId: UNIT_2, tenantPartyId: PARTY_OUT, tenancyCode: "PAT-H1", status: "terminated", billingStatus: "active", startDate: JULY, endDate: new Date("2026-07-14T00:00:00.000Z"), monthlyRentAmount: RENT } });
  await db.tenancy.create({ data: { id: TEN_SECOND_HALF, organizationId: ORG, propertyId: PROP, unitId: UNIT_2, tenantPartyId: PARTY_IN, tenancyCode: "PAT-H2", status: "active", billingStatus: "active", startDate: new Date("2026-07-15T00:00:00.000Z"), endDate: new Date("2027-07-14T00:00:00.000Z"), monthlyRentAmount: RENT } });
}

dn("period-aware tenancy selection (real DB)", () => {
  beforeEach(async () => { await cleanup(); await seed(); });
  afterEach(cleanup);

  it("bills July's real occupant, not the tenancy that starts in August", async () => {
    const db = getDb();
    const july = (await listTenanciesForPeriod(ORG, JULY)).filter((t) => t.unitId === UNIT_1);

    expect(july.map((t) => t.id)).toEqual([TEN_JULY]);
    // The amount that used to be lost entirely.
    expect(await resolveMonthlyRentAmount(db as never, ORG, TEN_JULY, JULY)).toBe("2200.00");
  });

  it("does not draft the August tenancy into July at RM0.00", async () => {
    const db = getDb();
    const july = (await listTenanciesForPeriod(ORG, JULY)).filter((t) => t.unitId === UNIT_1);

    expect(july.map((t) => t.id)).not.toContain(TEN_AUGUST);
    // Proof this is the RM0.00 the operator saw: had it been selected, this is what
    // the cron would have written as the rent charge's amount.
    expect(await resolveMonthlyRentAmount(db as never, ORG, TEN_AUGUST, JULY)).toBe("0.00");
  });

  it("still bills the August tenancy in August", async () => {
    const august = (await listTenanciesForPeriod(ORG, AUGUST)).filter((t) => t.unitId === UNIT_1);
    expect(august.map((t) => t.id)).toEqual([TEN_AUGUST]);
  });

  it("bills BOTH sides of a mid-month handover, summing to one month's rent", async () => {
    const db = getDb();
    const july = (await listTenanciesForPeriod(ORG, JULY)).filter((t) => t.unitId === UNIT_2);

    expect(july.map((t) => t.id).sort()).toEqual([TEN_FIRST_HALF, TEN_SECOND_HALF].sort());

    const first = await resolveMonthlyRentAmount(db as never, ORG, TEN_FIRST_HALF, JULY);
    const second = await resolveMonthlyRentAmount(db as never, ORG, TEN_SECOND_HALF, JULY);
    expect(first).toBe("993.55");   // 14/31 x 2200
    expect(second).toBe("1206.45"); // 17/31 x 2200
    // The whole month is billed exactly once — no gap, no double-charge.
    expect((Number(first) + Number(second)).toFixed(2)).toBe("2200.00");
  });
});
