/**
 * Task 11 (CAPSTONE) — cross-owner / cross-org authorization battery (real
 * Postgres, full route -> service -> repo wiring through an in-process Hono
 * app — remittance.integration.test.ts / reverse.integration.test.ts
 * precedent). Complements concurrency.integration.test.ts: THAT file proves
 * the money invariants hold under genuine contention; THIS file proves the
 * authorization boundary holds — an operator correctly scoped to their own
 * org can never read, settle, or leak another owner's (or another org's)
 * money by mixing ids across the ownerPartyId / ownerStatementPeriodId /
 * billingDocumentLineId boundary. This is a single-request authorization
 * concern, not a race — no genuine-overlap harness is needed here (contrast
 * concurrency.integration.test.ts's raceWithOverlapProof).
 *
 * Two DISTINCT attack shapes are both covered under "cross_owner", per the
 * task brief's own parenthetical "(404/403/422 — OWNER_MISMATCH / org-scope)":
 *   (a) SAME org, WRONG owner — the payload's declared ownerPartyId doesn't
 *       match the actual owner of the referenced period/IVOWN line -> 422
 *       OWNER_MISMATCH (an existing per-guard invariant; re-verified here as
 *       part of the cross-owner capstone, PLUS the "no leak" follow-up read
 *       that the OTHER suites don't assert).
 *   (b) DIFFERENT org entirely — an id belonging to another organization is
 *       referenced -> 404 (org-scoped lookup finds nothing) / empty read.
 *
 * Local-DB safety guard + fixed disjoint org uuid ("21" prefix — grep-verified
 * absent from every other integration suite; siblings in this SAME module:
 * 15=repo,16=create,17=allocate,18=offset,19=reverse,20=concurrency).
 *
 * Run:
 *   export DATABASE_URL=$(grep -E '^DATABASE_URL=' .env | head -1 | sed -E 's/^DATABASE_URL=//; s/^"//; s/"$//')
 *   export SESSION_SECRET=$(grep -E '^SESSION_SECRET=' .env | head -1 | sed -E 's/^SESSION_SECRET=//; s/^"//; s/"$//')
 *   RUN_INTEGRATION=1 npx vitest run apps/api/src/modules/owner-remittance/__tests__/authz.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { Hono } from "hono";
import { getDb } from "@kason/db";
import type { Prisma } from "@kason/db";
import type { SessionPayload } from "../../../lib/auth";
import { ownerRemittanceRoutes } from "../owner-remittance.routes";
import { ownerReceivableOffsetRoutes } from "../owner-receivable-offset.routes";
import { computeAvailableOwnerPayableC } from "../owner-remittance.repository";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

// ─── Fixed disjoint UUIDs ("21" prefix; 15=repo,16=create,17=allocate,18=offset,19=reverse,20=concurrency) ─

const ORG = "21000000-0000-4000-8000-0000000000a1";
const OTHER_ORG = "21000000-0000-4000-8000-0000000000c1"; // genuinely DIFFERENT organization
const ACTOR = "21000000-0000-4000-8000-0000000000a2"; // manager actor (real User row — AuditLog FK)
const OWNER_A = "21000000-0000-4000-8000-0000000000a4"; // the owner the operator LEGITIMATELY targets
const OWNER_B = "21000000-0000-4000-8000-0000000000a5"; // same-org cross-owner victim
const OWNER_FOREIGN = "21000000-0000-4000-8000-0000000000a9"; // exists with REAL data only in OTHER_ORG
const PROPERTY = "21000000-0000-4000-8000-0000000000a6";
const IVOWN_SERIES = "21000000-0000-4000-8000-0000000000b1";
// "plain column" placeholder (OwnerLedgerEntry.createdById/updatedById carry
// no real FK — owner-remittance.repository.ts's own docstring convention) —
// no real User row is needed in OTHER_ORG for this raw-seeded foreign row.
const FOREIGN_ACTOR_ID = "21000000-0000-4000-8000-0000000000c2";

const EFFECTIVE_DATE = "2026-01-01";
const PERIOD_MONTH = new Date(Date.UTC(2026, 0, 1));

// ─── Cleanup / seed (FK-safe order; BOTH orgs) ─────────────────────────────

async function cleanup() {
  const db = getDb();
  const orgIds = { organizationId: { in: [ORG, OTHER_ORG] } };
  await db.ownerReceivableOffsetAllocation.deleteMany({ where: orgIds });
  await db.ownerRemittanceAllocation.deleteMany({ where: orgIds });
  await db.ownerLedgerEntry.deleteMany({ where: orgIds });
  await db.ownerStatementPeriod.deleteMany({ where: orgIds });
  await db.billingDocumentLine.deleteMany({ where: { document: { organizationId: { in: [ORG, OTHER_ORG] } } } });
  await db.billingDocument.deleteMany({ where: orgIds });
  await db.charge.deleteMany({ where: orgIds });
  await db.documentSeries.deleteMany({ where: orgIds });
  await db.payment.deleteMany({ where: orgIds }); // must stay empty — cleaned defensively
  await db.auditLog.deleteMany({ where: orgIds }); // before user (Restrict FK)
  await db.property.deleteMany({ where: orgIds });
  await db.party.deleteMany({ where: orgIds });
  await db.user.deleteMany({ where: orgIds });
  await db.organization.deleteMany({ where: { id: { in: [ORG, OTHER_ORG] } } });
}

async function seedOrg() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG,
      name: "T11 Authz Org",
      slug: "t11-authz-org",
      status: "active",
      defaultCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur",
      locale: "en-MY",
      subscriptionPlan: "free",
    },
  });
  // A genuinely SEPARATE organization — nothing seeded inside it beyond the
  // row itself here; individual tests raw-seed whatever OTHER_ORG-scoped
  // data they need (foreign period / foreign owner account).
  await db.organization.create({
    data: {
      id: OTHER_ORG,
      name: "T11 Authz Other Org",
      slug: "t11-authz-other-org",
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
    data: { id: OWNER_A, organizationId: ORG, displayName: "T11 Owner A", partyType: "individual", status: "active" },
  });
  await db.party.create({
    data: { id: OWNER_B, organizationId: ORG, displayName: "T11 Owner B", partyType: "individual", status: "active" },
  });
  await db.user.create({
    data: {
      id: ACTOR,
      organizationId: ORG,
      email: "t11-authz-actor@example.test",
      fullName: "T11 Authz Actor",
      status: "active",
      role: "manager",
      userType: "operator",
    },
  });
  await db.property.create({
    data: {
      id: PROPERTY,
      organizationId: ORG,
      name: "T11 Authz Property",
      propertyCode: "T11A-P1",
      propertyType: "apartment",
      addressLine1: "1 T11A St",
      city: "KL",
      country: "MY",
      status: "active",
      publishStatus: "draft",
    },
  });
  await db.documentSeries.create({
    data: { id: IVOWN_SERIES, organizationId: ORG, code: "IVOWN", prefix: "IVOWN", padding: 4, includeYear: false, active: true },
  });
}

function ledgerRowData(
  overrides: Partial<Prisma.OwnerLedgerEntryUncheckedCreateInput> &
    Pick<Prisma.OwnerLedgerEntryUncheckedCreateInput, "direction" | "category" | "amount" | "ownerPartyId">,
): Prisma.OwnerLedgerEntryUncheckedCreateInput {
  return {
    organizationId: ORG,
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

async function seedIncomeRow(amount: string, ownerPartyId: string) {
  const db = getDb();
  return db.ownerLedgerEntry.create({
    data: ledgerRowData({ direction: "income", category: "rental_income", amount, ownerPartyId }),
  });
}

async function seedPeriod(overrides: Partial<Prisma.OwnerStatementPeriodUncheckedCreateInput> = {}) {
  const db = getDb();
  return db.ownerStatementPeriod.create({
    data: {
      organizationId: ORG,
      ownerPartyId: OWNER_A,
      apartmentId: null,
      periodMonth: PERIOD_MONTH,
      netPayoutC: 100000,
      idempotencyKey: `t11-authz-period-${randomUUID()}`,
      sourceMaxUpdatedAt: PERIOD_MONTH,
      ...overrides,
    },
  });
}

let chargeSeq = 0;
let docSeq = 0;

async function seedIvownInvoice(opts: {
  ownerPartyId: string;
  lines: { amount: string }[];
}): Promise<{ documentId: string; lineIds: string[]; chargeIds: string[] }> {
  const db = getDb();
  docSeq += 1;
  const subtotal = opts.lines.reduce((s, l) => s + Number(l.amount), 0).toFixed(2);
  const doc = await db.billingDocument.create({
    data: {
      organizationId: ORG,
      docType: "invoice",
      documentNumber: `IVOWN-T11A-${docSeq}`,
      seriesId: IVOWN_SERIES,
      counterpartyType: "owner",
      partyId: opts.ownerPartyId,
      propertyId: PROPERTY,
      issuedById: ACTOR,
      subtotal,
      total: subtotal,
      ledgerTreatment: "MANAGER_REVENUE",
      commercialDocumentType: "OWNER_SERVICE_INVOICE",
    },
    select: { id: true },
  });
  const chargeIds: string[] = [];
  const lineIds: string[] = [];
  for (const l of opts.lines) {
    chargeSeq += 1;
    const charge = await db.charge.create({
      data: {
        organizationId: ORG,
        chargeNumber: `T11A-CHG-${chargeSeq}`,
        partyId: opts.ownerPartyId,
        chargeType: "management_fee",
        status: "posted",
        dueDate: new Date(EFFECTIVE_DATE),
        amount: l.amount,
        currency: "MYR",
        outstandingAmount: l.amount,
        attachmentKeys: [],
      },
      select: { id: true },
    });
    chargeIds.push(charge.id);
    const line = await db.billingDocumentLine.create({
      data: { documentId: doc.id, chargeId: charge.id, description: "Management fee", amount: l.amount },
      select: { id: true },
    });
    lineIds.push(line.id);
  }
  return { documentId: doc.id, lineIds, chargeIds };
}

async function chargeOutstanding(chargeId: string): Promise<number> {
  const db = getDb();
  const c = await db.charge.findUniqueOrThrow({ where: { id: chargeId }, select: { outstandingAmount: true } });
  return Number(c.outstandingAmount.toString());
}

async function availableCFor(ownerPartyId: string): Promise<number> {
  return getDb().$transaction((tx) => computeAvailableOwnerPayableC(tx, ORG, ownerPartyId));
}

// ─── Hono app harness — BOTH routers mounted at their REAL app.ts base paths
// (reverse.integration.test.ts precedent) ───────────────────────────────────

const MANAGER: SessionPayload = { userId: ACTOR, orgId: ORG, role: "manager", userType: "operator" };
const EDITOR: SessionPayload = { userId: ACTOR, orgId: ORG, role: "editor", userType: "operator" };

function makeApp(session: SessionPayload) {
  const app = new Hono<{ Variables: { session: SessionPayload } }>();
  app.use("*", async (c, next) => {
    c.set("session", session);
    await next();
  });
  app.route("/api/owner-remittances", ownerRemittanceRoutes);
  app.route("/api/owner-receivable-offsets", ownerReceivableOffsetRoutes);
  return app;
}

async function httpRequest(method: "GET" | "POST", path: string, body: unknown, session: SessionPayload) {
  const app = makeApp(session);
  const init: RequestInit = { method };
  if (method === "POST") {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body ?? {});
  }
  const res = await app.request(path, init);
  // Robust to a non-JSON error body (Hono's plain-text 500 default page for an
  // unhandled throw) so an unexpected failure surfaces as a status-code
  // mismatch, never a JSON.parse crash in the test itself.
  const text = await res.text();
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = { _rawBody: text };
  }
  return { status: res.status, json };
}

type RemittancePayload = {
  ownerPartyId: string;
  amount: string;
  effectiveDate: string;
  settlementKind: "OWNER_REMITTANCE" | "PRE_STATEMENT_REMITTANCE";
  paymentMethod: "bank_transfer" | "cash" | "cheque" | "other";
  currency: string;
  allocations: { ownerStatementPeriodId: string; allocatedAmount: string }[];
  idempotencyKey: string;
};

function remittancePayload(overrides: Partial<RemittancePayload> = {}): RemittancePayload {
  return {
    ownerPartyId: OWNER_A,
    amount: "100.00",
    effectiveDate: EFFECTIVE_DATE,
    settlementKind: "OWNER_REMITTANCE",
    paymentMethod: "cash",
    currency: "MYR",
    allocations: [],
    idempotencyKey: randomUUID(),
    ...overrides,
  };
}

type OffsetPayload = {
  ownerPartyId: string;
  effectiveDate: string;
  currency: string;
  lineAllocations: { billingDocumentLineId: string; allocatedAmount: string }[];
  idempotencyKey: string;
};

function offsetPayload(overrides: Partial<OffsetPayload> = {}): OffsetPayload {
  return {
    ownerPartyId: OWNER_A,
    effectiveDate: EFFECTIVE_DATE,
    currency: "MYR",
    lineAllocations: [],
    idempotencyKey: randomUUID(),
    ...overrides,
  };
}

async function postRemittance(payload: RemittancePayload, session: SessionPayload = MANAGER) {
  return httpRequest("POST", "/api/owner-remittances", payload, session);
}
async function postOffset(payload: OffsetPayload, session: SessionPayload = MANAGER) {
  return httpRequest("POST", "/api/owner-receivable-offsets", payload, session);
}
async function getOwnerAccount(ownerPartyId: string, session: SessionPayload = MANAGER) {
  return httpRequest("GET", `/api/owner-remittances/owner/${ownerPartyId}`, undefined, session);
}

dn("owner-remittance — Task 11 cross-owner / cross-org authz battery", () => {
  beforeEach(async () => {
    process.env.ENABLE_PHASE2_OWNER_REMITTANCE = "true";
    await cleanup();
    await seedOrg();
    await seedBase();
  });

  afterAll(async () => {
    await cleanup();
  });

  // ── cross_owner (a): SAME org, WRONG owner — remittance ────────────────────

  it("(cross_owner) remittance allocation into a DIFFERENT owner's period (same org) — 422 OWNER_MISMATCH, owner B's payable unchanged (no leak)", async () => {
    await seedIncomeRow("1000.00", OWNER_A); // availableC(A) = 100000
    await seedIncomeRow("200.00", OWNER_B); // OWNER_B has a REAL payable of its own to prove untouched
    const ownerBPeriod = await seedPeriod({ ownerPartyId: OWNER_B, netPayoutC: 100000 });

    const beforeB = await availableCFor(OWNER_B);
    expect(beforeB).toBe(20000);

    const { status, json } = await postRemittance(
      remittancePayload({
        ownerPartyId: OWNER_A, // operator CLAIMS to be paying owner A...
        allocations: [{ ownerStatementPeriodId: ownerBPeriod.id, allocatedAmount: "100.00" }], // ...but targets owner B's period
      }),
    );

    expect(status).toBe(422);
    expect(json).toEqual({ error: "OWNER_MISMATCH" });

    // NO leak: owner B's payable is byte-identical to before the attempt.
    expect(await availableCFor(OWNER_B)).toBe(beforeB);
    const db = getDb();
    expect(await db.ownerLedgerEntry.count({ where: { organizationId: ORG, settlementKind: "OWNER_REMITTANCE" } })).toBe(0);
    expect(await db.ownerRemittanceAllocation.count({ where: { organizationId: ORG } })).toBe(0);
  });

  // ── cross_owner (a): SAME org, WRONG owner — offset ─────────────────────────

  it("(cross_owner) offset settling a DIFFERENT owner's IVOWN line (same org) — 422 OWNER_MISMATCH, owner B's charge unchanged (no settle leak)", async () => {
    await seedIncomeRow("1000.00", OWNER_A); // availableC(A) = 100000 — plenty, isolates OWNER_MISMATCH from OFFSET_EXCEEDS_PAYABLE
    const invB = await seedIvownInvoice({ ownerPartyId: OWNER_B, lines: [{ amount: "60.00" }] });

    const { status, json } = await postOffset(
      offsetPayload({
        ownerPartyId: OWNER_A, // operator CLAIMS to be settling owner A's payable...
        lineAllocations: [{ billingDocumentLineId: invB.lineIds[0]!, allocatedAmount: "60.00" }], // ...but targets owner B's IVOWN line
      }),
    );

    expect(status).toBe(422);
    expect(json).toEqual({ error: "OWNER_MISMATCH" });

    // NO settle leak: owner B's charge is untouched.
    expect(await chargeOutstanding(invB.chargeIds[0]!)).toBe(60);
    const db = getDb();
    expect(await db.ownerLedgerEntry.count({ where: { organizationId: ORG, settlementKind: "OWNER_RECEIVABLE_OFFSET" } })).toBe(0);
    expect(await db.ownerReceivableOffsetAllocation.count({ where: { organizationId: ORG } })).toBe(0);
    expect(await db.payment.count({ where: { organizationId: ORG } })).toBe(0);
  });

  // ── cross_owner (b): DIFFERENT organization entirely — write side ──────────

  it("(cross_owner) allocation referencing a period from a DIFFERENT organization — 404, nothing written, the foreign org's period stays byte-unchanged", async () => {
    await seedIncomeRow("1000.00", OWNER_A);
    const db = getDb();
    const foreignPeriod = await db.ownerStatementPeriod.create({
      data: {
        organizationId: OTHER_ORG,
        ownerPartyId: OWNER_FOREIGN,
        apartmentId: null,
        periodMonth: PERIOD_MONTH,
        netPayoutC: 999900,
        idempotencyKey: `t11-authz-foreign-period-${randomUUID()}`,
        sourceMaxUpdatedAt: PERIOD_MONTH,
      },
    });
    const before = await db.ownerStatementPeriod.findUniqueOrThrow({ where: { id: foreignPeriod.id } });
    const before_ = JSON.stringify(before);

    const { status, json } = await postRemittance(
      remittancePayload({
        ownerPartyId: OWNER_A,
        allocations: [{ ownerStatementPeriodId: foreignPeriod.id, allocatedAmount: "100.00" }], // id belongs to OTHER_ORG
      }),
    );

    expect(status).toBe(404);
    expect(json).toEqual({ error: "OWNER_STATEMENT_PERIOD_NOT_FOUND" });

    // Org-scoped lookup found NOTHING — the foreign org's own row is untouched.
    const after = await db.ownerStatementPeriod.findUniqueOrThrow({ where: { id: foreignPeriod.id } });
    expect(JSON.stringify(after)).toBe(before_);
    expect(await db.ownerLedgerEntry.count({ where: { organizationId: ORG } })).toBe(1); // only the seedIncomeRow above — nothing new
  });

  // ── cross_owner (b): DIFFERENT organization entirely — read side ───────────

  it("(cross_owner) GET owner-account for a foreign-org owner — 200 with EMPTY entries/periods, never leaks the other org's real data", async () => {
    const db = getDb();
    // Seed REAL Phase-2 data for OWNER_FOREIGN, entirely within OTHER_ORG.
    await db.ownerLedgerEntry.create({
      data: {
        organizationId: OTHER_ORG,
        ownerPartyId: OWNER_FOREIGN,
        propertyId: null,
        statementMonth: PERIOD_MONTH,
        transactionDate: PERIOD_MONTH,
        direction: "payout",
        category: "owner_payout",
        amount: "75.00",
        paidBy: "kaen",
        includeInPayout: false,
        taxCategory: "not_applicable",
        status: "active",
        settlementKind: "OWNER_REMITTANCE",
        paymentMethod: "cash",
        idempotencyKey: `t11-authz-foreign-entry-${randomUUID()}`,
        requestFingerprint: "seed-fingerprint-foreign",
        createdById: FOREIGN_ACTOR_ID,
        updatedById: FOREIGN_ACTOR_ID,
      },
    });
    await db.ownerStatementPeriod.create({
      data: {
        organizationId: OTHER_ORG,
        ownerPartyId: OWNER_FOREIGN,
        apartmentId: null,
        periodMonth: PERIOD_MONTH,
        netPayoutC: 50000,
        idempotencyKey: `t11-authz-foreign-period2-${randomUUID()}`,
        sourceMaxUpdatedAt: PERIOD_MONTH,
      },
    });
    // Sanity: the data genuinely exists — this test would be vacuous otherwise.
    expect(await db.ownerLedgerEntry.count({ where: { organizationId: OTHER_ORG, ownerPartyId: OWNER_FOREIGN } })).toBe(1);
    expect(await db.ownerStatementPeriod.count({ where: { organizationId: OTHER_ORG, ownerPartyId: OWNER_FOREIGN } })).toBe(1);

    // An ORG-scoped session (session.orgId = ORG, NOT OTHER_ORG) asks for that SAME ownerPartyId.
    const { status, json } = await getOwnerAccount(OWNER_FOREIGN);

    expect(status).toBe(200);
    expect(json).toEqual({ data: { entries: [], periods: [] } }); // NEVER leaks OTHER_ORG's real rows
  });

  // ── supplementary: flag-gate (brief: "assert the flag-off -> 404") ─────────

  it("(F1) flag-off — canonical 404, before auth is even evaluated", async () => {
    process.env.ENABLE_PHASE2_OWNER_REMITTANCE = "false";
    const { status, json } = await postRemittance(remittancePayload(), EDITOR); // EDITOR would 403 if the flag gate didn't fire FIRST
    expect(status).toBe(404);
    expect(json).toEqual({ error: "not_found" });
  });

  // ── supplementary: role denial (brief: "a non-accounting/manager role denied if easy") ─

  it("(P1) a role with neither the accounting workspace nor rank>=manager (editor) — 403 on every mutating endpoint", async () => {
    await seedIncomeRow("1000.00", OWNER_A);
    const period = await seedPeriod({ netPayoutC: 100000 });
    const remit = await postRemittance(
      remittancePayload({ allocations: [{ ownerStatementPeriodId: period.id, allocatedAmount: "100.00" }] }),
      EDITOR,
    );
    expect(remit.status).toBe(403);

    const inv = await seedIvownInvoice({ ownerPartyId: OWNER_A, lines: [{ amount: "60.00" }] });
    const offset = await postOffset(
      offsetPayload({ lineAllocations: [{ billingDocumentLineId: inv.lineIds[0]!, allocatedAmount: "60.00" }] }),
      EDITOR,
    );
    expect(offset.status).toBe(403);

    const read = await getOwnerAccount(OWNER_A, EDITOR);
    expect(read.status).toBe(403);
  });
});
