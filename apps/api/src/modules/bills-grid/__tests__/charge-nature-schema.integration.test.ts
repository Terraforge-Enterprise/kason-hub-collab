/**
 * Task 2 (charge Expense/Profit nature routing) — schema proof for the additive,
 * NULLABLE `nature` column on Charge + RecurringChargeRevision (+ the "profit" backfill).
 *
 * A migration isn't naturally TDD-able, so the column's ROUND-TRIP is the observable
 * behavior under test:
 *   - RED   (before the schema change + `migrate deploy`): the Prisma client has no
 *           `nature` field, so create/select reject it → "Unknown argument `nature`"
 *           (and the raw backfill hits "column \"nature\" does not exist"). Every case fails.
 *   - GREEN (after ALTER TABLE + `prisma generate`): `nature` persists and round-trips;
 *           the idempotent backfill (`WHERE nature IS NULL`) flips legacy rows to "profit".
 *
 * Harness convention mirrors the other bills-grid integration suites: RUN_INTEGRATION
 * gate + non-local host guard + getDb(). Self-seeds its own org/party/recurring-def under
 * fixed disjoint UUIDs (prefix d17e) and tears them down.
 *
 * Run (from apps/api):
 *   set -a; . ../../.env; set +a; RUN_INTEGRATION=1 npx vitest run \
 *     src/modules/bills-grid/__tests__/charge-nature-schema.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

const db = getDb();

// Fixed disjoint UUIDs (prefix d17e — unique to this suite).
const ORG = "d17e0000-0000-4000-8000-000000000001";
const PARTY = "d17e0000-0000-4000-8000-000000000002";
const DEF = "d17e0000-0000-4000-8000-000000000003";
const APT = "d17e0000-0000-4000-8000-000000000004"; // RecurringChargeDefinition.apartmentId — plain column, no FK
const ACTOR = "d17e0000-0000-4000-8000-0000000000aa"; // createdBy — plain column, no FK
const MONTH = new Date("2026-07-01T00:00:00.000Z");

async function cleanup() {
  await db.recurringChargeRevision.deleteMany({ where: { definition: { organizationId: ORG } } });
  await db.recurringChargeDefinition.deleteMany({ where: { organizationId: ORG } });
  await db.charge.deleteMany({ where: { organizationId: ORG } });
  await db.party.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function seed() {
  await db.organization.create({
    data: { id: ORG, name: "Charge-Nature Org", slug: "charge-nature-org", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" },
  });
  await db.party.create({
    data: { id: PARTY, organizationId: ORG, displayName: "Nature Party", partyType: "individual", status: "active" },
  });
  await db.recurringChargeDefinition.create({
    data: { id: DEF, organizationId: ORG, apartmentId: APT, kind: "CUSTOM", code: "custom-nature", name: "Nature Def", createdBy: ACTOR },
  });
}

// chargeNumber is unique per (org, chargeNumber) — random suffix so repeat/parallel creates never collide.
async function newCharge(nature?: "expense" | "profit") {
  const suffix = Math.random().toString(36).slice(2, 10);
  return db.charge.create({
    data: {
      organizationId: ORG,
      chargeNumber: `NATURE-${suffix}`,
      partyId: PARTY,
      chargeType: "expense",
      status: "posted",
      dueDate: MONTH,
      amount: "50.00",
      currency: "MYR",
      outstandingAmount: "50.00",
      attachmentKeys: [],
      ...(nature !== undefined ? { nature } : {}),
    },
    select: { id: true, nature: true },
  });
}

dn("Task 2 schema: nature round-trips on Charge + profit backfill on RecurringChargeRevision", () => {
  beforeAll(async () => {
    await cleanup();
    await seed();
  });
  afterAll(cleanup);

  it('a Charge created with nature:"expense" persists and reads back "expense"', async () => {
    const created = await newCharge("expense");
    expect(created.nature).toBe("expense");
    const read = await db.charge.findUniqueOrThrow({ where: { id: created.id }, select: { nature: true } });
    expect(read.nature).toBe("expense");
  });

  it("a Charge created WITHOUT nature reads back NULL (nullable, no crash)", async () => {
    const created = await newCharge();
    expect(created.nature).toBeNull();
    const read = await db.charge.findUniqueOrThrow({ where: { id: created.id }, select: { nature: true } });
    expect(read.nature).toBeNull();
  });

  it('the profit backfill flips a legacy (NULL) RecurringChargeRevision.nature to "profit" and leaves none of this definition\'s NULL', async () => {
    // Seed TWO legacy revisions the way pre-feature rows exist: created WITHOUT nature → NULL.
    const legacyA = await db.recurringChargeRevision.create({
      data: { definitionId: DEF, amount: "100.00", bearer: "owner", effectiveFromMonth: MONTH, createdBy: ACTOR },
      select: { id: true, nature: true },
    });
    const legacyB = await db.recurringChargeRevision.create({
      data: { definitionId: DEF, amount: "200.00", bearer: "tenant", effectiveFromMonth: new Date("2026-08-01T00:00:00.000Z"), createdBy: ACTOR },
      select: { id: true, nature: true },
    });
    // Precondition: legacy rows are NULL (no app default sets nature in this task).
    expect(legacyA.nature).toBeNull();
    expect(legacyB.nature).toBeNull();

    // Run the EXACT backfill statement shipped in the migration (idempotent — WHERE nature IS NULL).
    await db.$executeRawUnsafe(`UPDATE "RecurringChargeRevision" SET "nature" = 'profit' WHERE "nature" IS NULL;`);

    const afterA = await db.recurringChargeRevision.findUniqueOrThrow({ where: { id: legacyA.id }, select: { nature: true } });
    const afterB = await db.recurringChargeRevision.findUniqueOrThrow({ where: { id: legacyB.id }, select: { nature: true } });
    expect(afterA.nature).toBe("profit");
    expect(afterB.nature).toBe("profit");
    // No revision of this definition stays NULL after the backfill. Scoped to DEF (not global)
    // on purpose: the shared dev DB runs suites in parallel workers, and LATER tasks legitimately
    // create revisions with NULL nature — a global count would race. This still proves the backfill
    // targets and clears every NULL row it was meant to (idempotent WHERE nature IS NULL).
    expect(await db.recurringChargeRevision.count({ where: { definitionId: DEF, nature: null } })).toBe(0);
  });
});
