/**
 * Integration tests for owner-ledger.service.ts.
 *
 * Requires a real local Postgres with all Phase-2 migrations applied (including
 * the OwnerLedgerEntry table from Task 2).
 *
 * Skipped by default in `npx vitest run`. Run explicitly:
 *   RUN_INTEGRATION=1 DATABASE_URL="postgresql://yonghongtan@localhost:5432/kason_hub_dev" \
 *     npx vitest run apps/api/src/modules/owner-ledger/__tests__/owner-ledger.service.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { getDb } from "@kason/db";
import {
  createEntryService,
  getEntryService,
  listEntriesService,
  updateEntryService,
  voidEntryService,
  rowToDto,
} from "../owner-ledger.service";
import type { OwnerLedgerActorCtx, DbOwnerLedgerEntry } from "../owner-ledger.types";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

// ─── Stable test fixture UUIDs ────────────────────────────────────────────────

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const ORG2 = "aaaaaaaa-0000-4000-8000-000000000010";
const OWNER = "aaaaaaaa-0000-4000-8000-000000000002";
const PROPERTY = "aaaaaaaa-0000-4000-8000-000000000003";
const ACTOR_USER = "aaaaaaaa-0000-4000-8000-000000000004";

// ─── Actor contexts ───────────────────────────────────────────────────────────

const actor: OwnerLedgerActorCtx = {
  orgId: ORG,
  actorUserId: ACTOR_USER,
  actorRole: "admin",
  ip: "127.0.0.1",
  userAgent: "vitest",
};

const actor2: OwnerLedgerActorCtx = {
  orgId: ORG2,
  actorUserId: ACTOR_USER,
  actorRole: "admin",
};

// ─── Org setup helpers ────────────────────────────────────────────────────────

// ─── Actor Party + User (needed for AuditLog.actorUserId FK) ─────────────────

const ACTOR_PARTY = "aaaaaaaa-0000-4000-8000-000000000005";

async function ensureOrg(id: string, slug: string) {
  const db = getDb();
  await db.organization.upsert({
    where: { id },
    create: {
      id,
      name: `Ledger Service Test Org ${slug}`,
      slug: `ledger-svc-${slug}`,
      status: "active",
      defaultCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur",
      locale: "en-MY",
      subscriptionPlan: "free",
    },
    update: {},
  });
}

/**
 * Seed the actor Party + User rows required by AuditLog.actorUserId FK.
 * Only seeded under ORG (the primary org); ORG2 shares the same actorUserId
 * but AuditLog only enforces FK on actorUserId → User, not on orgId of User.
 */
async function ensureActorUser() {
  const db = getDb();
  await db.party.upsert({
    where: { id: ACTOR_PARTY },
    create: {
      id: ACTOR_PARTY,
      organizationId: ORG,
      displayName: "Ledger Service Test Actor",
      partyType: "individual",
      status: "active",
    },
    update: {},
  });
  await db.user.upsert({
    where: { id: ACTOR_USER },
    create: {
      id: ACTOR_USER,
      organizationId: ORG,
      email: "ledger-svc-actor@example.com",
      fullName: "Ledger Service Test Actor",
      status: "active",
      role: "admin",
      userType: "operator",
      partyId: ACTOR_PARTY,
    },
    update: {},
  });
}

async function cleanOrg(id: string) {
  const db = getDb();
  await db.auditLog.deleteMany({ where: { organizationId: id } });
  await db.ownerLedgerEntry.deleteMany({ where: { organizationId: id } });
  // Charge cleanup must precede the Party delete in cleanActorUser (Charge.partyId FK).
  await db.charge.deleteMany({ where: { organizationId: id } });
  await db.organization.deleteMany({ where: { id } });
}

async function cleanActorUser() {
  const db = getDb();
  await db.user.deleteMany({ where: { id: ACTOR_USER } });
  await db.party.deleteMany({ where: { id: ACTOR_PARTY } });
}

// ─── Input factory ────────────────────────────────────────────────────────────

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    ownerPartyId: OWNER,
    propertyId: PROPERTY,
    listingId: null,
    tenancyId: null,
    statementMonth: "2026-06",
    transactionDate: "2026-06-15",
    direction: "income" as const,
    category: "rental_income" as const,
    description: null,
    remarks: null,
    amount: "1200.00",
    sstAmount: null,
    paidBy: "kaen" as const,
    paymentStatus: "paid" as const,
    taxCategory: "check_with_tax_agent" as const,
    attachmentKeys: [],
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

dn("owner-ledger.service — integration", () => {
  beforeAll(async () => {
    await cleanOrg(ORG);
    await cleanOrg(ORG2);
    await cleanActorUser();
    await ensureOrg(ORG, "org1");
    await ensureOrg(ORG2, "org2");
    await ensureActorUser();
  });

  afterAll(async () => {
    await cleanOrg(ORG);
    await cleanOrg(ORG2);
    await cleanActorUser();
  });

  beforeEach(async () => {
    const db = getDb();
    await db.auditLog.deleteMany({ where: { organizationId: ORG } });
    await db.auditLog.deleteMany({ where: { organizationId: ORG2 } });
    await db.ownerLedgerEntry.deleteMany({ where: { organizationId: ORG } });
    await db.ownerLedgerEntry.deleteMany({ where: { organizationId: ORG2 } });
    await db.charge.deleteMany({ where: { organizationId: ORG } });
    await db.charge.deleteMany({ where: { organizationId: ORG2 } });
  });

  it("(a) createEntryService with paidBy:kaen sets includeInPayout=true and creates audit row", async () => {
    const db = getDb();

    const result = await createEntryService(actor, baseInput({ paidBy: "kaen" }));

    expect(result.ok).toBe(true);
    expect(result.status).toBe(201);
    if (!result.ok) return;

    const { data } = result;
    expect(data.includeInPayout).toBe(true);
    expect(data.organizationId).toBe(ORG);
    expect(data.createdById).toBe(ACTOR_USER);
    expect(data.updatedById).toBe(ACTOR_USER);
    expect(data.status).toBe("active");
    expect(data.paidBy).toBe("kaen");

    // Verify statementMonth and transactionDate were parsed correctly
    expect(data.statementMonth).toContain("2026-06");
    expect(data.transactionDate).toContain("2026-06-15");

    // Verify audit row
    const auditRows = await db.auditLog.findMany({
      where: { organizationId: ORG, entityType: "OwnerLedgerEntry", entityId: data.id },
    });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!.action).toBe("owner_ledger.entry.create");
    expect(auditRows[0]!.entityType).toBe("OwnerLedgerEntry");
    expect(auditRows[0]!.entityId).toBe(data.id);
  });

  it("(b) updateEntryService with stale expectedUpdatedAt returns 409", async () => {
    // First create an entry
    const createResult = await createEntryService(actor, baseInput());
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    // Attempt update with a stale token
    const patchResult = await updateEntryService(actor, createResult.data.id, {
      remarks: "updated",
      expectedUpdatedAt: "2020-01-01T00:00:00.000Z",
    });

    expect(patchResult.ok).toBe(false);
    expect(patchResult.status).toBe(409);
  });

  it("(c) voidEntryService with current token sets status=void and creates audit row", async () => {
    const db = getDb();

    // Create entry first
    const createResult = await createEntryService(actor, baseInput());
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    // Void with current token
    const voidResult = await voidEntryService(
      actor,
      createResult.data.id,
      createResult.data.updatedAt,
    );

    expect(voidResult.ok).toBe(true);
    expect(voidResult.status).toBe(200);
    if (!voidResult.ok) return;

    expect(voidResult.data.status).toBe("void");

    // Check audit row for void
    const auditRows = await db.auditLog.findMany({
      where: {
        organizationId: ORG,
        entityType: "OwnerLedgerEntry",
        entityId: createResult.data.id,
        action: "owner_ledger.entry.void",
      },
    });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!.action).toBe("owner_ledger.entry.void");
  });

  it("(d) getEntryService cross-org returns 404; listEntriesService for ORG2 returns empty", async () => {
    // Create entry in ORG
    const createResult = await createEntryService(actor, baseInput());
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    // actor2 (ORG2) tries to get an entry that belongs to ORG
    const getResult = await getEntryService(actor2, createResult.data.id);
    expect(getResult.ok).toBe(false);
    expect(getResult.status).toBe(404);

    // actor2 lists entries in ORG2 — should be empty
    const listResult = await listEntriesService(actor2, {}, { limit: 10, offset: 0 });
    expect(listResult.ok).toBe(true);
    if (!listResult.ok) return;
    expect(listResult.data.rows).toHaveLength(0);
    expect(listResult.data.total).toBe(0);
  });

  it("(e) updateEntryService is blocked read-only (409) and leaves the row unchanged", async () => {
    const db = getDb();
    const createResult = await createEntryService(actor, baseInput({ paidBy: "kaen", amount: "100.00" }));
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;
    const created = createResult.data;

    const updateResult = await updateEntryService(actor, created.id, {
      amount: "999.00", paidBy: "owner", expectedUpdatedAt: created.updatedAt,
    });
    expect(updateResult.ok).toBe(false);
    expect(updateResult.status).toBe(409);

    // Row unchanged.
    const persisted = await db.ownerLedgerEntry.findUnique({ where: { id: created.id } });
    expect(Number(persisted!.amount)).toBe(100);
    expect(persisted!.paidBy).toBe("kaen");
    // Full-row immutability: updatedAt is the strongest "was this row touched"
    // signal — the old code always bumped it on write, so an unchanged
    // updatedAt proves the stub performed zero writes (not just these 2 fields).
    expect(persisted!.updatedAt.toISOString()).toBe(created.updatedAt);

    // No update audit row written.
    const auditRows = await db.auditLog.findMany({
      where: { organizationId: ORG, entityType: "OwnerLedgerEntry", entityId: created.id, action: "owner_ledger.entry.update" },
    });
    expect(auditRows).toHaveLength(0);
  });

  it("(e2) updateEntryService returns 409 for a nonexistent id (no separate 404 path remains)", async () => {
    // Adversarial-audit finding: the old code pre-read the row and returned 404
    // for a missing/cross-org id. The read-only stub must reject UNCONDITIONALLY
    // — every id, existing or not, gets the same 409 — so no 404 branch survives.
    const NONEXISTENT_ID = "aaaaaaaa-0000-4000-8000-00000000dead";
    const patchResult = await updateEntryService(actor, NONEXISTENT_ID, {
      remarks: "updated",
      expectedUpdatedAt: new Date().toISOString(),
    });
    expect(patchResult.ok).toBe(false);
    expect(patchResult.status).toBe(409);
  });

  it("(f) listEntriesService surfaces chargedAmount = source Charge.amount for income rows (billed price)", async () => {
    const db = getDb();
    const CHARGE_ID = "aaaaaaaa-0000-4000-8000-0000000000f1";

    // A posted (unpaid) rent charge billed at RM 800.
    await db.charge.create({
      data: {
        id: CHARGE_ID,
        organizationId: ORG,
        chargeNumber: "TESTCHG-f1",
        partyId: ACTOR_PARTY,
        chargeType: "rent",
        status: "posted",
        dueDate: new Date("2026-06-01"),
        amount: "800.00",
        currency: "MYR",
        outstandingAmount: "800.00",
      },
    });

    // The income ledger row: amount = COLLECTED-so-far (0 while unpaid); the
    // billed price lives on the linked charge via sourceChargeId.
    await db.ownerLedgerEntry.create({
      data: {
        organizationId: ORG,
        ownerPartyId: OWNER,
        propertyId: PROPERTY,
        statementMonth: new Date("2026-06-01"),
        transactionDate: new Date("2026-06-01"),
        direction: "income",
        category: "rental_income",
        amount: "0.00",
        paidBy: "kaen",
        paymentStatus: "pending",
        sourceType: "rent",
        sourceChargeId: CHARGE_ID,
        createdById: ACTOR_USER,
        updatedById: ACTOR_USER,
      },
    });

    const listResult = await listEntriesService(actor, { ownerPartyId: OWNER }, { limit: 10, offset: 0 });
    expect(listResult.ok).toBe(true);
    if (!listResult.ok) return;

    const row = listResult.data.rows.find((r) => r.direction === "income");
    expect(row).toBeDefined();
    // The row's own `amount` stays COLLECTED (payout input) — untouched.
    // (Decimal.toString() drops trailing zeros: "0.00" → "0".)
    expect(row!.amount).toBe("0");
    // chargedAmount surfaces the BILLED price for display ("800.00" → "800").
    expect(row!.chargedAmount).toBe("800");
    // R5a: the DTO also carries the raw source ids through the real DB round-trip
    // (not just the hand-built unit fixture in the rowToDto describe block below).
    expect(row!.sourceChargeId).toBe(CHARGE_ID);
    expect(row!.sourceUtilityBillId).toBeNull();
  });
});

// ─── rowToDto — source ids passthrough (R5a) ─────────────────────────────────
//
// Pure unit tests (no DB, no RUN_INTEGRATION gate): rowToDto is a synchronous
// mapping function, so it is tested directly against fixture rows rather than
// through the DB-backed integration harness above.

/** Prisma-Decimal stand-in (matches the convention in owner-months.per-unit.test.ts): every consumer reads it via `.toString()`. */
const dec = (s: string) => ({ toString: () => s }) as unknown as DbOwnerLedgerEntry["amount"];

function baseRow(overrides: Partial<DbOwnerLedgerEntry> = {}): DbOwnerLedgerEntry {
  return {
    id: "row-1",
    organizationId: "org-1",
    ownerPartyId: "owner-1",
    propertyId: "prop-1",
    apartmentId: null,
    listingId: null,
    tenancyId: null,
    statementMonth: new Date("2026-06-01"),
    transactionDate: new Date("2026-06-15"),
    direction: "income",
    category: "rental_income",
    description: null,
    remarks: null,
    amount: dec("1200.00"),
    sstAmount: null,
    paidBy: "kaen",
    paymentStatus: "paid",
    taxCategory: "check_with_tax_agent",
    includeInPayout: true,
    attachmentKeys: [],
    sourceType: "manual",
    sourceChargeId: null,
    sourceInvoiceId: null,
    sourceUtilityBillId: null,
    payeeName: null,
    paidOnBehalfRef: null,
    paidOnBehalfDate: null,
    status: "active",
    createdById: "user-1",
    updatedById: "user-1",
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    ...overrides,
  } as DbOwnerLedgerEntry;
}

describe("rowToDto — source ids passthrough (R5a)", () => {
  it("dto source ids: carries sourceChargeId through and leaves sourceUtilityBillId null for a charge-derived row", () => {
    const row = baseRow({ sourceType: "rent", sourceChargeId: "c-1", sourceUtilityBillId: null });

    const dto = rowToDto(row);

    expect(dto.sourceChargeId).toBe("c-1");
    expect(dto.sourceUtilityBillId).toBeNull();
  });

  it("dto manual null: carries both source ids as null for a manual row (no field dropped, no crash)", () => {
    const row = baseRow({ sourceType: "manual", sourceChargeId: null, sourceUtilityBillId: null });

    const dto = rowToDto(row);

    expect(dto.sourceChargeId).toBeNull();
    expect(dto.sourceUtilityBillId).toBeNull();
  });
});
