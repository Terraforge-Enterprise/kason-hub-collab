import { describe, it, expect } from "vitest";
import { getDb } from "../src";

// Real local Postgres only — opt in with RUN_INTEGRATION=1, mirroring the
// convention in recurring-charges.migration.test.ts. Without the flag this file
// is skipped, so a plain `turbo run test` stays DB-free; previously it threw
// "DATABASE_URL is not set" and reddened the whole suite for everyone.
// Run: from repo root
//   set -a; . ./.env; set +a; RUN_INTEGRATION=1 npx vitest run packages/db/__tests__/category-classification.migration.test.ts
const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`Refusing non-local DB host: ${host}`);
}

dn("category classification columns", () => {
  it("stores chargeCategoryId on GridExpense and profitExpense on ChargeCategory", async () => {
    const db = getDb();
    const cat = await db.chargeCategory.findFirst({ where: { profitExpense: { not: null } } });
    expect(cat === null || typeof cat.profitExpense === "string").toBe(true);
    // column presence: a raw select must not throw on the new columns
    await db.$queryRaw`SELECT "profitExpense" FROM "ChargeCategory" LIMIT 1`;
    await db.$queryRaw`SELECT "chargeCategoryId" FROM "GridExpense" LIMIT 1`;
  });
});
