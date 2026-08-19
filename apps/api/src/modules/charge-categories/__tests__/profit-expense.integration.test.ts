/**
 * Task 3 — API persist + surface ChargeCategory.profitExpense (integration).
 *
 * Categories are lazy-seeded (0 rows by default) — this suite creates its own
 * DocumentSeries + ChargeCategory fixture directly via the real service layer
 * (createChargeCategoryService), same as apps/api/src/modules/charge-categories/
 * __tests__/service.test.ts uses, but against the REAL local Postgres rather
 * than a mocked repository.
 *
 * Convention: RUN_INTEGRATION=1 gate + non-local host guard (bills-grid/
 * utility-billing-config precedent) — vitest.config.ts aliases @kason/db to a
 * mock unless RUN_INTEGRATION=1, so this suite is a no-op describe.skip
 * without it.
 *
 * Run:
 *   export DATABASE_URL=$(grep -o 'DATABASE_URL="[^"]*"' .env | sed 's/DATABASE_URL="//;s/"$//') \
 *   && RUN_INTEGRATION=1 npm run test -w @kason/api -- profit-expense.integration
 */
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { createChargeCategoryService, updateChargeCategoryService } from "../service";
import type { ChargeCategoryActorCtx } from "../service";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

const ORG = "c3000000-0000-4000-8000-0000000000f3";
const USER = "c3000000-0000-4000-8000-0000000000f4";
const CTX: ChargeCategoryActorCtx = { orgId: ORG, actorUserId: USER, actorRole: "admin" };

async function cleanup() {
  const db = getDb();
  await db.chargeCategory.deleteMany({ where: { organizationId: ORG } });
  await db.documentSeries.deleteMany({ where: { organizationId: ORG } });
  await db.auditLog.deleteMany({ where: { organizationId: ORG } });
  await db.user.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function seed() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG,
      name: "ProfitExpenseOrg",
      slug: "profitexpenseorg",
      status: "active",
      defaultCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur",
      locale: "en-MY",
      subscriptionPlan: "free",
    },
  });
  // AuditLog.actorUserId FK → User.id (onDelete: Restrict): acting user must exist.
  await db.user.create({
    data: {
      id: USER,
      organizationId: ORG,
      email: "profitexpenseorg@example.test",
      fullName: "Profit Expense Operator",
      status: "active",
      role: "admin",
      userType: "operator",
    },
  });
  const series = await db.documentSeries.create({
    data: { organizationId: ORG, code: "DEP", prefix: "DEP" },
  });
  return series;
}

dn("ChargeCategory.profitExpense (integration)", () => {
  let seriesId = "";

  beforeEach(async () => {
    await cleanup();
    const series = await seed();
    seriesId = series.id;
  });

  it("PATCH profitExpense round-trips into the DTO, and can be cleared back to null", async () => {
    const created = await createChargeCategoryService(CTX, {
      code: "misc_fee",
      name: "Misc fee",
      family: "tenant_income",
      docType: "invoice",
      seriesId,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.data.profitExpense).toBeNull(); // not set at create time

    const patched = await updateChargeCategoryService(CTX, created.data.id, {
      profitExpense: "expense",
      expectedUpdatedAt: created.data.updatedAt,
    });
    expect(patched.ok).toBe(true);
    if (!patched.ok) return;
    expect(patched.data.profitExpense).toBe("expense");

    // Clear it back to null (nullable boundary) — round-trips via a fresh guarded update.
    const cleared = await updateChargeCategoryService(CTX, created.data.id, {
      profitExpense: null,
      expectedUpdatedAt: patched.data.updatedAt,
    });
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect(cleared.data.profitExpense).toBeNull();
  });

  it("stale expectedUpdatedAt still 409s (STALE_UPDATE) when profitExpense is in the payload", async () => {
    const created = await createChargeCategoryService(CTX, {
      code: "misc_fee2",
      name: "Misc fee 2",
      family: "tenant_income",
      docType: "invoice",
      seriesId,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const stale = await updateChargeCategoryService(CTX, created.data.id, {
      profitExpense: "profit",
      expectedUpdatedAt: "2020-01-01T00:00:00.000Z",
    });
    expect(stale).toMatchObject({ ok: false, status: 409, error: { code: "STALE_UPDATE" } });

    // Guard must not have applied the write despite the field being new.
    const db = getDb();
    const row = await db.chargeCategory.findFirstOrThrow({ where: { id: created.data.id } });
    expect(row.profitExpense).toBeNull();
  });
});
