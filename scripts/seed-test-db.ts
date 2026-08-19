/**
 * Minimal seed for the INTEGRATION TEST database (kaenproperties_test).
 *
 * WHY. Integration suites used to run against the dev database. Nine bills-grid suites
 * adopt whatever `organization.findFirstOrThrow()` returns and then tear down against it,
 * so a single `RUN_INTEGRATION=1` run could delete a real unit's grid entry, its expenses,
 * its bearer config and the org's seeded categories/series — and did, on 2026-07-28.
 *
 * Scoping each teardown helps, but the durable fix is that the tests never point at the
 * dev database at all. The adopters still need SOMETHING to adopt though, so this seeds
 * one disposable org they are free to mangle.
 *
 * Deliberately minimal: one org, one operator, one property, one apartment, plus the
 * standard categories/series. Suites create whatever else they need.
 *
 * Usage (from the repo root):
 *   set -a; . ./.env; set +a
 *   DATABASE_URL="$TEST_DATABASE_URL" npx tsx scripts/seed-test-db.ts
 *
 * Idempotent — safe to re-run. To start clean instead:
 *   dropdb kaenproperties_test && createdb kaenproperties_test
 *   cd packages/db && DATABASE_URL="$TEST_DATABASE_URL" npx prisma migrate deploy
 */
import { getDb } from "@kason/db";
import { ensureChargeCategorySeeds } from "../apps/api/src/modules/charge-categories/seed";

async function main() {
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error(`Refusing non-local host: ${url.hostname}`);
  }
  if (!url.pathname.includes("test")) {
    throw new Error(`Refusing a database whose name does not contain "test": ${url.pathname}`);
  }

  const db = getDb();
  const ORG = "7e570000-0000-4000-8000-000000000001";
  const USER = "7e570000-0000-4000-8000-000000000002";
  const PROP = "7e570000-0000-4000-8000-000000000003";
  const APT = "7e570000-0000-4000-8000-000000000004";

  await db.organization.upsert({
    where: { id: ORG },
    update: {},
    create: {
      id: ORG, name: "Test Fixture Org", slug: "test-fixture-org", status: "active",
      defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free",
    },
  });
  await db.user.upsert({
    where: { id: USER },
    update: {},
    create: {
      id: USER, organizationId: ORG, email: "test-fixture@example.test", fullName: "Test Operator",
      status: "active", role: "manager", userType: "operator",
    },
  });
  await db.property.upsert({
    where: { id: PROP },
    update: {},
    create: {
      id: PROP, organizationId: ORG, name: "Test Property", propertyCode: "P-TEST",
      propertyType: "residential", addressLine1: "1", city: "KL", country: "MY",
      status: "active", publishStatus: "draft",
    },
  });
  await db.apartment.upsert({
    where: { id: APT },
    update: {},
    create: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "T-01", listingMode: "WHOLE" },
  });
  await ensureChargeCategorySeeds(ORG);

  console.log(
    `seeded ${url.pathname.slice(1)}: org=${await db.organization.count()} user=${await db.user.count()} ` +
    `property=${await db.property.count()} apartment=${await db.apartment.count()} ` +
    `categories=${await db.chargeCategory.count()} series=${await db.documentSeries.count()}`,
  );
  await db.$disconnect();
}

main();
