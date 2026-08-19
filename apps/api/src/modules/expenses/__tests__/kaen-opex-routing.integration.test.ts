/**
 * P6 (accounting-document redesign) — real-Postgres proof for the claims a mocked
 * Prisma unit test (expenses.service.test.ts) can't actually verify:
 *   (1) end-to-end row creation with the REAL schema (types, FKs, defaults),
 *   (2) the `@@unique([organizationId, sourceExpenseAllocationId])` index truly
 *       dedupes a re-attempted opex insert for the same source allocation
 *       (skipDuplicates against a REAL unique constraint, not a mock),
 *   (3) a chargeCategoryId that only resolves in ANOTHER org never leaks that
 *       org's category name (the mocked suite can only assert the query SHAPE;
 *       only a real DB proves the WHERE clause actually excludes it),
 *   (4) same-tx atomicity — a failure AFTER the opex insert (recordAudit) rolls
 *       the opex row back too, proving it isn't a side-channel write outside the
 *       SupplierExpense transaction.
 *
 * Same harness convention as owner-ledger.sync.owner-borne-deduct.integration.test.ts:
 * fixed-UUID seed + org-scoped deleteMany cleanup in FK-safe order (children before
 * parents — KaenOperatingExpense.sourceExpenseAllocation is ON DELETE RESTRICT, so it
 * MUST be deleted before its SupplierExpenseAllocation parent), RUN_INTEGRATION=1 +
 * non-local-host guard.
 *
 * Run: from apps/api
 *   set -a; . ../../.env; set +a; RUN_INTEGRATION=1 npx vitest run \
 *     src/modules/expenses/__tests__/kaen-opex-routing.integration.test.ts
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@kason/db";
import { ensureChargeCategorySeeds } from "../../charge-categories/seed";
import type { ExpenseActorCtx } from "../expenses.service";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

// Partial-mock recordAudit so ONE test can force a downstream failure (to prove
// same-tx rollback) while every other test in this file uses the REAL implementation
// (a real AuditLog row, real FK to User). Toggled via `auditShouldThrow` per test.
let auditShouldThrow = false;
vi.mock("../../../lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/audit")>();
  return {
    recordAudit: async (...args: Parameters<typeof actual.recordAudit>) => {
      if (auditShouldThrow) throw new Error("simulated downstream failure (rollback proof)");
      return actual.recordAudit(...args);
    },
  };
});

// Must import AFTER the vi.mock("../../../lib/audit", ...) above so this module's
// `import { recordAudit } from "../../lib/audit"` binds to the mocked version.
const { createSupplierExpenseService } = await import("../expenses.service");

const ORG_A = "6f000000-0000-4000-8000-0000000000a1";
const USER_A = "6f000000-0000-4000-8000-0000000000a2";
const PARTY_A = "6f000000-0000-4000-8000-0000000000a3";
const ORG_B = "6f000000-0000-4000-8000-0000000000b1"; // cross-org isolation fixture only
const USER_B = "6f000000-0000-4000-8000-0000000000b2";
const PARTY_B = "6f000000-0000-4000-8000-0000000000b3";

const ctx: ExpenseActorCtx = { orgId: ORG_A, actorUserId: USER_A, actorRole: "editor", ip: "127.0.0.1", userAgent: "vitest" };

async function cleanup() {
  const db = getDb();
  for (const organizationId of [ORG_A, ORG_B]) {
    const org = { organizationId };
    await db.kaenOperatingExpense.deleteMany({ where: org }); // RESTRICT FK — before allocations
    await db.supplierExpenseAllocation.deleteMany({ where: org });
    await db.supplierExpense.deleteMany({ where: org });
    await db.auditLog.deleteMany({ where: org });
    await db.chargeCategory.deleteMany({ where: org });
    await db.documentSeries.deleteMany({ where: org });
    await db.referenceSequence.deleteMany({ where: org });
  }
  await db.user.deleteMany({ where: { id: { in: [USER_A, USER_B] } } });
  await db.party.deleteMany({ where: { id: { in: [PARTY_A, PARTY_B] } } });
  await db.organization.deleteMany({ where: { id: { in: [ORG_A, ORG_B] } } });
}

async function seed() {
  const db = getDb();
  await db.organization.create({
    data: { id: ORG_A, name: "P6 Opex Org A", slug: "p6-opex-org-a", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" },
  });
  await db.party.create({ data: { id: PARTY_A, organizationId: ORG_A, displayName: "P6 Opex Operator A", partyType: "individual", status: "active" } });
  await db.user.create({ data: { id: USER_A, organizationId: ORG_A, email: "p6-opex-operator-a@example.com", fullName: "P6 Opex Operator A", status: "active", role: "admin", userType: "operator", partyId: PARTY_A } });
  await ensureChargeCategorySeeds(ORG_A);

  // Org B exists ONLY to prove cross-org category isolation (a chargeCategoryId that
  // resolves in Org B must never leak into an Org A KaenOperatingExpense row).
  await db.organization.create({
    data: { id: ORG_B, name: "P6 Opex Org B", slug: "p6-opex-org-b", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" },
  });
  await db.party.create({ data: { id: PARTY_B, organizationId: ORG_B, displayName: "P6 Opex Operator B", partyType: "individual", status: "active" } });
  await db.user.create({ data: { id: USER_B, organizationId: ORG_B, email: "p6-opex-operator-b@example.com", fullName: "P6 Opex Operator B", status: "active", role: "admin", userType: "operator", partyId: PARTY_B } });
  await ensureChargeCategorySeeds(ORG_B);
}

dn("createSupplierExpenseService — KAEN opex routing (P6, real Postgres)", () => {
  beforeEach(async () => {
    delete process.env.ENABLE_KAEN_OPEX;
    auditShouldThrow = false;
    await cleanup();
    await seed();
  });
  afterEach(() => {
    auditShouldThrow = false;
  });
  afterAll(async () => {
    delete process.env.ENABLE_KAEN_OPEX;
    await cleanup();
  });

  it("creates a real KaenOperatingExpense row end-to-end when the flag is ON", async () => {
    process.env.ENABLE_KAEN_OPEX = "true";
    const db = getDb();
    const category = await db.chargeCategory.findFirstOrThrow({ where: { organizationId: ORG_A } });

    const { id: expenseId } = await createSupplierExpenseService(ctx, {
      supplierName: "Acme Software Sdn Bhd",
      expenseDate: "2026-07-22",
      totalAmount: "120.00",
      allocations: [{ borneBy: "kaen", amount: "120.00", chargeCategoryId: category.id, description: "SaaS renewal" }],
    });

    const allocation = await db.supplierExpenseAllocation.findFirstOrThrow({ where: { supplierExpenseId: expenseId } });
    const rows = await db.kaenOperatingExpense.findMany({ where: { organizationId: ORG_A } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      organizationId: ORG_A,
      sourceExpenseAllocationId: allocation.id,
      category: category.name,
      description: "SaaS renewal",
      status: "recorded",
      createdById: USER_A,
    });
    expect(rows[0].amount.toString()).toBe("120"); // Decimal.js toString() strips trailing zeros; column is still DECIMAL(12,2)
    expect(rows[0].expenseDate.toISOString().slice(0, 10)).toBe("2026-07-22");
  });

  it("creates nothing when the flag is OFF", async () => {
    delete process.env.ENABLE_KAEN_OPEX;
    const db = getDb();

    await createSupplierExpenseService(ctx, {
      supplierName: "Acme Software Sdn Bhd",
      expenseDate: "2026-07-22",
      totalAmount: "120.00",
      allocations: [{ borneBy: "kaen", amount: "120.00" }],
    });

    expect(await db.kaenOperatingExpense.count({ where: { organizationId: ORG_A } })).toBe(0);
  });

  it("does not duplicate a row when the opex insert is retried for the same source allocation (real @@unique)", async () => {
    process.env.ENABLE_KAEN_OPEX = "true";
    const db = getDb();

    const { id: expenseId } = await createSupplierExpenseService(ctx, {
      supplierName: "Acme Software Sdn Bhd",
      expenseDate: "2026-07-22",
      totalAmount: "75.00",
      allocations: [{ borneBy: "kaen", amount: "75.00" }],
    });
    const allocation = await db.supplierExpenseAllocation.findFirstOrThrow({ where: { supplierExpenseId: expenseId } });
    expect(await db.kaenOperatingExpense.count({ where: { organizationId: ORG_A } })).toBe(1);

    // Simulate a retry of JUST the opex-insert step (a repair script, a re-processed
    // event) for the SAME already-routed allocation — must not throw, must not duplicate.
    await db.kaenOperatingExpense.createMany({
      data: [{
        organizationId: ORG_A,
        sourceExpenseAllocationId: allocation.id,
        category: "other_expense",
        amount: "75.00",
        expenseDate: new Date("2026-07-22T00:00:00.000Z"),
        createdById: USER_A,
      }],
      skipDuplicates: true,
    });

    expect(await db.kaenOperatingExpense.count({ where: { organizationId: ORG_A } })).toBe(1);
  });

  it("never resolves a chargeCategoryId belonging to another organization (falls back to other_expense)", async () => {
    process.env.ENABLE_KAEN_OPEX = "true";
    const db = getDb();
    const orgBCategory = await db.chargeCategory.findFirstOrThrow({ where: { organizationId: ORG_B } });

    // Org A allocation references Org B's category id — a stale/cross-tenant soft
    // reference (chargeCategoryId has no DB FK — see supplier-expense.ts).
    await createSupplierExpenseService(ctx, {
      supplierName: "Acme Software Sdn Bhd",
      expenseDate: "2026-07-22",
      totalAmount: "40.00",
      allocations: [{ borneBy: "kaen", amount: "40.00", chargeCategoryId: orgBCategory.id }],
    });

    const rows = await db.kaenOperatingExpense.findMany({ where: { organizationId: ORG_A } });
    expect(rows).toHaveLength(1);
    expect(rows[0].category).toBe("other_expense");
    expect(rows[0].category).not.toBe(orgBCategory.name);
  });

  it("rolls back the opex row if a later step in the same transaction fails", async () => {
    process.env.ENABLE_KAEN_OPEX = "true";
    auditShouldThrow = true;
    const db = getDb();

    await expect(
      createSupplierExpenseService(ctx, {
        supplierName: "Acme Software Sdn Bhd",
        expenseDate: "2026-07-22",
        totalAmount: "60.00",
        allocations: [{ borneBy: "kaen", amount: "60.00" }],
      }),
    ).rejects.toThrow("simulated downstream failure");

    expect(await db.kaenOperatingExpense.count({ where: { organizationId: ORG_A } })).toBe(0);
    expect(await db.supplierExpenseAllocation.count({ where: { organizationId: ORG_A } })).toBe(0);
    expect(await db.supplierExpense.count({ where: { organizationId: ORG_A } })).toBe(0);
  });
});
