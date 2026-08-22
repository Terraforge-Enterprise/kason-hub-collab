/**
 * Task 6 integration tests — POST /owner-remittances (real Postgres, full
 * route→service→repo wiring through an in-process Hono app — meter/
 * attachment.routes.integration.test.ts precedent).
 *
 * Local-DB safety guard + fixed disjoint org uuid ("16" prefix — grep-verified
 * absent from every other integration suite; the sibling Task-5 repository
 * suite in this SAME module uses "15") mirror repository.integration.test.ts.
 *
 * Run:
 *   export DATABASE_URL=$(grep -E '^DATABASE_URL=' .env | head -1 | sed -E 's/^DATABASE_URL=//; s/^"//; s/"$//')
 *   RUN_INTEGRATION=1 npx vitest run apps/api/src/modules/owner-remittance/__tests__/remittance.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { Hono } from "hono";
import { getDb } from "@kason/db";
import type { Prisma } from "@kason/db";
import { computeRequestFingerprint } from "@kason/shared/owner-remittance";
import type { SessionPayload } from "../../../lib/auth";
import { ownerRemittanceRoutes } from "../owner-remittance.routes";
import { computeAvailableOwnerPayableC, periodRemainingPayableC } from "../owner-remittance.repository";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

// ─── Fixed disjoint UUIDs ("16" prefix; sibling Task-5 repo suite uses "15") ──

const ORG = "16000000-0000-4000-8000-0000000000a1";
const OTHER_ORG = "16000000-0000-4000-8000-0000000000c1";
const ACTOR = "16000000-0000-4000-8000-0000000000a2"; // accounting-staff actor (real User row — AuditLog FK)
const OWNER_USER = "16000000-0000-4000-8000-0000000000a3"; // owner's portal User (for notify assertions)
const OWNER = "16000000-0000-4000-8000-0000000000a4";
const OWNER2 = "16000000-0000-4000-8000-0000000000a5"; // cross-owner isolation
const PROPERTY = "16000000-0000-4000-8000-0000000000a6";
const PROPERTY2 = "16000000-0000-4000-8000-0000000000a7";
const APARTMENT = "16000000-0000-4000-8000-0000000000a8"; // in PROPERTY
const APARTMENT2 = "16000000-0000-4000-8000-0000000000a9"; // also in PROPERTY (two-units-one-property)
const APARTMENT3 = "16000000-0000-4000-8000-0000000000aa"; // in PROPERTY2 (cross-property)

const EFFECTIVE_DATE = "2026-01-01"; // deliberately a month/year boundary (E6) — see H1's transactionDate assertion
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

async function seedOrg(currency = "MYR") {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG,
      name: "T6 Remittance Org",
      slug: "t6-remittance-org",
      status: "active",
      defaultCurrency: currency,
      timezone: "Asia/Kuala_Lumpur",
      locale: "en-MY",
      subscriptionPlan: "free",
    },
  });
}

async function seedBase() {
  const db = getDb();
  await db.party.create({
    data: { id: OWNER, organizationId: ORG, displayName: "T6 Owner", partyType: "individual", status: "active" },
  });
  await db.user.create({
    data: { id: ACTOR, organizationId: ORG, email: "t6-actor@example.test", fullName: "T6 Actor", status: "active", role: "manager", userType: "operator" },
  });
  // Owner's portal User — required by notifyOwnerOfRemittance to create the notification.
  await db.user.create({
    data: { id: OWNER_USER, organizationId: ORG, partyId: OWNER, email: "t6-owner@example.test", fullName: "T6 Owner Portal", status: "active", role: "owner", userType: "owner" },
  });
  await db.property.create({
    data: { id: PROPERTY, organizationId: ORG, name: "T6 Property", propertyCode: "T6-P1", propertyType: "apartment", addressLine1: "1 T6 St", city: "KL", country: "MY", status: "active", publishStatus: "draft" },
  });
  await db.property.create({
    data: { id: PROPERTY2, organizationId: ORG, name: "T6 Property 2", propertyCode: "T6-P2", propertyType: "apartment", addressLine1: "2 T6 St", city: "KL", country: "MY", status: "active", publishStatus: "draft" },
  });
  await db.apartment.create({ data: { id: APARTMENT, organizationId: ORG, propertyId: PROPERTY, unitCode: "A-1", listingMode: "WHOLE" } });
  await db.apartment.create({ data: { id: APARTMENT2, organizationId: ORG, propertyId: PROPERTY, unitCode: "A-2", listingMode: "WHOLE" } });
  await db.apartment.create({ data: { id: APARTMENT3, organizationId: ORG, propertyId: PROPERTY2, unitCode: "B-1", listingMode: "WHOLE" } });
}

/** Raw-seed an active OwnerLedgerEntry income row so computeAvailableOwnerPayableC has payable to draw from (Task-5 precedent). */
function ledgerRowData(
  overrides: Partial<Prisma.OwnerLedgerEntryUncheckedCreateInput> &
    Pick<Prisma.OwnerLedgerEntryUncheckedCreateInput, "direction" | "category" | "amount">,
): Prisma.OwnerLedgerEntryUncheckedCreateInput {
  return {
    organizationId: ORG,
    ownerPartyId: OWNER,
    propertyId: PROPERTY,
    statementMonth: PERIOD_MONTH,
    transactionDate: PERIOD_MONTH,
    paidBy: "kaen",
    status: "active",
    createdById: ACTOR,
    updatedById: ACTOR,
    ...overrides,
  };
}

async function seedIncomeRow(amount: string, ownerPartyId = OWNER) {
  const db = getDb();
  return db.ownerLedgerEntry.create({
    data: ledgerRowData({ direction: "income", category: "rental_income", amount, ownerPartyId }),
  });
}

/** Raw-seed an OwnerStatementPeriod. netPayoutC defaults to a generous cap so tests that don't care about the per-period cap never trip ALLOCATION_EXCEEDS_PERIOD by accident. */
async function seedPeriod(overrides: Partial<Prisma.OwnerStatementPeriodUncheckedCreateInput> = {}) {
  const db = getDb();
  return db.ownerStatementPeriod.create({
    data: {
      organizationId: ORG,
      ownerPartyId: OWNER,
      apartmentId: APARTMENT,
      periodMonth: PERIOD_MONTH,
      netPayoutC: 100000,
      idempotencyKey: `t6-period-${randomUUID()}`,
      sourceMaxUpdatedAt: PERIOD_MONTH,
      ...overrides,
    },
  });
}

// ─── Hono app harness (meter/attachment.routes.integration.test.ts precedent) ─

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

type Payload = {
  ownerPartyId: string;
  amount: string;
  effectiveDate: string;
  settlementKind: "OWNER_REMITTANCE" | "PRE_STATEMENT_REMITTANCE";
  paymentMethod: "bank_transfer" | "cash" | "cheque" | "other";
  bankReference?: string;
  proofKey?: string;
  memo?: string;
  currency: string;
  allocations: { ownerStatementPeriodId: string; allocatedAmount: string }[];
  idempotencyKey: string;
};

// A syntactically-valid but non-existent period id — usable in tests where an
// EARLIER guard (pre-tx amount check, idempotency, over-remittance) must fire
// before allocations are ever read, so the schema's allocations.min(1) is
// satisfied without needing a real period.
const PLACEHOLDER_PERIOD = "00000000-0000-4000-8000-000000000000";

function basePayload(overrides: Partial<Payload> = {}): Payload {
  return {
    ownerPartyId: OWNER,
    amount: "100.00",
    effectiveDate: EFFECTIVE_DATE,
    settlementKind: "OWNER_REMITTANCE",
    paymentMethod: "bank_transfer",
    currency: "MYR",
    allocations: [{ ownerStatementPeriodId: PLACEHOLDER_PERIOD, allocatedAmount: "100.00" }],
    idempotencyKey: randomUUID(),
    ...overrides,
  };
}

async function post(payload: Payload, session: SessionPayload = MANAGER) {
  const app = makeApp(session);
  const res = await app.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  // Robust to a non-JSON error body (e.g. Hono's plain-text 500 default page for
  // an unhandled throw) so a still-unimplemented guard surfaces as a genuine
  // status-code assertion mismatch, never a JSON.parse crash in the test itself.
  const text = await res.text();
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = { _rawBody: text };
  }
  return { status: res.status, json };
}

async function countOrgLedgerRows() {
  return getDb().ownerLedgerEntry.count({ where: { organizationId: ORG } });
}

dn("POST /owner-remittances — Task 6 integration", () => {
  beforeEach(async () => {
    process.env.ENABLE_PHASE2_OWNER_REMITTANCE = "true";
    await cleanup();
    await seedOrg();
    await seedBase();
  });

  afterAll(async () => {
    await cleanup();
  });

  // ── Cycle 1: AMOUNT_TOO_LARGE (pre-tx, guard 0a) ────────────────────────────

  it("(ER6 AMOUNT_TOO_LARGE) rejects an 11+ integer-digit amount — 422, nothing written", async () => {
    const before = await countOrgLedgerRows();
    const { status, json } = await post(basePayload({ amount: "123456789012.34" }));
    expect(status).toBe(422);
    expect(json).toEqual({ error: "AMOUNT_TOO_LARGE" });
    expect(await countOrgLedgerRows()).toBe(before);
  });

  // ── Cycle 2: idempotency (guards 1-2) ───────────────────────────────────────

  it("(ER7 IDEMPOTENCY_KEY_REUSED) same key + DIFFERENT payload — 409, nothing new written", async () => {
    const db = getDb();
    const key = randomUUID();
    const existing = await db.ownerLedgerEntry.create({
      data: ledgerRowData({
        direction: "payout",
        category: "owner_payout",
        amount: "50.00",
        includeInPayout: false,
        settlementKind: "OWNER_REMITTANCE",
        paymentMethod: "bank_transfer",
        idempotencyKey: key,
        requestFingerprint: "seed-fingerprint-does-not-match-anything",
      }),
    });
    const before = await countOrgLedgerRows();

    const { status, json } = await post(basePayload({ idempotencyKey: key, amount: "75.00" }));

    expect(status).toBe(409);
    expect(json).toEqual({ error: "IDEMPOTENCY_KEY_REUSED" });
    expect(await countOrgLedgerRows()).toBe(before); // nothing NEW written
    expect(await db.ownerLedgerEntry.findUnique({ where: { id: existing.id } })).not.toBeNull();
  });

  it("(CI1 idempotent replay) same key + IDENTICAL payload — 200, returns original entryId, writes nothing new, does not re-notify", async () => {
    const db = getDb();
    const key = randomUUID();
    const payload = basePayload({ idempotencyKey: key });
    const fingerprint = computeRequestFingerprint(payload);
    const existing = await db.ownerLedgerEntry.create({
      data: ledgerRowData({
        direction: "payout",
        category: "owner_payout",
        amount: "50.00",
        includeInPayout: false,
        settlementKind: "OWNER_REMITTANCE",
        paymentMethod: "bank_transfer",
        idempotencyKey: key,
        requestFingerprint: fingerprint,
      }),
    });
    const before = await countOrgLedgerRows();
    const notifBefore = await db.notification.count({ where: { organizationId: ORG } });

    const { status, json } = await post(payload);

    expect(status).toBe(200);
    expect(json).toEqual({ data: { entryId: existing.id } });
    expect(await countOrgLedgerRows()).toBe(before); // nothing NEW written
    expect(await db.notification.count({ where: { organizationId: ORG } })).toBe(notifBefore); // no re-notify
  });

  // ── Cycle 3: OVER_REMITTANCE (guards 3-4) + AMOUNT_TOO_LARGE boundary ───────

  it("(ER1 over_remittance) amountC > availableC (OWNER_REMITTANCE) — 409, no row, no notify", async () => {
    const db = getDb();
    await seedIncomeRow("500.00"); // availableC = 50000
    const notifBefore = await db.notification.count({ where: { organizationId: ORG } });
    const before = await countOrgLedgerRows();

    const { status, json } = await post(basePayload({ amount: "600.00" }));

    expect(status).toBe(409);
    expect(json).toEqual({ error: "OVER_REMITTANCE" });
    expect(await countOrgLedgerRows()).toBe(before);
    expect(await db.notification.count({ where: { organizationId: ORG } })).toBe(notifBefore);
  });

  it("(ER3 prestmt_over) amountC > availableC (PRE_STATEMENT_REMITTANCE) — 409 OVER_REMITTANCE (guard applies regardless of kind)", async () => {
    await seedIncomeRow("500.00"); // availableC = 50000
    const before = await countOrgLedgerRows();

    const { status, json } = await post(
      basePayload({ amount: "600.00", settlementKind: "PRE_STATEMENT_REMITTANCE" }),
    );

    expect(status).toBe(409);
    expect(json).toEqual({ error: "OVER_REMITTANCE" });
    expect(await countOrgLedgerRows()).toBe(before);
  });

  it("(B1 boundary) exactly 10 integer digits does NOT trip AMOUNT_TOO_LARGE — falls through to OVER_REMITTANCE", async () => {
    // No income seeded — availableC stays 0, so a 10-digit amount is
    // guaranteed to exceed it. Proves the 422 guard's boundary is inclusive
    // of 10 digits (only >10 rejects) by observing the NEXT guard fire
    // instead of a 422.
    const { status, json } = await post(basePayload({ amount: "9999999999.99" }));

    expect(status).toBe(409);
    expect(json).toEqual({ error: "OVER_REMITTANCE" });
  });

  // ── Cycle 4: guard 5's org-consistency + OWNER_MISMATCH sub-checks ──────────

  it("(ER9 org-consistency) an allocation's period belongs to a DIFFERENT organization — 404, nothing written", async () => {
    const db = getDb();
    await seedIncomeRow("1000.00"); // plenty of payable so guard 4 never fires
    await db.organization.create({
      data: {
        id: OTHER_ORG,
        name: "T6 Foreign Org",
        slug: "t6-foreign-org",
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
        idempotencyKey: `t6-foreign-period-${randomUUID()}`,
        sourceMaxUpdatedAt: PERIOD_MONTH,
      },
    });
    const before = await countOrgLedgerRows();

    const { status, json } = await post(
      basePayload({ allocations: [{ ownerStatementPeriodId: foreignPeriod.id, allocatedAmount: "100.00" }] }),
    );

    expect(status).toBe(404);
    expect(await countOrgLedgerRows()).toBe(before);
    expect(json.error).toBeTruthy();
  });

  it("(ER10) an allocation referencing a period id that was NEVER created — 404, same code path as org-consistency, no crash", async () => {
    await seedIncomeRow("1000.00");
    const neverCreated = randomUUID();

    const { status } = await post(
      basePayload({ allocations: [{ ownerStatementPeriodId: neverCreated, allocatedAmount: "100.00" }] }),
    );

    expect(status).toBe(404);
  });

  it("(ER4 OWNER_MISMATCH) an allocation's period belongs to a DIFFERENT owner (same org) — 422, nothing written", async () => {
    const db = getDb();
    await seedIncomeRow("1000.00");
    await db.party.create({
      data: { id: OWNER2, organizationId: ORG, displayName: "T6 Owner 2", partyType: "individual", status: "active" },
    });
    const otherOwnerPeriod = await seedPeriod({ ownerPartyId: OWNER2 });
    const before = await countOrgLedgerRows();

    const { status, json } = await post(
      basePayload({ allocations: [{ ownerStatementPeriodId: otherOwnerPeriod.id, allocatedAmount: "100.00" }] }),
    );

    expect(status).toBe(422);
    expect(json).toEqual({ error: "OWNER_MISMATCH" });
    expect(await countOrgLedgerRows()).toBe(before);
  });

  // ── Cycle 5: ALLOCATION_EXCEEDS_PERIOD (guard 5's cap sub-check) ────────────

  it("(ER8 ALLOCATION_EXCEEDS_PERIOD) a period's aggregated allocation exceeds periodRemainingPayableC — 409, nothing written", async () => {
    await seedIncomeRow("1000.00"); // availableC = 100000 — plenty overall, guard 4 must NOT fire
    const period = await seedPeriod({ netPayoutC: 10000 }); // 100.00 cap
    const before = await countOrgLedgerRows();

    const { status, json } = await post(
      basePayload({
        amount: "150.00",
        allocations: [{ ownerStatementPeriodId: period.id, allocatedAmount: "150.00" }], // exceeds the 100.00 period cap
      }),
    );

    expect(status).toBe(409);
    expect(json).toEqual({ error: "ALLOCATION_EXCEEDS_PERIOD" });
    expect(await countOrgLedgerRows()).toBe(before);
  });

  it("(ER12 guard-order) a request violating BOTH OVER_REMITTANCE and ALLOCATION_EXCEEDS_PERIOD returns OVER_REMITTANCE (guard 4 precedes guard 5)", async () => {
    await seedIncomeRow("100.00"); // availableC = 10000
    const period = await seedPeriod({ netPayoutC: 5000 }); // 50.00 cap — ALSO exceeded below

    const { status, json } = await post(
      basePayload({
        amount: "200.00", // exceeds availableC (10000) — guard 4 condition
        allocations: [{ ownerStatementPeriodId: period.id, allocatedAmount: "200.00" }], // ALSO exceeds the period cap (5000) — guard 5 condition
      }),
    );

    expect(status).toBe(409);
    expect(json).toEqual({ error: "OVER_REMITTANCE" }); // not ALLOCATION_EXCEEDS_PERIOD — proves ordering
  });

  // ── Cycle 6: CURRENCY_MISMATCH (guard 6) ────────────────────────────────────

  it("(ER5 CURRENCY_MISMATCH) input.currency !== org.defaultCurrency — 422, nothing written", async () => {
    await seedIncomeRow("1000.00");
    const period = await seedPeriod();
    const before = await countOrgLedgerRows();

    const { status, json } = await post(
      basePayload({
        currency: "USD", // org.defaultCurrency is "MYR" (seedOrg default)
        allocations: [{ ownerStatementPeriodId: period.id, allocatedAmount: "100.00" }],
      }),
    );

    expect(status).toBe(422);
    expect(json).toEqual({ error: "CURRENCY_MISMATCH" });
    expect(await countOrgLedgerRows()).toBe(before);
  });

  it("(ER11 guard-order) a request violating BOTH OWNER_MISMATCH and CURRENCY_MISMATCH returns OWNER_MISMATCH (guard 5 precedes guard 6)", async () => {
    const db = getDb();
    await seedIncomeRow("1000.00");
    await db.party.create({
      data: { id: OWNER2, organizationId: ORG, displayName: "T6 Owner 2 (ER11)", partyType: "individual", status: "active" },
    });
    const otherOwnerPeriod = await seedPeriod({ ownerPartyId: OWNER2 });

    const { status, json } = await post(
      basePayload({
        currency: "USD", // ALSO violates CURRENCY_MISMATCH (guard 6)
        allocations: [{ ownerStatementPeriodId: otherOwnerPeriod.id, allocatedAmount: "100.00" }], // violates OWNER_MISMATCH (guard 5)
      }),
    );

    expect(status).toBe(422);
    expect(json).toEqual({ error: "OWNER_MISMATCH" }); // not CURRENCY_MISMATCH — proves ordering
  });

  // ── Cycle 7: REMITTANCE_NOT_FULLY_ALLOCATED (guard 7, OWNER_REMITTANCE only) ─

  it("(ER2 not_fully_allocated) OWNER_REMITTANCE whose aggregated allocations sum ≠ amountC — 409, nothing written", async () => {
    await seedIncomeRow("1000.00");
    const period = await seedPeriod();
    const before = await countOrgLedgerRows();

    const { status, json } = await post(
      basePayload({
        amount: "100.00",
        settlementKind: "OWNER_REMITTANCE",
        allocations: [{ ownerStatementPeriodId: period.id, allocatedAmount: "60.00" }], // under-allocated
      }),
    );

    expect(status).toBe(409);
    expect(json).toEqual({ error: "REMITTANCE_NOT_FULLY_ALLOCATED" });
    expect(await countOrgLedgerRows()).toBe(before);
  });

  // ── Cycle 8: the full write pipeline (guards 8-13) ──────────────────────────

  it("(H1 allocate_across_units) two periods, same property, 300.00 = 200+100 — one entry + two allocations, single-property propertyId, cash⇒proofStatus null, proof/memo pass through, boundary date, notify", async () => {
    const db = getDb();
    await seedIncomeRow("1000.00");
    const periodA = await seedPeriod({ apartmentId: APARTMENT, netPayoutC: 20000 }); // exactly 200.00
    const periodB = await seedPeriod({ apartmentId: APARTMENT2, netPayoutC: 10000 }); // exactly 100.00 — both SAME property
    const notifBefore = await db.notification.count({ where: { organizationId: ORG, userId: OWNER_USER } });

    const { status, json } = await post(
      basePayload({
        amount: "300.00",
        paymentMethod: "cash",
        bankReference: "REF-H1",
        memo: "H1 across-units test",
        allocations: [
          { ownerStatementPeriodId: periodA.id, allocatedAmount: "200.00" },
          { ownerStatementPeriodId: periodB.id, allocatedAmount: "100.00" },
        ],
      }),
    );

    expect(status).toBe(201);
    const entryId = (json.data as { entryId: string }).entryId;
    expect(typeof entryId).toBe("string");

    const row = await db.ownerLedgerEntry.findUnique({ where: { id: entryId } });
    expect(row).not.toBeNull();
    expect(row?.amount.toString()).toBe("300");
    expect(row?.direction).toBe("payout");
    expect(row?.category).toBe("owner_payout");
    expect(row?.paidBy).toBe("kaen");
    expect(row?.includeInPayout).toBe(false);
    expect(row?.taxCategory).toBe("not_applicable");
    expect(row?.status).toBe("active");
    expect(row?.settlementKind).toBe("OWNER_REMITTANCE");
    expect(row?.paymentMethod).toBe("cash");
    expect(row?.proofStatus).toBeNull(); // R8: non-bank_transfer ⇒ null, never PROOF_PENDING
    expect(row?.propertyId).toBe(PROPERTY); // single-property derivation (both periods resolve to PROPERTY)
    expect(row?.bankReference).toBe("REF-H1"); // pass-through
    expect(row?.memo).toBe("H1 across-units test"); // pass-through
    expect(row?.createdById).toBe(ACTOR);
    expect(row?.updatedById).toBe(ACTOR);
    // E6: effectiveDate "2026-01-01" (a year boundary) parsed via the STRING
    // entry point resolves correctly regardless of server TZ.
    expect(row?.transactionDate.toISOString().slice(0, 10)).toBe("2026-01-01");
    expect(row?.statementMonth.toISOString().slice(0, 10)).toBe("2026-01-01");

    const allocations = await db.ownerRemittanceAllocation.findMany({
      where: { organizationId: ORG, payoutEntryId: entryId },
      orderBy: { allocatedAmountC: "desc" },
    });
    expect(allocations).toHaveLength(2);
    expect(allocations[0]).toMatchObject({ ownerStatementPeriodId: periodA.id, allocatedAmountC: 20000, createdById: ACTOR });
    expect(allocations[1]).toMatchObject({ ownerStatementPeriodId: periodB.id, allocatedAmountC: 10000, createdById: ACTOR });

    const audit = await db.auditLog.findFirst({ where: { organizationId: ORG, entityId: entryId, action: "owner_remittance.record" } });
    expect(audit).not.toBeNull();

    // Notify AFTER commit — owner's portal user gets exactly one notification.
    expect(await db.notification.count({ where: { organizationId: ORG, userId: OWNER_USER } })).toBe(notifBefore + 1);
  });

  it("(H2 bank_proof_pending) bank_transfer with NO proofKey — commits (not rejected) with proofStatus=PROOF_PENDING", async () => {
    const db = getDb();
    await seedIncomeRow("1000.00");
    const period = await seedPeriod();

    const { status, json } = await post(
      basePayload({
        amount: "100.00",
        paymentMethod: "bank_transfer",
        allocations: [{ ownerStatementPeriodId: period.id, allocatedAmount: "100.00" }],
      }),
    );

    expect(status).toBe(201);
    const entryId = (json.data as { entryId: string }).entryId;
    const row = await db.ownerLedgerEntry.findUnique({ where: { id: entryId } });
    expect(row?.proofStatus).toBe("PROOF_PENDING");
  });

  it("(E3 duplicate-allocation aggregation) two allocation LINES to the SAME period sum correctly — one row, summed amount, no P2002", async () => {
    const db = getDb();
    await seedIncomeRow("1000.00");
    const period = await seedPeriod({ netPayoutC: 15000 }); // 150.00 cap — matches the summed total exactly

    const { status, json } = await post(
      basePayload({
        amount: "150.00",
        allocations: [
          { ownerStatementPeriodId: period.id, allocatedAmount: "75.00" },
          { ownerStatementPeriodId: period.id, allocatedAmount: "75.00" },
        ],
      }),
    );

    expect(status).toBe(201);
    const entryId = (json.data as { entryId: string }).entryId;
    const allocations = await db.ownerRemittanceAllocation.findMany({
      where: { organizationId: ORG, payoutEntryId: entryId },
    });
    expect(allocations).toHaveLength(1); // aggregated into ONE row, not two
    expect(allocations[0]?.allocatedAmountC).toBe(15000); // summed (75.00 + 75.00)
  });

  it("(E4) owner balance counts the payout exactly once after the remittance", async () => {
    await seedIncomeRow("500.00"); // availableC = 50000
    const period = await seedPeriod({ netPayoutC: 20000 });

    const availableBeforeC = await getDb().$transaction((tx) => computeAvailableOwnerPayableC(tx, ORG, OWNER));
    expect(availableBeforeC).toBe(50000);

    const { status } = await post(
      basePayload({ amount: "200.00", allocations: [{ ownerStatementPeriodId: period.id, allocatedAmount: "200.00" }] }),
    );
    expect(status).toBe(201);

    const availableAfterC = await getDb().$transaction((tx) => computeAvailableOwnerPayableC(tx, ORG, OWNER));
    expect(availableAfterC).toBe(30000); // 50000 - 20000, exactly once (not double-subtracted, not omitted)
  });

  // ── Cycle 9: propertyId-derivation edge cases (confirmatory — see report) ───

  it("(E1) cross-property remittance (two periods, two DIFFERENT properties) — entry.propertyId === null", async () => {
    const db = getDb();
    await seedIncomeRow("1000.00");
    const periodInProperty1 = await seedPeriod({ apartmentId: APARTMENT, netPayoutC: 20000 }); // PROPERTY
    const periodInProperty2 = await seedPeriod({ apartmentId: APARTMENT3, netPayoutC: 10000 }); // PROPERTY2

    const { status, json } = await post(
      basePayload({
        amount: "300.00",
        allocations: [
          { ownerStatementPeriodId: periodInProperty1.id, allocatedAmount: "200.00" },
          { ownerStatementPeriodId: periodInProperty2.id, allocatedAmount: "100.00" },
        ],
      }),
    );

    expect(status).toBe(201);
    const entryId = (json.data as { entryId: string }).entryId;
    const row = await db.ownerLedgerEntry.findUnique({ where: { id: entryId } });
    expect(row?.propertyId).toBeNull(); // spans >1 property — never attributed to one
  });

  it("(E2) combined-scope allocation (period.apartmentId === null) — entry.propertyId === null", async () => {
    const db = getDb();
    await seedIncomeRow("1000.00");
    const combinedPeriod = await seedPeriod({ apartmentId: null, netPayoutC: 10000 });

    const { status, json } = await post(
      basePayload({
        amount: "100.00",
        allocations: [{ ownerStatementPeriodId: combinedPeriod.id, allocatedAmount: "100.00" }],
      }),
    );

    expect(status).toBe(201);
    const entryId = (json.data as { entryId: string }).entryId;
    const row = await db.ownerLedgerEntry.findUnique({ where: { id: entryId } });
    expect(row?.propertyId).toBeNull(); // combined-scope — never attributed to one property
  });

  it("(E2b) MIXED scope — one allocation resolves to a real property, another is combined-scope — entry.propertyId === null (not the real property)", async () => {
    // Distinguishes sawCombinedOrNullScope from distinctPropertyIds.size: a
    // naive `distinctPropertyIds.size === 1 ? that : null` (ignoring the
    // combined-scope flag) would wrongly return the ONE real property here,
    // since the combined-scope period contributes nothing to that set.
    const db = getDb();
    await seedIncomeRow("1000.00");
    const realPropertyPeriod = await seedPeriod({ apartmentId: APARTMENT, netPayoutC: 20000 });
    const combinedPeriod = await seedPeriod({ apartmentId: null, netPayoutC: 10000 });

    const { status, json } = await post(
      basePayload({
        amount: "300.00",
        allocations: [
          { ownerStatementPeriodId: realPropertyPeriod.id, allocatedAmount: "200.00" },
          { ownerStatementPeriodId: combinedPeriod.id, allocatedAmount: "100.00" },
        ],
      }),
    );

    expect(status).toBe(201);
    const entryId = (json.data as { entryId: string }).entryId;
    const row = await db.ownerLedgerEntry.findUnique({ where: { id: entryId } });
    expect(row?.propertyId).toBeNull();
  });

  // ── Cycle 10: PRE_STATEMENT_REMITTANCE positive path + cross-kind stacking ──

  it("(H3) PRE_STATEMENT_REMITTANCE under-allocated SUCCEEDS (guard 7's skip is a real skip, not accidentally still enforced)", async () => {
    const db = getDb();
    await seedIncomeRow("1000.00");
    const period = await seedPeriod({ netPayoutC: 50000 });

    const { status, json } = await post(
      basePayload({
        amount: "300.00",
        settlementKind: "PRE_STATEMENT_REMITTANCE",
        allocations: [{ ownerStatementPeriodId: period.id, allocatedAmount: "60.00" }], // sum(60) != amount(300) — would 409 for OWNER_REMITTANCE
      }),
    );

    expect(status).toBe(201);
    const entryId = (json.data as { entryId: string }).entryId;
    const row = await db.ownerLedgerEntry.findUnique({ where: { id: entryId } });
    expect(row?.settlementKind).toBe("PRE_STATEMENT_REMITTANCE");
    expect(row?.amount.toString()).toBe("300");
  });

  it("(ER13 ALLOCATION_EXCEEDS_UNALLOCATED) PRE_STATEMENT_REMITTANCE whose aggregated allocations sum EXCEEDS amountC — 409, nothing written (guard 7's upper bound applies to BOTH kinds, not just OWNER_REMITTANCE)", async () => {
    await seedIncomeRow("1000.00"); // availableC = 100000 — plenty, guard 4 must NOT fire
    const period = await seedPeriod({ netPayoutC: 50000 }); // 500.00 cap — plenty, guard 5 must NOT fire
    const before = await countOrgLedgerRows();

    const { status, json } = await post(
      basePayload({
        amount: "1.00",
        settlementKind: "PRE_STATEMENT_REMITTANCE",
        allocations: [{ ownerStatementPeriodId: period.id, allocatedAmount: "100.00" }], // Σ(100.00) > amount(1.00)
      }),
    );

    expect(status).toBe(409);
    expect(json).toEqual({ error: "ALLOCATION_EXCEEDS_UNALLOCATED" });
    expect(await countOrgLedgerRows()).toBe(before);
  });

  it("(E5) cross-kind period stacking — a PRE_STATEMENT_REMITTANCE partially allocates a period; a later OWNER_REMITTANCE targeting the SAME period is capped by the REMAINING amount", async () => {
    const db = getDb();
    await seedIncomeRow("1000.00");
    const period = await seedPeriod({ netPayoutC: 10000 }); // 100.00 cap

    // First call: PRE_STATEMENT_REMITTANCE allocates 60.00 of the period's 100.00 cap.
    const first = await post(
      basePayload({
        amount: "60.00",
        settlementKind: "PRE_STATEMENT_REMITTANCE",
        allocations: [{ ownerStatementPeriodId: period.id, allocatedAmount: "60.00" }],
      }),
    );
    expect(first.status).toBe(201);

    // Second call: a SEPARATE OWNER_REMITTANCE tries to allocate 60.00 MORE to
    // the SAME period — only 40.00 remains (100 - 60). Must be capped by the
    // COMBINED total across both settlementKinds, not just this call's own.
    const second = await post(
      basePayload({
        amount: "60.00",
        settlementKind: "OWNER_REMITTANCE",
        allocations: [{ ownerStatementPeriodId: period.id, allocatedAmount: "60.00" }],
      }),
    );

    expect(second.status).toBe(409);
    expect(second.json).toEqual({ error: "ALLOCATION_EXCEEDS_PERIOD" });

    // A THIRD call for exactly the remaining 40.00 must succeed.
    const third = await post(
      basePayload({
        amount: "40.00",
        settlementKind: "OWNER_REMITTANCE",
        allocations: [{ ownerStatementPeriodId: period.id, allocatedAmount: "40.00" }],
      }),
    );
    expect(third.status).toBe(201);

    const remainingC = await getDb().$transaction((tx) => periodRemainingPayableC(tx, ORG, period.id));
    expect(remainingC).toBe(0); // 100.00 fully consumed across BOTH kinds
  });

  // ── Cycle 11: requestFingerprint array-order sensitivity (documented, pinned) ─

  it("(E7) retrying with the allocations array in a DIFFERENT element order false-409s as IDEMPOTENCY_KEY_REUSED (documented, accepted limitation — see finance/owner-remittance.ts's own docstring; NOT normalized at this layer)", async () => {
    await seedIncomeRow("1000.00");
    const periodA = await seedPeriod({ apartmentId: APARTMENT, netPayoutC: 20000 });
    const periodB = await seedPeriod({ apartmentId: APARTMENT2, netPayoutC: 10000 });
    const key = randomUUID();

    const first = await post(
      basePayload({
        amount: "300.00",
        idempotencyKey: key,
        allocations: [
          { ownerStatementPeriodId: periodA.id, allocatedAmount: "200.00" },
          { ownerStatementPeriodId: periodB.id, allocatedAmount: "100.00" },
        ],
      }),
    );
    expect(first.status).toBe(201);

    // Semantically IDENTICAL retry — same key, same amount, same two
    // allocations — but the array elements are in the OPPOSITE order.
    const retry = await post(
      basePayload({
        amount: "300.00",
        idempotencyKey: key,
        allocations: [
          { ownerStatementPeriodId: periodB.id, allocatedAmount: "100.00" },
          { ownerStatementPeriodId: periodA.id, allocatedAmount: "200.00" },
        ],
      }),
    );

    expect(retry.status).toBe(409);
    expect(retry.json).toEqual({ error: "IDEMPOTENCY_KEY_REUSED" });
  });

  // ── Cycle 12: permission (requireWorkspaceOrRank("accounting","manager")) ───

  it("(P1) a role with neither the accounting workspace nor rank>=manager (editor) — 403", async () => {
    const { status } = await post(basePayload(), EDITOR);
    expect(status).toBe(403);
  });

  it("(P2) a role qualifying via the WORKSPACE path alone (accountant, rank < manager) succeeds — proves OR logic, not AND", async () => {
    await seedIncomeRow("1000.00");
    const period = await seedPeriod();

    const { status } = await post(
      basePayload({ allocations: [{ ownerStatementPeriodId: period.id, allocatedAmount: "100.00" }] }),
      ACCOUNTANT,
    );

    expect(status).toBe(201);
  });

  // ── Cycle 13: flag-gate ──────────────────────────────────────────────────────

  it("(F1) flag-off — canonical 404, before auth is even evaluated", async () => {
    process.env.ENABLE_PHASE2_OWNER_REMITTANCE = "false";

    const { status, json } = await post(basePayload(), EDITOR); // EDITOR would 403 if the flag gate didn't fire FIRST
    expect(status).toBe(404);
    expect(json).toEqual({ error: "not_found" });
  });

  // ── Cycle 14: true concurrency (the advisory lock's actual reason to exist) ──

  it("(CI2) two CONCURRENT identical requests (same idempotencyKey+payload) — exactly ONE write, the loser cleanly replays (never a crash, never two rows)", async () => {
    const db = getDb();
    await seedIncomeRow("1000.00");
    const period = await seedPeriod({ netPayoutC: 20000 });
    const payload = basePayload({
      amount: "100.00",
      allocations: [{ ownerStatementPeriodId: period.id, allocatedAmount: "100.00" }],
    });
    const before = await countOrgLedgerRows();

    const [r1, r2] = await Promise.all([post(payload), post(payload)]);

    // Both requests must resolve cleanly — never a crash/500, never a false
    // 409 between two IDENTICAL concurrent requests.
    expect([200, 201]).toContain(r1.status);
    expect([200, 201]).toContain(r2.status);
    // Exactly one winner (201, fresh create) and one clean replay (200) — the
    // lock SERIALIZES the two transactions, so the second to acquire it always
    // finds the first's already-committed row.
    expect([r1.status, r2.status].sort()).toEqual([200, 201]);
    // Both report the SAME entryId — never two different rows.
    const id1 = (r1.json.data as { entryId: string }).entryId;
    const id2 = (r2.json.data as { entryId: string }).entryId;
    expect(id1).toBe(id2);
    // Exactly ONE new row written total (not two, not zero).
    expect(await countOrgLedgerRows()).toBe(before + 1);
  });
});
