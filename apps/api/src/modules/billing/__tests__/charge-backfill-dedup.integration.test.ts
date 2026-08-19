/**
 * Integration proof for two final-review fixes on top of the Spec2 R1
 * duplicate-charge guard, both hitting a real LOCAL Postgres (the mocked unit
 * tests cannot exercise NULL-comparison semantics or numeric(12,2) rounding on
 * write):
 *
 *   Finding 1 — billingMonth backfill. The OLD create path (pre-branch) set
 *   categoryId but left billingMonth NULL. The dedup check-first keys on
 *   billingMonth (exact match) and the partial unique index has no
 *   NULLS NOT DISTINCT, so a pre-existing NULL-billingMonth row is INVISIBLE to
 *   both guards -> re-creating the identical charge silently double-charges.
 *   The backfill (migration 20260706130000) sets billingMonth to the UTC
 *   first-of-month of dueDate, matching createChargeService's
 *   firstOfMonthUtc(dueDate.slice(0,7)).
 *
 *   Finding 2 — dedup amount rounding. findActiveDuplicateCharge now rounds its
 *   query amount via Prisma.Decimal half-up (payment-guard parity), so a charge
 *   whose amount was stored from a 3dp value (100.005 -> stored 100.01) is still
 *   found when the guard is queried with the original raw 100.005.
 *
 * Skipped by default in `vitest run`. Run explicitly:
 *   RUN_INTEGRATION=1 DATABASE_URL=<local> <repo>/node_modules/.bin/vitest run \
 *     src/modules/billing/__tests__/charge-backfill-dedup.integration.test.ts
 *
 * Mirrors charge-dedup.integration.test.ts's harness (fixed-UUID seed + a
 * hard-guard refusing any non-local DB host + org-scoped FK-safe cleanup);
 * disjoint UUID prefix ("cb") so it never races that suite's fixtures.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getDb, Prisma } from "@kason/db";
import { findActiveDuplicateCharge } from "../billing.repository";
import { firstOfMonthUtc } from "../auto-draft.repository";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

// Hard safety: integration runs must only ever hit a local postgres.
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

// Fixed UUIDs — disjoint prefix ("cb") from every other integration test's constants.
const ORG = "cb000000-0000-4000-8000-0000000000a1";
const PARTY = "cb000000-0000-4000-8000-0000000000a2";
const PROPERTY = "cb000000-0000-4000-8000-0000000000a3";
const APARTMENT = "cb000000-0000-4000-8000-0000000000a4";
const UNIT = "cb000000-0000-4000-8000-0000000000a5";
const SERIES = "cb000000-0000-4000-8000-0000000000a6";
const CATEGORY = "cb000000-0000-4000-8000-0000000000a7";

// createChargeService stores dueDate as `new Date(input.dueDate)` and derives
// billingMonth as `firstOfMonthUtc(input.dueDate.slice(0,7))`. Use a MID-month
// dueDate so first-of-month is a DIFFERENT day than dueDate — proving the
// backfill truncates to the 1st (date_trunc('month', ...)), not just copies
// dueDate.
const DUE_DATE_STR = "2026-07-15";
const EXPECTED_BM = firstOfMonthUtc(DUE_DATE_STR.slice(0, 7)); // 2026-07-01 UTC

async function seed() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG,
      name: "Backfill Int Org",
      slug: "backfill-int-org",
      status: "active",
      defaultCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur",
      locale: "en-MY",
      subscriptionPlan: "free",
    },
  });
  await db.party.create({
    data: { id: PARTY, organizationId: ORG, displayName: "Backfill Tenant", partyType: "individual", status: "active" },
  });
  await db.property.create({
    data: {
      id: PROPERTY,
      organizationId: ORG,
      name: "Backfill Property",
      propertyCode: "BACKFILL-P1",
      propertyType: "apartment",
      addressLine1: "1 Test St",
      city: "KL",
      country: "MY",
      status: "active",
      publishStatus: "draft",
    },
  });
  await db.apartment.create({
    data: { id: APARTMENT, organizationId: ORG, propertyId: PROPERTY, unitCode: "B-1", listingMode: "PARTITIONED" },
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
    data: { id: SERIES, organizationId: ORG, code: "BFILL", prefix: "BFL", padding: 4, includeYear: false, active: true },
  });
  await db.chargeCategory.create({
    data: {
      id: CATEGORY,
      organizationId: ORG,
      code: "backfill_test",
      name: "Backfill Test Category",
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

/**
 * Byte-identical billingMonth derivation to migration
 * 20260706130000_backfill_active_charge_billing_month
 * (`date_trunc('month', "dueDate")::date`). Scoped to the test org (extra
 * `organizationId = ...` predicate) for test hygiene ONLY — so the test never
 * touches non-test rows; the derivation under proof is unchanged.
 */
async function runBackfillForOrg(orgId: string): Promise<number> {
  const db = getDb();
  return db.$executeRaw`
    UPDATE "Charge"
    SET "billingMonth" = date_trunc('month', "dueDate")::date
    WHERE "billingMonth" IS NULL
      AND "status" NOT IN ('void', 'credited')
      AND "categoryId" IS NOT NULL
      AND "organizationId" = ${orgId}::uuid`;
}

dn("Charge billingMonth backfill + dedup amount rounding (integration, final-review)", () => {
  beforeEach(async () => {
    await cleanup();
    await seed();
  });

  afterAll(async () => {
    await cleanup();
  });

  it("Finding 1: a pre-existing active categorized charge with billingMonth NULL is INVISIBLE to the dedup check-first; the backfill sets the correct UTC first-of-month and makes it visible", async () => {
    const db = getDb();
    const charge = await db.charge.create({
      data: {
        organizationId: ORG,
        chargeNumber: "CB-BACKFILL-1",
        unitId: UNIT,
        categoryId: CATEGORY,
        partyId: PARTY,
        chargeType: "rent",
        status: "posted",
        description: "pre-existing NULL-billingMonth charge (OLD create path)",
        dueDate: new Date(DUE_DATE_STR), // stored exactly as createChargeService stores it
        amount: "100.00",
        currency: "MYR",
        outstandingAmount: "100.00",
        billingMonth: null, // the OLD create path left this NULL
        attachmentKeys: [],
      },
    });

    // Sanity: it really is stored NULL.
    const before = await db.charge.findUnique({ where: { id: charge.id }, select: { billingMonth: true } });
    expect(before?.billingMonth).toBeNull();

    // THE BUG: the dedup check-first (keys on billingMonth) MISSES the NULL row —
    // `NULL = <date>` is never true, so a re-create of the identical charge would
    // slip past the check-first (and the partial index treats NULL as distinct).
    const missed = await findActiveDuplicateCharge(db, ORG, {
      unitId: UNIT,
      categoryId: CATEGORY,
      billingMonth: EXPECTED_BM,
      amount: 100,
    });
    expect(missed).toBeNull();

    // THE FIX: run the backfill (same derivation as migration 20260706130000).
    const updated = await runBackfillForOrg(ORG);
    expect(updated).toBe(1);

    // billingMonth is now the correct UTC first-of-month of dueDate (the 1st, not the 15th).
    const after = await db.charge.findUnique({ where: { id: charge.id }, select: { billingMonth: true } });
    expect(after?.billingMonth?.toISOString()).toBe(EXPECTED_BM.toISOString());

    // ...and the dedup check-first now FINDS it — the guard is no longer blind.
    const found = await findActiveDuplicateCharge(db, ORG, {
      unitId: UNIT,
      categoryId: CATEGORY,
      billingMonth: EXPECTED_BM,
      amount: 100,
    });
    expect(found?.id).toBe(charge.id);
  });

  it("Finding 2: a charge whose amount was stored from a 3-decimal value (100.005 -> numeric(12,2) 100.01) IS found by the dedup check-first queried with the raw 100.005 (Prisma.Decimal half-up parity)", async () => {
    const db = getDb();
    // Persist the amount the way production does: a raw JS number handed to
    // Prisma for a Decimal column. Postgres's own numeric(12,2) rounding on
    // write is what turns 100.005 into the stored 100.01.
    const charge = await db.charge.create({
      data: {
        organizationId: ORG,
        chargeNumber: "CB-ROUND-1",
        unitId: UNIT,
        categoryId: CATEGORY,
        partyId: PARTY,
        chargeType: "rent",
        status: "posted",
        description: "3dp amount charge",
        dueDate: new Date(DUE_DATE_STR),
        amount: 100.005,
        currency: "MYR",
        outstandingAmount: 100.005,
        billingMonth: EXPECTED_BM,
        attachmentKeys: [],
      },
      select: { id: true, amount: true },
    });

    // Confirm the stored amount really is the rounded 2dp value (proves Postgres
    // did the half-up rounding on write, not the JS layer).
    expect(charge.amount.toString()).toBe("100.01");

    // The check-first, queried with the RAW 3dp amount, must still match the
    // stored 100.01 — the fix rounds the query amount via Prisma.Decimal half-up.
    const found = await findActiveDuplicateCharge(db, ORG, {
      unitId: UNIT,
      categoryId: CATEGORY,
      billingMonth: EXPECTED_BM,
      amount: 100.005,
    });
    expect(found?.id).toBe(charge.id);

    // Guard against a false-positive: a genuinely different amount (200.00) does
    // NOT match — the rounding fix did not make the check indiscriminate.
    const none = await findActiveDuplicateCharge(db, ORG, {
      unitId: UNIT,
      categoryId: CATEGORY,
      billingMonth: EXPECTED_BM,
      amount: 200,
    });
    expect(none).toBeNull();
  });
});
