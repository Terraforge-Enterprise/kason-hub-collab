/**
 * Integration tests for the DB-level duplicate-charge backstop (Spec 2 R1):
 * two PARTIAL UNIQUE INDEXes created in migration
 * 20260706120000_charge_duplicate_prevention —
 *   Charge_unit_category_month_amount_active_key
 *     ON "Charge" (unitId, categoryId, billingMonth, amount)
 *     WHERE status NOT IN ('void','credited') AND categoryId IS NOT NULL
 * (the carparkId-keyed sibling index is created by the same migration but is
 * not exercised here — same predicate/shape, just a different FK column).
 *
 * Hits a real LOCAL Postgres. Skipped by default in `vitest run`. Run explicitly:
 *   RUN_INTEGRATION=1 <repo>/node_modules/.bin/vitest run \
 *     src/modules/billing/__tests__/charge-dedup.integration.test.ts
 *
 * Mirrors the auto-draft integration harness (auto-draft.integration.test.ts):
 * fixed-UUID seed + org-scoped deleteMany cleanup in beforeEach/afterAll. This
 * suite asserts the raw DB index directly (no service layer involved — Task 2
 * builds the P2002 → 409 mapping on top of this backstop).
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getDb, Prisma } from "@kason/db";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

// Hard safety: integration runs must only ever hit a local postgres.
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

// Fixed UUIDs — disjoint prefix ("cd") from every other integration test's constants.
const ORG = "cd000000-0000-4000-8000-0000000000a1";
const PARTY = "cd000000-0000-4000-8000-0000000000a2";
const PROPERTY = "cd000000-0000-4000-8000-0000000000a3";
const APARTMENT = "cd000000-0000-4000-8000-0000000000a4";
const UNIT = "cd000000-0000-4000-8000-0000000000a5";
const SERIES = "cd000000-0000-4000-8000-0000000000a6";
const CATEGORY = "cd000000-0000-4000-8000-0000000000a7";

const BILLING_MONTH = new Date("2026-07-01T00:00:00.000Z");

let chargeSeq = 0;
/** Unique per-insert chargeNumber (Charge also carries @@unique([organizationId, chargeNumber])). */
function nextChargeNumber() {
  chargeSeq += 1;
  return `DEDUP-INT-${chargeSeq}`;
}

async function seed() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG,
      name: "Dedup Int Org",
      slug: "dedup-int-org",
      status: "active",
      defaultCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur",
      locale: "en-MY",
      subscriptionPlan: "free",
    },
  });
  await db.party.create({
    data: { id: PARTY, organizationId: ORG, displayName: "Dedup Tenant", partyType: "individual", status: "active" },
  });
  await db.property.create({
    data: {
      id: PROPERTY,
      organizationId: ORG,
      name: "Dedup Property",
      propertyCode: "DEDUP-P1",
      propertyType: "apartment",
      addressLine1: "1 Test St",
      city: "KL",
      country: "MY",
      status: "active",
      publishStatus: "draft",
    },
  });
  await db.apartment.create({
    data: { id: APARTMENT, organizationId: ORG, propertyId: PROPERTY, unitCode: "D-1", listingMode: "PARTITIONED" },
  });
  await db.listing.create({
    data: {
      id: UNIT,
      organizationId: ORG,
      apartmentId: APARTMENT,
      listingType: "room",
      occupancyStatus: "occupied",
      listingStatus: "active",
      currency: "MYR",
    },
  });
  await db.documentSeries.create({
    data: { id: SERIES, organizationId: ORG, code: "DEDUP", prefix: "DED", padding: 4, includeYear: false, active: true },
  });
  await db.chargeCategory.create({
    data: {
      id: CATEGORY,
      organizationId: ORG,
      code: "dedup_test",
      name: "Dedup Test Category",
      family: "tenant_income",
      docType: "invoice",
      seriesId: SERIES,
      defaultSstRate: "0",
      eInvoiceEligible: false,
      isSystem: false,
      active: true,
      sortOrder: 1,
    },
  });
}

/** Delete everything in FK-safe order (children before parents). */
async function cleanup() {
  const db = getDb();
  const orgs = { in: [ORG] };
  await db.charge.deleteMany({ where: { organizationId: orgs } });
  await db.chargeCategory.deleteMany({ where: { organizationId: orgs } });
  await db.documentSeries.deleteMany({ where: { organizationId: orgs } });
  await db.listing.deleteMany({ where: { organizationId: orgs } });
  await db.apartment.deleteMany({ where: { organizationId: orgs } });
  await db.property.deleteMany({ where: { organizationId: orgs } });
  await db.party.deleteMany({ where: { organizationId: orgs } });
  await db.organization.deleteMany({ where: { id: orgs } });
}

function activeChargeData(overrides: Partial<Prisma.ChargeUncheckedCreateInput> = {}) {
  return {
    organizationId: ORG,
    chargeNumber: nextChargeNumber(),
    unitId: UNIT,
    categoryId: CATEGORY,
    partyId: PARTY,
    chargeType: "rent",
    status: "posted",
    description: "Dedup integration charge",
    dueDate: BILLING_MONTH,
    amount: "100.00",
    currency: "MYR",
    outstandingAmount: "100.00",
    billingMonth: BILLING_MONTH,
    attachmentKeys: [],
    ...overrides,
  } satisfies Prisma.ChargeUncheckedCreateInput;
}

dn("Charge duplicate-prevention partial unique indexes (integration, Spec2 R1)", () => {
  beforeEach(async () => {
    await cleanup();
    await seed();
  });

  afterAll(async () => {
    await cleanup();
  });

  it("index rejects a second identical active (unitId,categoryId,billingMonth,amount) charge with Prisma P2002", async () => {
    const db = getDb();
    await db.charge.create({ data: activeChargeData() });

    await expect(
      db.charge.create({ data: activeChargeData({ status: "draft", description: "Duplicate attempt" }) }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("void excluded: a voided charge does not block a fresh identical active insert", async () => {
    const db = getDb();
    const first = await db.charge.create({ data: activeChargeData() });
    await db.charge.update({ where: { id: first.id }, data: { status: "void" } });

    const second = await db.charge.create({ data: activeChargeData() });

    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe("posted");

    // Both rows survive — void never deletes.
    const db2 = getDb();
    const count = await db2.charge.count({
      where: { organizationId: ORG, unitId: UNIT, categoryId: CATEGORY, billingMonth: BILLING_MONTH, amount: "100.00" },
    });
    expect(count).toBe(2);
  });
});
