/**
 * Bills-grid expenses — `nature` (Expense/Profit) create/update threading (Task B2).
 *
 * Task B1 (prior task, this base) added `GridExpense.nature` and wired the DOWNSTREAM
 * routing (mint / issue-grouped / owner-ledger Source-6) behind ENABLE_CHARGE_NATURE_ROUTING
 * — see gridexpense-nature-routing.integration.test.ts. This suite is the WRITE-layer
 * counterpart: does the create/update SERVICE actually accept and persist an admin's
 * per-row `nature` choice onto the `GridExpense` row? (The web UI's per-row selector,
 * expenses-nature.test.tsx, is the caller of these same wire bodies.)
 *
 * Design note (write layer is flag-AGNOSTIC): unlike the recurring-apply route's
 * fail-closed `NATURE_REQUIRED` 422 (routes.ts), create/update never gate persistence on
 * ENABLE_CHARGE_NATURE_ROUTING — the column is a single source of truth and the flag only
 * gates whether mint/issue-grouped/owner-ledger actually READ it (Task B1's `natureOn ?
 * (e.nature ?? null) : null` at mint time). A `nature` written while the flag is OFF is
 * inert until the flag is later turned on, exactly like every other flag-gated READ in
 * this codebase. The 3rd test below proves the write itself never gates on the flag; the
 * flag's effect on ROUTING is already fully covered by gridexpense-nature-routing's
 * flag-off cases and is NOT re-proven here.
 *
 * Mirrors expense-category.integration.test.ts's harness (shared dev org/property via
 * findFirstOrThrow, one fixture apartment, cleanupGridFixtures teardown) — the closest
 * precedent for "an optional per-item field threaded through create + update".
 *
 * Real local Postgres only.
 * Run:
 *   export DATABASE_URL=$(grep -o 'DATABASE_URL="[^"]*"' .env | sed 's/DATABASE_URL="//;s/"$//') \
 *     && RUN_INTEGRATION=1 npm run test -w @kason/api -- expense-nature-persist.integration
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { createExpensesService, updateExpenseService } from "../service";
import { cleanupGridFixtures } from "./cleanup";

const prisma = getDb();

const RUN = process.env.RUN_INTEGRATION === "1";
const d = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────
let ACTOR = "";
let ORG = "";
let APT = "";
let FIX_APTS: string[] = [];
const PERIOD_STR = "2026-08-01"; // safe to reuse across sibling suites — this file's own fresh apartment makes the (org, apartment, period) tuple unique regardless

const session = (role: "editor" | "manager" | "admin") => ({ orgId: ORG, userId: ACTOR, role });

beforeAll(async () => {
  if (!RUN) return;
  const org = await prisma.organization.findFirstOrThrow();
  ORG = org.id;
  ACTOR = (await prisma.user.findFirstOrThrow({ where: { organizationId: ORG } })).id;
  const prop = await prisma.property.findFirstOrThrow({ where: { organizationId: ORG } });
  APT = (await prisma.apartment.create({
    data: { organizationId: ORG, propertyId: prop.id, unitCode: `NAT-${Date.now()}`, listingMode: "WHOLE" },
  })).id;
  FIX_APTS = [APT];

  await prisma.unitBillsGridEntry.deleteMany({ where: { organizationId: ORG, apartmentId: APT, periodMonth: new Date(`${PERIOD_STR}T00:00:00.000Z`) } });
});

afterEach(() => {
  // Each test opts in explicitly — never inherit a prior test's flag state.
  delete process.env.ENABLE_CHARGE_NATURE_ROUTING;
});

afterAll(async () => {
  if (!RUN) return;
  await cleanupGridFixtures(prisma, ORG, { apartmentIds: [APT].filter(Boolean) });
  if (FIX_APTS.length) await prisma.apartment.deleteMany({ where: { id: { in: FIX_APTS } } });
  await prisma.auditLog.deleteMany({ where: { organizationId: ORG, entityType: { in: ["UnitBillsGridEntry", "GridExpense"] } } });
});

d("bills-grid expenses — nature (Expense/Profit) create/update threading", () => {
  it("create with nature:'profit' persists GridExpense.nature='profit'", async () => {
    const c = await createExpensesService(session("editor"), {
      apartmentId: APT, billingMonth: PERIOD_STR, bearer: "owner",
      items: [{ description: "Consulting fee", amount: "200.00", withSST: false, nature: "profit" }],
    });
    expect(c.ok).toBe(true);
    if (!c.ok) return;

    const row = await prisma.gridExpense.findUniqueOrThrow({ where: { id: c.data.ids[0] } });
    expect(row.nature).toBe("profit");
  });

  it("create with nature omitted persists GridExpense.nature=null (backward-compatible default, Task B1)", async () => {
    const c = await createExpensesService(session("editor"), {
      apartmentId: APT, billingMonth: PERIOD_STR, bearer: "owner",
      items: [{ description: "Plumbing repair", amount: "60.00", withSST: false }],
    });
    expect(c.ok).toBe(true);
    if (!c.ok) return;

    const row = await prisma.gridExpense.findUniqueOrThrow({ where: { id: c.data.ids[0] } });
    expect(row.nature).toBeNull();
  });

  it("create with nature:'profit' while ENABLE_CHARGE_NATURE_ROUTING is OFF still persists nature='profit' (write layer is flag-agnostic; the flag only gates downstream ROUTING, proven in gridexpense-nature-routing.integration.test.ts)", async () => {
    delete process.env.ENABLE_CHARGE_NATURE_ROUTING; // explicit — this is the point of the test
    const c = await createExpensesService(session("editor"), {
      apartmentId: APT, billingMonth: PERIOD_STR, bearer: "owner",
      items: [{ description: "Admin fee", amount: "30.00", withSST: false, nature: "profit" }],
    });
    expect(c.ok).toBe(true);
    if (!c.ok) return;

    const row = await prisma.gridExpense.findUniqueOrThrow({ where: { id: c.data.ids[0] } });
    expect(row.nature).toBe("profit");
  });

  it("multi-item create: each item's own nature is persisted independently on its own row", async () => {
    const c = await createExpensesService(session("editor"), {
      apartmentId: APT, billingMonth: PERIOD_STR, bearer: "owner",
      items: [
        { description: "Profit line", amount: "10.00", withSST: false, nature: "profit" },
        { description: "Expense line", amount: "20.00", withSST: false, nature: "expense" },
        { description: "Legacy line (no nature)", amount: "30.00", withSST: false },
      ],
    });
    expect(c.ok).toBe(true);
    if (!c.ok) return;

    const rows = await prisma.gridExpense.findMany({ where: { id: { in: c.data.ids } }, orderBy: { amount: "asc" } });
    expect(rows.map((r) => r.nature)).toEqual(["profit", "expense", null]);
  });

  it("update with nature:'profit' on an existing (default-null) expense updates GridExpense.nature", async () => {
    const c = await createExpensesService(session("editor"), {
      apartmentId: APT, billingMonth: PERIOD_STR, bearer: "owner",
      items: [{ description: "Renovate", amount: "500.00", withSST: false }],
    });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    const expenseId = c.data.ids[0];
    const before = await prisma.gridExpense.findUniqueOrThrow({ where: { id: expenseId } });
    expect(before.nature).toBeNull();

    const r = await updateExpenseService(session("editor"), expenseId, { nature: "profit" });
    expect(r.ok).toBe(true);

    const after = await prisma.gridExpense.findUniqueOrThrow({ where: { id: expenseId } });
    expect(after.nature).toBe("profit");
  });

  it("update can flip nature back from 'profit' to 'expense' explicitly", async () => {
    const c = await createExpensesService(session("editor"), {
      apartmentId: APT, billingMonth: PERIOD_STR, bearer: "owner",
      items: [{ description: "Repaint", amount: "90.00", withSST: false, nature: "profit" }],
    });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    const expenseId = c.data.ids[0];

    const r = await updateExpenseService(session("editor"), expenseId, { nature: "expense" });
    expect(r.ok).toBe(true);

    const after = await prisma.gridExpense.findUniqueOrThrow({ where: { id: expenseId } });
    expect(after.nature).toBe("expense");
  });

  // Sibling correctness guard, mirrors expense-category.integration.test.ts's B5 —
  // the silent data-loss failure mode of a naive `data: { nature: body.nature }`
  // IF Prisma treated an explicit `undefined` as "set to null" rather than "leave
  // untouched" (it does the latter, matching description/amount/chargeCategoryId's
  // existing optional-field behaviour) — verified here, not assumed.
  it("update omitting nature leaves the existing nature untouched (no silent flip back to Expense)", async () => {
    const c = await createExpensesService(session("editor"), {
      apartmentId: APT, billingMonth: PERIOD_STR, bearer: "owner",
      items: [{ description: "Landscaping", amount: "150.00", withSST: false, nature: "profit" }],
    });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    const expenseId = c.data.ids[0];

    const r = await updateExpenseService(session("editor"), expenseId, { description: "Landscaping (redo)" });
    expect(r.ok).toBe(true);

    const after = await prisma.gridExpense.findUniqueOrThrow({ where: { id: expenseId } });
    expect(after.nature).toBe("profit"); // untouched — description-only update did not clobber it
    expect(after.description).toBe("Landscaping (redo)");
  });
});
