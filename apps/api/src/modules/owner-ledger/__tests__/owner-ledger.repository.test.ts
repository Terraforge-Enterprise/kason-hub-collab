/**
 * Integration tests for owner-ledger.repository.ts.
 *
 * Requires a real local Postgres with all Phase-2 migrations applied (including
 * the OwnerLedgerEntry table from Task 2).
 *
 * Skipped by default in `npx vitest run`. Run explicitly:
 *   RUN_INTEGRATION=1 DATABASE_URL="postgresql://yonghongtan@localhost:5432/kason_hub_dev" \
 *     npx vitest run apps/api/src/modules/owner-ledger
 *
 * Setup: creates a minimal org to scope all rows; wipes entries before every
 * test for clean-slate isolation; removes the org in afterAll.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { getDb } from "@kason/db";
import {
  createEntry,
  getEntry,
  listEntries,
  voidEntry,
  listForPeriod,
} from "../owner-ledger.repository";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

// ─── Stable test fixture UUIDs ────────────────────────────────────────────────

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const OWNER = "aaaaaaaa-0000-4000-8000-000000000002";
const PROPERTY = "aaaaaaaa-0000-4000-8000-000000000003";
const ACTOR_USER = "aaaaaaaa-0000-4000-8000-000000000004";

// ─── Minimal org seed ─────────────────────────────────────────────────────────

async function ensureOrg() {
  const db = getDb();
  await db.organization.upsert({
    where: { id: ORG },
    create: {
      id: ORG,
      name: "Ledger Test Org",
      slug: `ledger-test-${ORG.slice(0, 8)}`,
      status: "active",
      defaultCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur",
      locale: "en-MY",
      subscriptionPlan: "free",
    },
    update: {},
  });
}

async function cleanOrg() {
  const db = getDb();
  await db.ownerLedgerEntry.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function wipeEntries() {
  await getDb().ownerLedgerEntry.deleteMany({ where: { organizationId: ORG } });
}

// ─── Factory helpers ──────────────────────────────────────────────────────────

function baseEntryData(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: ORG,
    ownerPartyId: OWNER,
    propertyId: PROPERTY,
    statementMonth: new Date(Date.UTC(2026, 5, 1)), // 2026-06-01
    transactionDate: new Date(Date.UTC(2026, 5, 15)),
    direction: "income",
    category: "rental",
    amount: "1200.00",
    sstAmount: null,
    paidBy: "kaen",
    paymentStatus: "paid",
    taxCategory: "check_with_tax_agent",
    includeInPayout: true,
    status: "active",
    createdById: ACTOR_USER,
    updatedById: ACTOR_USER,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

dn("owner-ledger.repository — integration", () => {
  beforeAll(async () => {
    await cleanOrg();
    await ensureOrg();
  });

  afterAll(async () => {
    await cleanOrg();
  });

  // Clean-slate before every test regardless of prior test outcome.
  beforeEach(async () => {
    await wipeEntries();
  });

  it("(a) listForPeriod returns only active rows mapped to OwnerLedgerLine shape", async () => {
    const db = getDb();

    // Insert one active row and one void row in the same month.
    await db.$transaction(async (tx) => {
      await createEntry(tx, baseEntryData({ direction: "income", amount: "1500.00" }));
      await createEntry(
        tx,
        baseEntryData({ direction: "expense", amount: "200.00", status: "void", includeInPayout: false }),
      );
    });

    const lines = await listForPeriod(ORG, {
      ownerPartyId: OWNER,
      fromMonth: "2026-06",
      toMonth: "2026-06",
    });

    // Only the active row should appear.
    expect(lines).toHaveLength(1);
    const line = lines[0]!;

    // Shape must match OwnerLedgerLine exactly.
    expect(line.direction).toBe("income");
    expect(line.category).toBe("rental");
    // Prisma Decimal.toString() may strip trailing zeros ("1500" not "1500.00").
    expect(parseFloat(line.amount)).toBeCloseTo(1500, 2);
    expect(line.sstAmount).toBeNull();
    expect(line.includeInPayout).toBe(true);
    expect(line.taxCategory).toBe("check_with_tax_agent");
    // No extra fields beyond the OwnerLedgerLine shape.
    // [phase2] reversalOfEntryId added by rowToLedgerLine (Task 3) — null on this
    // pre-existing (non-reversal) row.
    expect(line.reversalOfEntryId).toBeNull();
    expect(Object.keys(line).sort()).toEqual(
      ["amount", "category", "direction", "includeInPayout", "reversalOfEntryId", "sstAmount", "taxCategory"].sort(),
    );
  });

  it("(c) voidEntry with current token sets status to void", async () => {
    const db = getDb();

    const entry = await db.$transaction((tx) =>
      createEntry(tx, baseEntryData({ direction: "income", amount: "900.00" })),
    );

    const count = await db.$transaction((tx) =>
      voidEntry(tx, ORG, entry.id, entry.updatedAt.toISOString(), ACTOR_USER),
    );
    expect(count).toBe(1);

    const row = await getEntry(ORG, entry.id);
    expect(row?.status).toBe("void");
  });

  it("(d) listEntries paginates and counts correctly, includes void rows", async () => {
    const db = getDb();

    await db.$transaction(async (tx) => {
      await createEntry(tx, baseEntryData({ direction: "income", amount: "1000.00", status: "active" }));
      await createEntry(tx, baseEntryData({ direction: "expense", amount: "50.00", status: "void" }));
    });

    const { rows, total } = await listEntries(
      ORG,
      { ownerPartyId: OWNER },
      { limit: 10, offset: 0 },
    );

    // Both active and void rows appear in admin list.
    expect(total).toBe(2);
    expect(rows).toHaveLength(2);

    const statuses = rows.map((r) => r.status).sort();
    expect(statuses).toEqual(["active", "void"]);
  });

  it("(e) listForPeriod respects month range boundary — row outside range excluded", async () => {
    const db = getDb();

    await db.$transaction(async (tx) => {
      // Row IN range: 2026-06
      await createEntry(
        tx,
        baseEntryData({ statementMonth: new Date(Date.UTC(2026, 5, 1)), amount: "800.00" }),
      );
      // Row OUT of range: 2026-07
      await createEntry(
        tx,
        baseEntryData({ statementMonth: new Date(Date.UTC(2026, 6, 1)), amount: "900.00" }),
      );
    });

    const lines = await listForPeriod(ORG, { fromMonth: "2026-06", toMonth: "2026-06" });
    expect(lines).toHaveLength(1);
    expect(parseFloat(lines[0]!.amount)).toBeCloseTo(800, 2);
  });

  it("(f) listForPeriod maps sstAmount correctly when present", async () => {
    const db = getDb();

    await db.$transaction((tx) =>
      createEntry(
        tx,
        baseEntryData({ direction: "expense", amount: "100.00", sstAmount: "6.00" }),
      ),
    );

    const lines = await listForPeriod(ORG, { fromMonth: "2026-06", toMonth: "2026-06" });
    expect(lines).toHaveLength(1);
    // Prisma Decimal.toString() may strip trailing zeros ("6" not "6.00").
    expect(parseFloat(lines[0]!.sstAmount!)).toBeCloseTo(6, 2);
  });
});
