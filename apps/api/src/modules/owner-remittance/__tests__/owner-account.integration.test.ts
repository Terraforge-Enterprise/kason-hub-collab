/**
 * Task 10 integration tests — GET /owner-remittances/owner/:ownerPartyId
 * (real Postgres, full route→service wiring through an in-process Hono app —
 * remittance.integration.test.ts / allocate.integration.test.ts precedent).
 *
 * Read-only endpoint: (a) every Phase-2 OwnerLedgerEntry (settlementKind set)
 * for the owner, org-scoped; (b) per-OwnerStatementPeriod derived remittance
 * status (owner-remittance.status.ts's derivePeriodRemittanceStatus, reusing
 * periodRemainingPayableC — the Task-5 rail — for "active" allocation, never
 * re-derived here).
 *
 * The PRIMARY acceptance test (two_axes) proves the module's whole point:
 * BillingDocument.settlementStatus (an invoice's PAYMENT status) and a
 * period's remittanceStatus (this task's NEW axis) are computed from
 * completely disjoint tables and never merged — a tenant can have paid in
 * full while the owner is still awaiting remittance, simultaneously.
 *
 * Local-DB safety guard + fixed disjoint org uuid ("1a" prefix — grep-verified
 * absent from every other integration suite; 15=Task-5 repo, 16=Task-6
 * create, 17=Task-7 allocate, 18=Task-8 offset, 19=Task-9 reverse) mirrors
 * every sibling suite in this module.
 *
 * Run:
 *   export DATABASE_URL=$(grep -E '^DATABASE_URL=' .env | head -1 | sed -E 's/^DATABASE_URL=//; s/^"//; s/"$//')
 *   export SESSION_SECRET=$(grep -E '^SESSION_SECRET=' .env | head -1 | sed -E 's/^SESSION_SECRET=//; s/^"//; s/"$//')
 *   RUN_INTEGRATION=1 npx vitest run apps/api/src/modules/owner-remittance/__tests__/owner-account.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { Hono } from "hono";
import { getDb } from "@kason/db";
import type { Prisma } from "@kason/db";
import type { SessionPayload } from "../../../lib/auth";
import { ownerRemittanceRoutes } from "../owner-remittance.routes";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

// ─── Fixed disjoint UUIDs ("1a" prefix; see header for sibling prefixes) ──────

const ORG = "1a000000-0000-4000-8000-0000000000a1";
const OTHER_ORG = "1a000000-0000-4000-8000-0000000000c1";
const ACTOR = "1a000000-0000-4000-8000-0000000000a2"; // manager actor (real User row)
const OWNER = "1a000000-0000-4000-8000-0000000000a4";
const OWNER2 = "1a000000-0000-4000-8000-0000000000a5"; // cross-owner isolation
const TENANT = "1a000000-0000-4000-8000-0000000000a6"; // rent invoice's partyId
const IVTEN_SERIES = "1a000000-0000-4000-8000-0000000000b1";

const PERIOD_MONTH = new Date(Date.UTC(2026, 6, 1)); // July 2026 — "a July rent invoice"

// ─── Cleanup / seed (FK-safe order) ───────────────────────────────────────────

async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  const otherOrg = { organizationId: OTHER_ORG };
  await db.ownerRemittanceAllocation.deleteMany({ where: org });
  await db.ownerLedgerEntry.deleteMany({ where: org });
  await db.ownerStatementPeriod.deleteMany({ where: org });
  await db.billingDocument.deleteMany({ where: org });
  await db.ownerRemittanceAllocation.deleteMany({ where: otherOrg });
  await db.ownerLedgerEntry.deleteMany({ where: otherOrg });
  await db.ownerStatementPeriod.deleteMany({ where: otherOrg });
  await db.billingDocument.deleteMany({ where: otherOrg });
  await db.documentSeries.deleteMany({ where: org });
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
      name: "T10 Owner-Account Org",
      slug: "t10-owner-account-org",
      status: "active",
      defaultCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur",
      locale: "en-MY",
      subscriptionPlan: "free",
    },
  });
}

// OTHER_ORG needs only an Organization row: OwnerLedgerEntry.ownerPartyId,
// createdById/updatedById are plain columns (no FK — verified in
// owner-remittance.repository.ts's own docstrings + schema.prisma comments),
// so E9 (cross-org isolation) reuses OWNER's id and ACTOR's id directly
// without needing a real Party/User row scoped to OTHER_ORG.
async function seedOtherOrg() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: OTHER_ORG,
      name: "T10 Other Org",
      slug: "t10-other-org",
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
    data: { id: OWNER, organizationId: ORG, displayName: "T10 Owner", partyType: "individual", status: "active" },
  });
  await db.party.create({
    data: { id: OWNER2, organizationId: ORG, displayName: "T10 Owner 2", partyType: "individual", status: "active" },
  });
  await db.party.create({
    data: { id: TENANT, organizationId: ORG, displayName: "T10 Tenant", partyType: "individual", status: "active" },
  });
  await db.user.create({
    data: {
      id: ACTOR,
      organizationId: ORG,
      email: "t10-actor@example.test",
      fullName: "T10 Actor",
      status: "active",
      role: "manager",
      userType: "operator",
    },
  });
  await db.documentSeries.create({
    data: { id: IVTEN_SERIES, organizationId: ORG, code: "IVTEN", prefix: "IVTEN", padding: 4, includeYear: false, active: true },
  });
}

/** Raw-seed a Phase-2 OwnerLedgerEntry (payout) row — direction/category/kind
 *  defaults match a plain OWNER_REMITTANCE; override settlementKind/amount/
 *  reversalOfEntryId/ownerPartyId etc. per test. */
function ledgerRowData(
  overrides: Partial<Prisma.OwnerLedgerEntryUncheckedCreateInput> = {},
): Prisma.OwnerLedgerEntryUncheckedCreateInput {
  return {
    organizationId: ORG,
    ownerPartyId: OWNER,
    propertyId: null,
    statementMonth: PERIOD_MONTH,
    transactionDate: PERIOD_MONTH,
    direction: "payout",
    category: "owner_payout",
    amount: "100.00",
    paidBy: "kaen",
    includeInPayout: false,
    status: "active",
    settlementKind: "OWNER_REMITTANCE",
    paymentMethod: "bank_transfer",
    idempotencyKey: randomUUID(),
    requestFingerprint: "t10-fixture-fingerprint",
    createdById: ACTOR,
    updatedById: ACTOR,
    ...overrides,
  };
}

async function seedEntry(overrides: Partial<Prisma.OwnerLedgerEntryUncheckedCreateInput> = {}) {
  return getDb().ownerLedgerEntry.create({ data: ledgerRowData(overrides) });
}

/** Raw-seed an OwnerStatementPeriod — combined scope (apartmentId:null) by
 *  default so no Property/Apartment rows are needed for this suite. */
async function seedPeriod(overrides: Partial<Prisma.OwnerStatementPeriodUncheckedCreateInput> = {}) {
  return getDb().ownerStatementPeriod.create({
    data: {
      organizationId: ORG,
      ownerPartyId: OWNER,
      apartmentId: null,
      periodMonth: PERIOD_MONTH,
      netPayoutC: 100_000,
      idempotencyKey: `t10-period-${randomUUID()}`,
      sourceMaxUpdatedAt: PERIOD_MONTH,
      ...overrides,
    },
  });
}

async function seedAllocation(payoutEntryId: string, ownerStatementPeriodId: string, allocatedAmountC: number) {
  return getDb().ownerRemittanceAllocation.create({
    data: { organizationId: ORG, payoutEntryId, ownerStatementPeriodId, allocatedAmountC, createdById: ACTOR },
  });
}

/** Raw-seed a July rent invoice (IVTEN, tenant-facing) — settlementStatus is
 *  set DIRECTLY (simulating "tenant already paid in full") rather than
 *  routed through the real payment-allocation engine: settlementStatus
 *  derivation itself is a DIFFERENT, already-shipped, already-tested axis
 *  (BillingDocument.settlementStatus) that this task must NOT touch or
 *  re-derive — only prove this endpoint never looks at or influences it. */
let docSeq = 0;
async function seedRentInvoice(settlementStatus: string, partyId: string = TENANT) {
  docSeq += 1;
  return getDb().billingDocument.create({
    data: {
      organizationId: ORG,
      docType: "invoice",
      documentNumber: `IVTEN-T10-${docSeq}`,
      seriesId: IVTEN_SERIES,
      counterpartyType: "tenant",
      partyId,
      billingMonth: PERIOD_MONTH,
      issuedById: ACTOR,
      subtotal: "1000.00",
      total: "1000.00",
      settlementStatus,
      ledgerTreatment: "PAYABLE_TO_OWNER",
      commercialDocumentType: "RENTAL_INVOICE",
    },
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

async function getAccount(ownerPartyId: string, session: SessionPayload = MANAGER) {
  const app = makeApp(session);
  const res = await app.request(`/owner/${ownerPartyId}`, { method: "GET" });
  const text = await res.text();
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = { _rawBody: text };
  }
  return { status: res.status, json };
}

type AccountData = {
  entries: Record<string, unknown>[];
  periods: Record<string, unknown>[];
};

dn("GET /owner-remittances/owner/:ownerPartyId — Task 10 integration", () => {
  beforeEach(async () => {
    process.env.ENABLE_PHASE2_OWNER_REMITTANCE = "true";
    await cleanup();
    await seedOrg();
    await seedBase();
  });

  afterAll(async () => {
    await cleanup();
  });

  // ── Cycle 1 (tracer bullet): malformed id + valid-but-empty owner ──────────

  it("(E10 malformed_owner_party_id) non-UUID :ownerPartyId — 400 INVALID_OWNER_PARTY_ID, no 500", async () => {
    const { status, json } = await getAccount("not-a-uuid");
    expect(status).toBe(400);
    expect(json).toEqual({ error: "INVALID_OWNER_PARTY_ID" });
  });

  it("(tracer) valid owner with no data at all — 200, empty entries and periods", async () => {
    const { status, json } = await getAccount(OWNER);
    expect(status).toBe(200);
    expect(json).toEqual({ data: { entries: [], periods: [] } });
  });

  // ── Cycle 2: entries query (settlementKind filter, reversal inclusion) ─────

  it("(E5 all_settlement_kinds) entries include OWNER_REMITTANCE, PRE_STATEMENT_REMITTANCE, and OWNER_RECEIVABLE_OFFSET rows", async () => {
    await seedEntry({ settlementKind: "OWNER_REMITTANCE", idempotencyKey: randomUUID() });
    await seedEntry({ settlementKind: "PRE_STATEMENT_REMITTANCE", idempotencyKey: randomUUID() });
    await seedEntry({ settlementKind: "OWNER_RECEIVABLE_OFFSET", paymentMethod: null, idempotencyKey: randomUUID() });

    const { status, json } = await getAccount(OWNER);
    expect(status).toBe(200);
    const data = json.data as AccountData;
    const kinds = data.entries.map((e) => e.settlementKind).sort();
    expect(kinds).toEqual(["OWNER_RECEIVABLE_OFFSET", "OWNER_REMITTANCE", "PRE_STATEMENT_REMITTANCE"]);
  });

  it("(E6 reversal_entries_included) a reversal entry (reversalOfEntryId set) appears in entries", async () => {
    const original = await seedEntry({ idempotencyKey: randomUUID() });
    const reversal = await seedEntry({
      idempotencyKey: randomUUID(),
      reversalOfEntryId: original.id,
      memo: "reversal reason",
    });

    const { status, json } = await getAccount(OWNER);
    expect(status).toBe(200);
    const data = json.data as AccountData;
    expect(data.entries).toHaveLength(2);
    const found = data.entries.find((e) => e.id === reversal.id);
    expect(found?.reversalOfEntryId).toBe(original.id);
  });

  it("(E7 legacy_entries_excluded) a settlementKind:null (legacy/sync) row is excluded", async () => {
    await seedEntry({ settlementKind: null, idempotencyKey: null, requestFingerprint: null });
    await seedEntry({ settlementKind: "OWNER_REMITTANCE", idempotencyKey: randomUUID() });

    const { status, json } = await getAccount(OWNER);
    expect(status).toBe(200);
    const data = json.data as AccountData;
    expect(data.entries).toHaveLength(1);
    expect(data.entries[0]?.settlementKind).toBe("OWNER_REMITTANCE");
  });

  it("(E12 no_field_leak) entry/period DTOs expose only the allowlisted keys — no idempotencyKey/requestFingerprint/snapshotJson", async () => {
    await seedEntry({
      bankReference: "BR-1",
      proofKey: "proofs/x.pdf",
      proofStatus: "PROOF_ATTACHED",
      memo: "test memo",
      idempotencyKey: randomUUID(),
      requestFingerprint: "sensitive-fingerprint-should-not-leak",
    });
    await seedPeriod();

    const { status, json } = await getAccount(OWNER);
    expect(status).toBe(200);
    const data = json.data as AccountData;
    expect(data.entries).toHaveLength(1);
    expect(data.periods).toHaveLength(1);

    expect(Object.keys(data.entries[0]!).sort()).toEqual(
      [
        "amount",
        "apartmentId",
        "bankReference",
        "createdAt",
        "id",
        "memo",
        "ownerPartyId",
        "paymentMethod",
        "propertyId",
        "proofKey",
        "proofStatus",
        "reversalOfEntryId",
        "settlementKind",
        "statementMonth",
        "status",
        "transactionDate",
      ].sort(),
    );
    expect(Object.keys(data.periods[0]!).sort()).toEqual(
      ["allocatedActiveC", "apartmentId", "id", "netPayoutC", "periodMonth", "periodStatus", "remittanceStatus"].sort(),
    );

    const raw = JSON.stringify(json);
    expect(raw).not.toContain("idempotencyKey");
    expect(raw).not.toContain("requestFingerprint");
    expect(raw).not.toContain("sensitive-fingerprint-should-not-leak");
  });

  // ── Cycle 3: periods query + status derivation wiring ──────────────────────

  it("(two_axes) July rent invoice fully PAID by the tenant but the owner period NOT remitted — invoice settlementStatus=PAID AND period remittanceStatus=AWAITING_REMITTANCE (distinct axes)", async () => {
    const invoice = await seedRentInvoice("PAID");
    const period = await seedPeriod({ netPayoutC: 100_000 }); // zero allocations

    const { status, json } = await getAccount(OWNER);

    expect(status).toBe(200);
    const data = json.data as AccountData;
    expect(data.periods).toHaveLength(1);
    expect(data.periods[0]).toMatchObject({
      id: period.id,
      netPayoutC: 100_000,
      allocatedActiveC: 0,
      remittanceStatus: "AWAITING_REMITTANCE",
    });
    // No remittance has been recorded yet for this owner — entries stays empty.
    expect(data.entries).toEqual([]);

    // Independently: the invoice's OWN settlementStatus is untouched by this
    // endpoint — read directly from the DB (the endpoint never returns or
    // looks at BillingDocument at all). BOTH facts hold simultaneously.
    const reread = await getDb().billingDocument.findUnique({ where: { id: invoice.id } });
    expect(reread?.settlementStatus).toBe("PAID");
  });

  it("(E4 no_payable_period) a period with netPayoutC=0 — remittanceStatus=NO_PAYABLE", async () => {
    const period = await seedPeriod({ netPayoutC: 0 });

    const { status, json } = await getAccount(OWNER);
    expect(status).toBe(200);
    const data = json.data as AccountData;
    const found = data.periods.find((p) => p.id === period.id);
    expect(found).toMatchObject({ netPayoutC: 0, allocatedActiveC: 0, remittanceStatus: "NO_PAYABLE" });
  });

  it("(E2 partially_remitted_period) a period with a partial ACTIVE allocation — remittanceStatus=PARTIALLY_REMITTED", async () => {
    const entry = await seedEntry({ amount: "400.00", idempotencyKey: randomUUID() }); // 40000c
    const period = await seedPeriod({ netPayoutC: 100_000 });
    await seedAllocation(entry.id, period.id, 40_000);

    const { status, json } = await getAccount(OWNER);
    expect(status).toBe(200);
    const data = json.data as AccountData;
    const found = data.periods.find((p) => p.id === period.id);
    expect(found).toMatchObject({ netPayoutC: 100_000, allocatedActiveC: 40_000, remittanceStatus: "PARTIALLY_REMITTED" });
  });

  it("(E3 fully_remitted_period) a period fully allocated (active) — remittanceStatus=FULLY_REMITTED", async () => {
    const entry = await seedEntry({ amount: "1000.00", idempotencyKey: randomUUID() }); // 100000c
    const period = await seedPeriod({ netPayoutC: 100_000 });
    await seedAllocation(entry.id, period.id, 100_000);

    const { status, json } = await getAccount(OWNER);
    expect(status).toBe(200);
    const data = json.data as AccountData;
    const found = data.periods.find((p) => p.id === period.id);
    expect(found).toMatchObject({ netPayoutC: 100_000, allocatedActiveC: 100_000, remittanceStatus: "FULLY_REMITTED" });
  });

  it("(E11 entries_without_periods) owner has settlement entries but zero OwnerStatementPeriod rows — entries populated, periods empty", async () => {
    await seedEntry({ idempotencyKey: randomUUID() });

    const { status, json } = await getAccount(OWNER);
    expect(status).toBe(200);
    const data = json.data as AccountData;
    expect(data.entries).toHaveLength(1);
    expect(data.periods).toEqual([]);
  });

  // ── Cycle 4: isolation (org+owner scoping on every query) ──────────────────

  it("(E8 cross_owner_isolation) owner B's entries and periods are not returned when requesting owner A", async () => {
    await seedEntry({ ownerPartyId: OWNER, idempotencyKey: randomUUID() });
    await seedPeriod({ ownerPartyId: OWNER });
    await seedEntry({ ownerPartyId: OWNER2, idempotencyKey: randomUUID() });
    await seedPeriod({ ownerPartyId: OWNER2 });

    const { status, json } = await getAccount(OWNER);
    expect(status).toBe(200);
    const data = json.data as AccountData;
    expect(data.entries).toHaveLength(1);
    expect(data.entries.every((e) => e.ownerPartyId === OWNER)).toBe(true);
    expect(data.periods).toHaveLength(1);
  });

  it("(E9 cross_org_isolation) another org's data under the SAME ownerPartyId value does not leak into this org's response", async () => {
    await seedOtherOrg();
    // Raw-seeded directly in OTHER_ORG, reusing OWNER's uuid — ownerPartyId/
    // createdById/updatedById carry no FK (schema.prisma comments), so this
    // is valid without a Party/User row scoped to OTHER_ORG.
    await getDb().ownerLedgerEntry.create({
      data: ledgerRowData({ organizationId: OTHER_ORG, ownerPartyId: OWNER, idempotencyKey: randomUUID() }),
    });
    await getDb().ownerStatementPeriod.create({
      data: {
        organizationId: OTHER_ORG,
        ownerPartyId: OWNER,
        apartmentId: null,
        periodMonth: PERIOD_MONTH,
        netPayoutC: 999_999,
        idempotencyKey: `t10-other-org-period-${randomUUID()}`,
        sourceMaxUpdatedAt: PERIOD_MONTH,
      },
    });
    // ORG's own (empty) data for OWNER stays empty — the leak check is that
    // OTHER_ORG's rows above do NOT show up in an ORG-scoped request.

    const { status, json } = await getAccount(OWNER); // session is ORG (MANAGER default)
    expect(status).toBe(200);
    expect(json).toEqual({ data: { entries: [], periods: [] } });
  });

  // ── Cycle 5: permission ─────────────────────────────────────────────────────

  it("(E15 editor_denied) a role with neither the accounting workspace nor rank>=manager (editor) — 403", async () => {
    const { status } = await getAccount(OWNER, EDITOR);
    expect(status).toBe(403);
  });

  it("(E16 accountant_workspace_only) accountant (workspace path, rank<manager) reaches the route — 200", async () => {
    const { status } = await getAccount(OWNER, ACCOUNTANT);
    expect(status).toBe(200);
  });

  // ── Cycle 6: flag gate ───────────────────────────────────────────────────────

  it("(E14 flag_gate_dark) flag off — canonical 404, before auth is even evaluated", async () => {
    process.env.ENABLE_PHASE2_OWNER_REMITTANCE = "false";
    const { status, json } = await getAccount(OWNER, EDITOR); // EDITOR would 403 if the flag gate didn't fire FIRST
    expect(status).toBe(404);
    expect(json).toEqual({ error: "not_found" });
  });
});
