/**
 * Task 7 integration tests — POST /owner-remittances/:id/allocate (real
 * Postgres, full route→service→repo wiring through an in-process Hono app —
 * remittance.integration.test.ts / meter/attachment.routes.integration.test.ts
 * precedent).
 *
 * Local-DB safety guard + fixed disjoint org uuid ("17" prefix — grep-verified
 * absent from every other integration suite; sibling Task-5 repo suite uses
 * "15", Task-6 create suite uses "16") mirror remittance.integration.test.ts.
 *
 * Run:
 *   export DATABASE_URL=$(grep -E '^DATABASE_URL=' .env | head -1 | sed -E 's/^DATABASE_URL=//; s/^"//; s/"$//')
 *   export SESSION_SECRET=$(grep -E '^SESSION_SECRET=' .env | head -1 | sed -E 's/^SESSION_SECRET=//; s/^"//; s/"$//')
 *   RUN_INTEGRATION=1 npx vitest run apps/api/src/modules/owner-remittance/__tests__/allocate.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { Hono } from "hono";
import { getDb } from "@kason/db";
import type { Prisma } from "@kason/db";
import type { SessionPayload } from "../../../lib/auth";
import { ownerRemittanceRoutes } from "../owner-remittance.routes";
import { periodRemainingPayableC } from "../owner-remittance.repository";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

// ─── Fixed disjoint UUIDs ("17" prefix; "15"=Task-5 repo, "16"=Task-6 create) ─

const ORG = "17000000-0000-4000-8000-0000000000a1";
const OTHER_ORG = "17000000-0000-4000-8000-0000000000c1";
const ACTOR = "17000000-0000-4000-8000-0000000000a2"; // accounting-staff actor (real User row — AuditLog FK)
const OWNER = "17000000-0000-4000-8000-0000000000a4";
const OWNER2 = "17000000-0000-4000-8000-0000000000a5"; // cross-owner isolation
const PROPERTY = "17000000-0000-4000-8000-0000000000a6";
const PROPERTY2 = "17000000-0000-4000-8000-0000000000a7";
const APARTMENT = "17000000-0000-4000-8000-0000000000a8"; // in PROPERTY
const APARTMENT2 = "17000000-0000-4000-8000-0000000000a9"; // also in PROPERTY
const APARTMENT3 = "17000000-0000-4000-8000-0000000000aa"; // in PROPERTY2 (cross-property)

const PERIOD_MONTH = new Date(Date.UTC(2026, 0, 1));

// ─── Cleanup / seed (FK-safe order — AuditLog.actor is onDelete:Restrict) ────

async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  const otherOrg = { organizationId: OTHER_ORG };
  await db.notification.deleteMany({ where: org });
  await db.ownerRemittanceAllocation.deleteMany({ where: org });
  await db.ownerLedgerEntry.deleteMany({ where: org });
  await db.ownerStatementPeriod.deleteMany({ where: org });
  await db.ownerRemittanceAllocation.deleteMany({ where: otherOrg });
  await db.ownerLedgerEntry.deleteMany({ where: otherOrg });
  await db.ownerStatementPeriod.deleteMany({ where: otherOrg });
  await db.auditLog.deleteMany({ where: org }); // before user (Restrict FK)
  await db.apartment.deleteMany({ where: org });
  await db.property.deleteMany({ where: org });
  await db.party.deleteMany({ where: org });
  await db.user.deleteMany({ where: org });
  await db.organization.deleteMany({ where: { id: ORG } });
  await db.organization.deleteMany({ where: { id: OTHER_ORG } });
}

async function seedOrg() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG,
      name: "T7 Allocate Org",
      slug: "t7-allocate-org",
      status: "active",
      defaultCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur",
      locale: "en-MY",
      subscriptionPlan: "free",
    },
  });
}

async function seedBase() {
  const db = getDb();
  await db.party.create({
    data: { id: OWNER, organizationId: ORG, displayName: "T7 Owner", partyType: "individual", status: "active" },
  });
  await db.user.create({
    data: { id: ACTOR, organizationId: ORG, email: "t7-actor@example.test", fullName: "T7 Actor", status: "active", role: "manager", userType: "operator" },
  });
  await db.property.create({
    data: { id: PROPERTY, organizationId: ORG, name: "T7 Property", propertyCode: "T7-P1", propertyType: "apartment", addressLine1: "1 T7 St", city: "KL", country: "MY", status: "active", publishStatus: "draft" },
  });
  await db.property.create({
    data: { id: PROPERTY2, organizationId: ORG, name: "T7 Property 2", propertyCode: "T7-P2", propertyType: "apartment", addressLine1: "2 T7 St", city: "KL", country: "MY", status: "active", publishStatus: "draft" },
  });
  await db.apartment.create({ data: { id: APARTMENT, organizationId: ORG, propertyId: PROPERTY, unitCode: "A-1", listingMode: "WHOLE" } });
  await db.apartment.create({ data: { id: APARTMENT2, organizationId: ORG, propertyId: PROPERTY, unitCode: "A-2", listingMode: "WHOLE" } });
  await db.apartment.create({ data: { id: APARTMENT3, organizationId: ORG, propertyId: PROPERTY2, unitCode: "B-1", listingMode: "WHOLE" } });
}

/** Raw-seed a PRE_STATEMENT_REMITTANCE payout OwnerLedgerEntry (the row /allocate targets). */
async function seedPreStatementEntry(overrides: Partial<Prisma.OwnerLedgerEntryUncheckedCreateInput> = {}) {
  const db = getDb();
  return db.ownerLedgerEntry.create({
    data: {
      organizationId: ORG,
      ownerPartyId: OWNER,
      propertyId: null,
      statementMonth: PERIOD_MONTH,
      transactionDate: PERIOD_MONTH,
      direction: "payout",
      category: "owner_payout",
      amount: "300.00",
      paidBy: "kaen",
      taxCategory: "not_applicable",
      includeInPayout: false,
      sourceType: "manual",
      status: "active",
      settlementKind: "PRE_STATEMENT_REMITTANCE",
      paymentMethod: "bank_transfer",
      idempotencyKey: `t7-entry-${randomUUID()}`,
      requestFingerprint: `t7-fingerprint-${randomUUID()}`,
      createdById: ACTOR,
      updatedById: ACTOR,
      ...overrides,
    },
  });
}

/** Raw-seed an OwnerStatementPeriod. netPayoutC defaults to a generous cap. */
async function seedPeriod(overrides: Partial<Prisma.OwnerStatementPeriodUncheckedCreateInput> = {}) {
  const db = getDb();
  return db.ownerStatementPeriod.create({
    data: {
      organizationId: ORG,
      ownerPartyId: OWNER,
      apartmentId: APARTMENT,
      periodMonth: PERIOD_MONTH,
      netPayoutC: 100000,
      idempotencyKey: `t7-period-${randomUUID()}`,
      sourceMaxUpdatedAt: PERIOD_MONTH,
      ...overrides,
    },
  });
}

/** Raw-seed an existing OwnerRemittanceAllocation row (simulates a prior create/allocate call). */
async function seedAllocation(payoutEntryId: string, ownerStatementPeriodId: string, allocatedAmountC: number) {
  const db = getDb();
  return db.ownerRemittanceAllocation.create({
    data: { organizationId: ORG, payoutEntryId, ownerStatementPeriodId, allocatedAmountC, createdById: ACTOR },
  });
}

// ─── Hono app harness (remittance.integration.test.ts precedent) ─────────────

const MANAGER: SessionPayload = { userId: ACTOR, orgId: ORG, role: "manager", userType: "operator" };
const EDITOR: SessionPayload = { userId: ACTOR, orgId: ORG, role: "editor", userType: "operator" };
const ACCOUNTANT: SessionPayload = { userId: ACTOR, orgId: ORG, role: "accountant", userType: "operator" };

function makeApp(session: SessionPayload = MANAGER) {
  const app = new Hono<{ Variables: { session: SessionPayload } }>();
  app.use("*", async (c, next) => {
    c.set("session", session);
    await next();
  });
  app.route("/", ownerRemittanceRoutes);
  return app;
}

type AllocateLine = { ownerStatementPeriodId: string; allocatedAmount: string };
type AllocatePayload = { allocations: AllocateLine[]; idempotencyKey: string };

function basePayload(overrides: Partial<AllocatePayload> = {}): AllocatePayload {
  return {
    allocations: [],
    idempotencyKey: randomUUID(),
    ...overrides,
  };
}

async function allocate(entryId: string, payload: AllocatePayload, session: SessionPayload = MANAGER) {
  const app = makeApp(session);
  const res = await app.request(`/${entryId}/allocate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  // Robust to a non-JSON error body (Hono's default 404/500 pages) so an
  // unimplemented route/guard surfaces as a status-code mismatch, never a
  // JSON.parse crash in the test itself.
  const text = await res.text();
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = { _rawBody: text };
  }
  return { status: res.status, json };
}

async function countOrgAllocationRows() {
  return getDb().ownerRemittanceAllocation.count({ where: { organizationId: ORG } });
}

dn("POST /owner-remittances/:id/allocate — Task 7 integration", () => {
  beforeEach(async () => {
    process.env.ENABLE_PHASE2_OWNER_REMITTANCE = "true";
    await cleanup();
    await seedOrg();
    await seedBase();
  });

  afterAll(async () => {
    await cleanup();
  });

  // ── Cycle 1: entry resolution (guards 0-1) ──────────────────────────────────

  it("(B1 entry_not_found) entryId does not exist — 404 REMITTANCE_NOT_FOUND, nothing written", async () => {
    const period = await seedPeriod();
    const before = await countOrgAllocationRows();

    const { status, json } = await allocate(
      randomUUID(),
      basePayload({ allocations: [{ ownerStatementPeriodId: period.id, allocatedAmount: "50.00" }] }),
    );

    expect(status).toBe(404);
    expect(json).toEqual({ error: "REMITTANCE_NOT_FOUND" });
    expect(await countOrgAllocationRows()).toBe(before);
  });

  it("(B3 malformed_id) a non-UUID :id path param — 404 REMITTANCE_NOT_FOUND, no crash", async () => {
    const period = await seedPeriod();

    const { status, json } = await allocate(
      "not-a-uuid",
      basePayload({ allocations: [{ ownerStatementPeriodId: period.id, allocatedAmount: "50.00" }] }),
    );

    expect(status).toBe(404);
    expect(json).toEqual({ error: "REMITTANCE_NOT_FOUND" });
  });

  it("(B2 entry_foreign_org) entryId belongs to a DIFFERENT organization — 404 REMITTANCE_NOT_FOUND", async () => {
    const db = getDb();
    await db.organization.create({
      data: {
        id: OTHER_ORG,
        name: "T7 Foreign Org",
        slug: "t7-foreign-org",
        status: "active",
        defaultCurrency: "MYR",
        timezone: "Asia/Kuala_Lumpur",
        locale: "en-MY",
        subscriptionPlan: "free",
      },
    });
    const foreignEntry = await db.ownerLedgerEntry.create({
      data: {
        organizationId: OTHER_ORG,
        ownerPartyId: OWNER,
        statementMonth: PERIOD_MONTH,
        transactionDate: PERIOD_MONTH,
        direction: "payout",
        category: "owner_payout",
        amount: "300.00",
        paidBy: "kaen",
        taxCategory: "not_applicable",
        includeInPayout: false,
        sourceType: "manual",
        status: "active",
        settlementKind: "PRE_STATEMENT_REMITTANCE",
        idempotencyKey: `t7-foreign-entry-${randomUUID()}`,
        createdById: ACTOR,
        updatedById: ACTOR,
      },
    });
    const period = await seedPeriod();

    const { status, json } = await allocate(
      foreignEntry.id,
      basePayload({ allocations: [{ ownerStatementPeriodId: period.id, allocatedAmount: "50.00" }] }),
    );

    expect(status).toBe(404);
    expect(json).toEqual({ error: "REMITTANCE_NOT_FOUND" });
  });

  // ── Cycle 2: settlementKind guard (guard 2) ─────────────────────────────────

  it("(B4 not_pre_statement) entry.settlementKind is OWNER_REMITTANCE — 400 NOT_PRE_STATEMENT_REMITTANCE", async () => {
    const db = getDb();
    const ownerRemittanceEntry = await db.ownerLedgerEntry.create({
      data: {
        organizationId: ORG,
        ownerPartyId: OWNER,
        statementMonth: PERIOD_MONTH,
        transactionDate: PERIOD_MONTH,
        direction: "payout",
        category: "owner_payout",
        amount: "300.00",
        paidBy: "kaen",
        taxCategory: "not_applicable",
        includeInPayout: false,
        sourceType: "manual",
        status: "active",
        settlementKind: "OWNER_REMITTANCE",
        idempotencyKey: `t7-owner-remit-${randomUUID()}`,
        createdById: ACTOR,
        updatedById: ACTOR,
      },
    });
    const period = await seedPeriod();
    const before = await countOrgAllocationRows();

    const { status, json } = await allocate(
      ownerRemittanceEntry.id,
      basePayload({ allocations: [{ ownerStatementPeriodId: period.id, allocatedAmount: "50.00" }] }),
    );

    expect(status).toBe(400);
    expect(json).toEqual({ error: "NOT_PRE_STATEMENT_REMITTANCE" });
    expect(await countOrgAllocationRows()).toBe(before);
  });

  // ── Cycle 3: lifecycle guards (guard 3a/3b) ─────────────────────────────────

  it("(B5 already_reversed) an ACTIVE reversal row points at the entry — 409 ALREADY_REVERSED, nothing written", async () => {
    const db = getDb();
    const entry = await seedPreStatementEntry();
    // Task 9 (reverse) doesn't exist yet — hand-seed the reversal row it
    // would create (append-only, reversalOfEntryId one-way pointer, R11).
    await db.ownerLedgerEntry.create({
      data: {
        organizationId: ORG,
        ownerPartyId: OWNER,
        statementMonth: PERIOD_MONTH,
        transactionDate: PERIOD_MONTH,
        direction: "payout",
        category: "owner_payout",
        amount: "300.00",
        paidBy: "kaen",
        taxCategory: "not_applicable",
        includeInPayout: false,
        sourceType: "manual",
        status: "active",
        settlementKind: "PRE_STATEMENT_REMITTANCE",
        reversalOfEntryId: entry.id,
        idempotencyKey: `t7-reversal-${randomUUID()}`,
        createdById: ACTOR,
        updatedById: ACTOR,
      },
    });
    const period = await seedPeriod();
    const before = await countOrgAllocationRows();

    const { status, json } = await allocate(
      entry.id,
      basePayload({ allocations: [{ ownerStatementPeriodId: period.id, allocatedAmount: "50.00" }] }),
    );

    expect(status).toBe(409);
    expect(json).toEqual({ error: "ALREADY_REVERSED" });
    expect(await countOrgAllocationRows()).toBe(before);
  });

  it("(B6 entry_voided) entry.status is void — 409 ENTRY_NOT_ACTIVE, nothing written", async () => {
    const entry = await seedPreStatementEntry({ status: "void" });
    const period = await seedPeriod();
    const before = await countOrgAllocationRows();

    const { status, json } = await allocate(
      entry.id,
      basePayload({ allocations: [{ ownerStatementPeriodId: period.id, allocatedAmount: "50.00" }] }),
    );

    expect(status).toBe(409);
    expect(json).toEqual({ error: "ENTRY_NOT_ACTIVE" });
    expect(await countOrgAllocationRows()).toBe(before);
  });

  // ── Cycle 4: per-period cap guard (guard 7's cap sub-check) ─────────────────

  it("(B9 exceeds_period) a new period's allocation exceeds periodRemainingPayableC — 409 ALLOCATION_EXCEEDS_PERIOD, nothing written", async () => {
    const entry = await seedPreStatementEntry();
    const period = await seedPeriod({ netPayoutC: 5000 }); // 50.00 cap
    const before = await countOrgAllocationRows();

    const { status, json } = await allocate(
      entry.id,
      basePayload({ allocations: [{ ownerStatementPeriodId: period.id, allocatedAmount: "100.00" }] }), // exceeds the 50.00 cap
    );

    expect(status).toBe(409);
    expect(json).toEqual({ error: "ALLOCATION_EXCEEDS_PERIOD" });
    expect(await countOrgAllocationRows()).toBe(before);
  });

  // ── Cycle 5: owner-match sub-check (guard 7) ────────────────────────────────

  it("(B7 owner_mismatch) a new period belongs to a DIFFERENT owner (same org) — 422 OWNER_MISMATCH, nothing written", async () => {
    const db = getDb();
    await db.party.create({
      data: { id: OWNER2, organizationId: ORG, displayName: "T7 Owner 2", partyType: "individual", status: "active" },
    });
    const entry = await seedPreStatementEntry(); // ownerPartyId = OWNER
    const otherOwnerPeriod = await seedPeriod({ ownerPartyId: OWNER2 });
    const before = await countOrgAllocationRows();

    const { status, json } = await allocate(
      entry.id,
      basePayload({ allocations: [{ ownerStatementPeriodId: otherOwnerPeriod.id, allocatedAmount: "50.00" }] }),
    );

    expect(status).toBe(422);
    expect(json).toEqual({ error: "OWNER_MISMATCH" });
    expect(await countOrgAllocationRows()).toBe(before);
  });

  it("(B8 cross_org_period) a new period belongs to a DIFFERENT organization — 404 OWNER_STATEMENT_PERIOD_NOT_FOUND, nothing written", async () => {
    const db = getDb();
    await db.organization.create({
      data: {
        id: OTHER_ORG,
        name: "T7 Foreign Org 2",
        slug: "t7-foreign-org-2",
        status: "active",
        defaultCurrency: "MYR",
        timezone: "Asia/Kuala_Lumpur",
        locale: "en-MY",
        subscriptionPlan: "free",
      },
    });
    const foreignPeriod = await db.ownerStatementPeriod.create({
      data: {
        organizationId: OTHER_ORG,
        ownerPartyId: OWNER,
        apartmentId: null,
        periodMonth: PERIOD_MONTH,
        netPayoutC: 999900,
        idempotencyKey: `t7-foreign-period-${randomUUID()}`,
        sourceMaxUpdatedAt: PERIOD_MONTH,
      },
    });
    const entry = await seedPreStatementEntry();
    const before = await countOrgAllocationRows();

    const { status, json } = await allocate(
      entry.id,
      basePayload({ allocations: [{ ownerStatementPeriodId: foreignPeriod.id, allocatedAmount: "50.00" }] }),
    );

    expect(status).toBe(404);
    expect(json).toEqual({ error: "OWNER_STATEMENT_PERIOD_NOT_FOUND" });
    expect(await countOrgAllocationRows()).toBe(before);
  });

  // ── Cycle 6: the write path (guards 8-9) — primary happy path ───────────────

  it("(B12 partial_allocate) 300.00 PRE_STATEMENT with 0 allocations, allocate 200.00 to 1 new period — 200, stored row, unallocated=100.00", async () => {
    const db = getDb();
    const entry = await seedPreStatementEntry(); // amount = 300.00
    const period = await seedPeriod({ netPayoutC: 50000 }); // 500.00 cap — plenty
    const notifBefore = await db.notification.count({ where: { organizationId: ORG } });

    const { status, json } = await allocate(
      entry.id,
      basePayload({ allocations: [{ ownerStatementPeriodId: period.id, allocatedAmount: "200.00" }] }),
    );

    expect(status).toBe(200);
    expect(json).toEqual({ data: { entryId: entry.id, unallocatedC: 10000 } }); // 300.00 - 200.00 = 100.00

    const rows = await db.ownerRemittanceAllocation.findMany({ where: { organizationId: ORG, payoutEntryId: entry.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ownerStatementPeriodId: period.id, allocatedAmountC: 20000, createdById: ACTOR });

    const audit = await db.auditLog.findFirst({ where: { organizationId: ORG, entityId: entry.id, action: "owner_remittance.allocate" } });
    expect(audit).not.toBeNull();

    // No new cash moves — allocate must NOT notify (Task 6's create already notified once, at record time).
    expect(await db.notification.count({ where: { organizationId: ORG } })).toBe(notifBefore);
  });

  // ── Cycle 7: entry-level Σ guard (guard 8) ───────────────────────────────────

  it("(B10 over_allocate) 250 already allocated of 300, allocate 100 more — 409 ALLOCATION_EXCEEDS_UNALLOCATED, nothing written", async () => {
    const db = getDb();
    const entry = await seedPreStatementEntry(); // amount = 300.00
    const existingPeriod = await seedPeriod({ apartmentId: APARTMENT, netPayoutC: 50000 });
    await seedAllocation(entry.id, existingPeriod.id, 25000); // 250.00 already allocated
    const newPeriod = await seedPeriod({ apartmentId: APARTMENT2, netPayoutC: 50000 });
    const before = await countOrgAllocationRows();

    const { status, json } = await allocate(
      entry.id,
      basePayload({ allocations: [{ ownerStatementPeriodId: newPeriod.id, allocatedAmount: "100.00" }] }), // 250+100=350 > 300
    );

    expect(status).toBe(409);
    expect(json).toEqual({ error: "ALLOCATION_EXCEEDS_UNALLOCATED" });
    expect(await countOrgAllocationRows()).toBe(before);
  });

  it("(B15 exact_fill_boundary) Σexisting+Σnew == amountC EXACTLY — succeeds, unallocatedC=0 (guard is > not >=)", async () => {
    const db = getDb();
    const entry = await seedPreStatementEntry(); // amount = 300.00
    const existingPeriod = await seedPeriod({ apartmentId: APARTMENT, netPayoutC: 50000 });
    await seedAllocation(entry.id, existingPeriod.id, 25000); // 250.00 already allocated
    const newPeriod = await seedPeriod({ apartmentId: APARTMENT2, netPayoutC: 50000 });

    const { status, json } = await allocate(
      entry.id,
      basePayload({ allocations: [{ ownerStatementPeriodId: newPeriod.id, allocatedAmount: "50.00" }] }), // 250+50=300 exactly
    );

    expect(status).toBe(200);
    expect(json).toEqual({ data: { entryId: entry.id, unallocatedC: 0 } });
    const rows = await db.ownerRemittanceAllocation.findMany({ where: { organizationId: ORG, payoutEntryId: entry.id } });
    expect(rows).toHaveLength(2);
  });

  // ── Cycle 8: per-period conflict guard (guard 6) ────────────────────────────

  it("(B11 period_conflict) re-allocating an already-allocated period with a DIFFERENT amount — 409 PERIOD_ALREADY_ALLOCATED, nothing written", async () => {
    const db = getDb();
    const entry = await seedPreStatementEntry(); // amount = 300.00
    const period = await seedPeriod({ netPayoutC: 50000 });
    await seedAllocation(entry.id, period.id, 5000); // 50.00 already allocated to this period
    const before = await countOrgAllocationRows();

    const { status, json } = await allocate(
      entry.id,
      basePayload({ allocations: [{ ownerStatementPeriodId: period.id, allocatedAmount: "75.00" }] }), // DIFFERENT amount
    );

    expect(status).toBe(409);
    expect(json).toEqual({ error: "PERIOD_ALREADY_ALLOCATED" });
    expect(await countOrgAllocationRows()).toBe(before);
    // The existing row is untouched (not overwritten, not merged).
    const row = await db.ownerRemittanceAllocation.findFirst({ where: { organizationId: ORG, payoutEntryId: entry.id, ownerStatementPeriodId: period.id } });
    expect(row?.allocatedAmountC).toBe(5000);
  });

  // ── Cycle 9: idempotency — the SAME request retried ─────────────────────────

  it("(B18 idempotent_retry) the SAME allocate request submitted twice — 2nd call is a clean 200 no-op, total allocated unchanged", async () => {
    const db = getDb();
    const entry = await seedPreStatementEntry(); // amount = 300.00
    const period = await seedPeriod({ netPayoutC: 50000 });
    const payload = basePayload({ allocations: [{ ownerStatementPeriodId: period.id, allocatedAmount: "200.00" }] });

    const first = await allocate(entry.id, payload);
    expect(first.status).toBe(200);
    expect(first.json).toEqual({ data: { entryId: entry.id, unallocatedC: 10000 } });
    const afterFirst = await countOrgAllocationRows();

    // SAME entryId, SAME payload (including idempotencyKey) — a genuine retry.
    const retry = await allocate(entry.id, payload);

    expect(retry.status).toBe(200);
    expect(retry.json).toEqual({ data: { entryId: entry.id, unallocatedC: 10000 } }); // unchanged
    expect(await countOrgAllocationRows()).toBe(afterFirst); // NOT doubled
    const rows = await db.ownerRemittanceAllocation.findMany({ where: { organizationId: ORG, payoutEntryId: entry.id } });
    expect(rows).toHaveLength(1); // still exactly one row, not two
    expect(rows[0]?.allocatedAmountC).toBe(20000); // unchanged amount
  });

  it("(B19 partial_idempotent_mix) one request mixes an already-matched period + a genuinely-new period — matched skipped, new written, single clean 200", async () => {
    const db = getDb();
    const entry = await seedPreStatementEntry(); // amount = 300.00
    const matchedPeriod = await seedPeriod({ apartmentId: APARTMENT, netPayoutC: 50000 });
    await seedAllocation(entry.id, matchedPeriod.id, 10000); // 100.00 already allocated
    const newPeriod = await seedPeriod({ apartmentId: APARTMENT2, netPayoutC: 50000 });

    const { status, json } = await allocate(
      entry.id,
      basePayload({
        allocations: [
          { ownerStatementPeriodId: matchedPeriod.id, allocatedAmount: "100.00" }, // identical to existing — idempotent match
          { ownerStatementPeriodId: newPeriod.id, allocatedAmount: "50.00" }, // genuinely new
        ],
      }),
    );

    expect(status).toBe(200);
    expect(json).toEqual({ data: { entryId: entry.id, unallocatedC: 15000 } }); // 300 - 100 - 50 = 150.00

    const rows = await db.ownerRemittanceAllocation.findMany({ where: { organizationId: ORG, payoutEntryId: entry.id } });
    expect(rows).toHaveLength(2); // matched period NOT duplicated; new period inserted
    const byPeriod = new Map(rows.map((r) => [r.ownerStatementPeriodId, r.allocatedAmountC]));
    expect(byPeriod.get(matchedPeriod.id)).toBe(10000); // untouched
    expect(byPeriod.get(newPeriod.id)).toBe(5000); // newly written
  });

  // ── Cycle 10: dedup-sum aggregation (B33 precedent) ──────────────────────────

  it("(B14 dedup_sum_new_period) two lines to the SAME new period in one request — summed into ONE row, no P2002 crash", async () => {
    const db = getDb();
    const entry = await seedPreStatementEntry(); // amount = 300.00
    const period = await seedPeriod({ netPayoutC: 15000 }); // 150.00 cap — matches the summed total exactly

    const { status, json } = await allocate(
      entry.id,
      basePayload({
        allocations: [
          { ownerStatementPeriodId: period.id, allocatedAmount: "75.00" },
          { ownerStatementPeriodId: period.id, allocatedAmount: "75.00" },
        ],
      }),
    );

    expect(status).toBe(200);
    expect(json).toEqual({ data: { entryId: entry.id, unallocatedC: 15000 } }); // 300 - 150 = 150.00

    const rows = await db.ownerRemittanceAllocation.findMany({ where: { organizationId: ORG, payoutEntryId: entry.id } });
    expect(rows).toHaveLength(1); // aggregated into ONE row, not two
    expect(rows[0]?.allocatedAmountC).toBe(15000); // summed (75.00 + 75.00)
  });

  it("(B13 multi_new_period) two lines to TWO DISTINCT new periods in one request — both inserted", async () => {
    const db = getDb();
    const entry = await seedPreStatementEntry(); // amount = 300.00
    const periodA = await seedPeriod({ apartmentId: APARTMENT, netPayoutC: 20000 });
    const periodB = await seedPeriod({ apartmentId: APARTMENT2, netPayoutC: 10000 });

    const { status, json } = await allocate(
      entry.id,
      basePayload({
        allocations: [
          { ownerStatementPeriodId: periodA.id, allocatedAmount: "200.00" },
          { ownerStatementPeriodId: periodB.id, allocatedAmount: "100.00" },
        ],
      }),
    );

    expect(status).toBe(200);
    expect(json).toEqual({ data: { entryId: entry.id, unallocatedC: 0 } }); // 300 - 200 - 100 = 0

    const rows = await db.ownerRemittanceAllocation.findMany({ where: { organizationId: ORG, payoutEntryId: entry.id } });
    expect(rows).toHaveLength(2);
    const byPeriod = new Map(rows.map((r) => [r.ownerStatementPeriodId, r.allocatedAmountC]));
    expect(byPeriod.get(periodA.id)).toBe(20000);
    expect(byPeriod.get(periodB.id)).toBe(10000);
  });

  // ── Cycle 11: guard-order determinism (Pass A vs Pass B vs guard 8) ─────────

  it("(B16 conflict_before_period_cap) a request with a CONFLICTING period + a SEPARATE over-cap period — PERIOD_ALREADY_ALLOCATED wins, nothing written (Pass A precedes Pass B regardless of array order)", async () => {
    const db = getDb();
    const entry = await seedPreStatementEntry(); // amount = 300.00
    const conflictPeriod = await seedPeriod({ apartmentId: APARTMENT, netPayoutC: 50000 });
    await seedAllocation(entry.id, conflictPeriod.id, 5000); // 50.00 already allocated
    const overCapPeriod = await seedPeriod({ apartmentId: APARTMENT2, netPayoutC: 3000 }); // 30.00 cap
    const before = await countOrgAllocationRows();

    // overCapPeriod listed FIRST in the array — if guards were fused/order-
    // dependent, ALLOCATION_EXCEEDS_PERIOD could fire before the conflict is
    // even seen. Two full passes make this deterministic regardless.
    const { status, json } = await allocate(
      entry.id,
      basePayload({
        allocations: [
          { ownerStatementPeriodId: overCapPeriod.id, allocatedAmount: "100.00" }, // exceeds its own 30.00 cap
          { ownerStatementPeriodId: conflictPeriod.id, allocatedAmount: "75.00" }, // DIFFERENT from the existing 50.00
        ],
      }),
    );

    expect(status).toBe(409);
    expect(json).toEqual({ error: "PERIOD_ALREADY_ALLOCATED" });
    expect(await countOrgAllocationRows()).toBe(before); // nothing written — not even the (would-be-valid-alone) other period
  });

  it("(B17 period_cap_before_unallocated) a genuinely-new period exceeds its OWN cap in a request that would ALSO exceed the entry Σ cap — ALLOCATION_EXCEEDS_PERIOD wins (per-period guard precedes entry-level guard)", async () => {
    const entry = await seedPreStatementEntry(); // amount = 300.00
    const existingPeriod = await seedPeriod({ apartmentId: APARTMENT, netPayoutC: 50000 });
    await seedAllocation(entry.id, existingPeriod.id, 25000); // 250.00 already allocated — only 50.00 unallocated left
    const newPeriod = await seedPeriod({ apartmentId: APARTMENT2, netPayoutC: 3000 }); // 30.00 period cap — ALSO less than the 100.00 requested

    const { status, json } = await allocate(
      entry.id,
      // 100.00 exceeds BOTH the period's own 30.00 cap AND, combined with the
      // 250.00 already allocated, the entry's 300.00 total (250+100=350).
      basePayload({ allocations: [{ ownerStatementPeriodId: newPeriod.id, allocatedAmount: "100.00" }] }),
    );

    expect(status).toBe(409);
    expect(json).toEqual({ error: "ALLOCATION_EXCEEDS_PERIOD" }); // not ALLOCATION_EXCEEDS_UNALLOCATED — proves ordering
  });

  // ── Cycle 12: true concurrency (the advisory lock's actual reason to exist) ─

  it("(B20 true_concurrency) two CONCURRENT identical allocate requests race under the owner lock — exactly ONE row written, both responses clean (never a crash, never a double-allocate)", async () => {
    const db = getDb();
    const entry = await seedPreStatementEntry(); // amount = 300.00
    const period = await seedPeriod({ netPayoutC: 50000 });
    const payload = basePayload({ allocations: [{ ownerStatementPeriodId: period.id, allocatedAmount: "200.00" }] });
    const before = await countOrgAllocationRows();

    const [r1, r2] = await Promise.all([allocate(entry.id, payload), allocate(entry.id, payload)]);

    // Both requests must resolve cleanly — never a crash/500, never a raw
    // P2002, never a false conflict between two IDENTICAL concurrent
    // requests (the lock SERIALIZES them; the second to acquire it always
    // finds the first's already-committed row and treats it as an
    // idempotent match).
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r1.json).toEqual({ data: { entryId: entry.id, unallocatedC: 10000 } });
    expect(r2.json).toEqual({ data: { entryId: entry.id, unallocatedC: 10000 } });
    // Exactly ONE new row written total (not two, not zero).
    expect(await countOrgAllocationRows()).toBe(before + 1);
    const rows = await db.ownerRemittanceAllocation.findMany({ where: { organizationId: ORG, payoutEntryId: entry.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.allocatedAmountC).toBe(20000);
  });

  // ── Cycle 13: permission (requireWorkspaceOrRank("accounting","manager")) ──

  it("(B22 editor_denied) a role with neither the accounting workspace nor rank>=manager (editor) — 403", async () => {
    const entry = await seedPreStatementEntry();
    const period = await seedPeriod();

    const { status } = await allocate(
      entry.id,
      basePayload({ allocations: [{ ownerStatementPeriodId: period.id, allocatedAmount: "50.00" }] }),
      EDITOR,
    );

    expect(status).toBe(403);
  });

  it("(B21 accountant_reaches_route) a role qualifying via the WORKSPACE path alone (accountant, rank < manager) succeeds — proves OR logic, not AND", async () => {
    const entry = await seedPreStatementEntry();
    const period = await seedPeriod();

    const { status } = await allocate(
      entry.id,
      basePayload({ allocations: [{ ownerStatementPeriodId: period.id, allocatedAmount: "50.00" }] }),
      ACCOUNTANT,
    );

    expect(status).toBe(200);
  });

  // ── Cycle 14: flag-gate ──────────────────────────────────────────────────────

  it("(B23 flag_gate_dark) flag off — canonical 404, before auth is even evaluated", async () => {
    process.env.ENABLE_PHASE2_OWNER_REMITTANCE = "false";
    const entry = await seedPreStatementEntry();

    const { status, json } = await allocate(
      entry.id,
      basePayload({ allocations: [{ ownerStatementPeriodId: randomUUID(), allocatedAmount: "50.00" }] }),
      EDITOR, // EDITOR would 403 if the flag gate didn't fire FIRST
    );

    expect(status).toBe(404);
    expect(json).toEqual({ error: "not_found" });
  });

  // ── Cycle 15 (edge): propertyId is never re-derived by /allocate ───────────

  it("(B24 propertyid_unchanged) entry.propertyId is NOT re-derived after allocating a NEW period from a DIFFERENT property (documented out-of-scope decision, asserted not just claimed)", async () => {
    const db = getDb();
    // Simulates a Task-6-created single-property PRE_STATEMENT_REMITTANCE
    // (propertyId already resolved to PROPERTY at creation time).
    const entry = await seedPreStatementEntry({ propertyId: PROPERTY });
    const crossPropertyPeriod = await seedPeriod({ apartmentId: APARTMENT3, netPayoutC: 50000 }); // APARTMENT3 → PROPERTY2

    const { status } = await allocate(
      entry.id,
      basePayload({ allocations: [{ ownerStatementPeriodId: crossPropertyPeriod.id, allocatedAmount: "50.00" }] }),
    );

    expect(status).toBe(200);
    const row = await db.ownerLedgerEntry.findUnique({ where: { id: entry.id } });
    // Still PROPERTY — never re-derived to null (cross-property) or to
    // PROPERTY2. /allocate never touches propertyId; only creation (Task 6)
    // derives it.
    expect(row?.propertyId).toBe(PROPERTY);
  });
});
