/**
 * Task 9 integration tests — POST /owner-remittances/:id/reverse and
 * POST /owner-receivable-offsets/:id/reverse (real Postgres, full
 * route→service→repo wiring through an in-process Hono app —
 * remittance.integration.test.ts / offset.integration.test.ts precedent).
 *
 * ⚠️ MONEY-CRITICAL: a reversal is APPEND-ONLY (a SECOND OwnerLedgerEntry
 * with reversalOfEntryId, never a mutation of the original) and must
 * restore payable — and, for an offset, the settled charge's outstanding —
 * EXACTLY ONCE. offset_reverse_unit_check below is the load-bearing test
 * that pins the cents->RM unit boundary on restoreChargeTx (see
 * reverseOffsetService's own docstring, owner-remittance.service.ts, for the
 * full contract) using a PARTIALLY-outstanding charge specifically because a
 * fully-settled-to-0 charge can't distinguish a 100x bug from correct
 * behavior (both clamp to the same chargeAmount ceiling — see that test's
 * own comment). double_reverse is the load-bearing test for the
 * ALREADY_REVERSED single-active-reversal guard that prevents a double
 * payable-restore.
 *
 * Local-DB safety guard + fixed disjoint org uuid ("19" prefix — grep-verified
 * absent from every other integration suite; 15=Task-5 repo, 16=Task-6
 * create, 17=Task-7 allocate, 18=Task-8 offset) mirror the sibling suites.
 *
 * Run:
 *   export DATABASE_URL=$(grep -E '^DATABASE_URL=' .env | head -1 | sed -E 's/^DATABASE_URL=//; s/^"//; s/"$//')
 *   export SESSION_SECRET=$(grep -E '^SESSION_SECRET=' .env | head -1 | sed -E 's/^SESSION_SECRET=//; s/^"//; s/"$//')
 *   RUN_INTEGRATION=1 npx vitest run apps/api/src/modules/owner-remittance/__tests__/reverse.integration.test.ts
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

// ─── Fixed disjoint UUIDs ("19" prefix; 15=repo, 16=create, 17=allocate, 18=offset) ─

const ORG = "19000000-0000-4000-8000-0000000000a1";
const ACTOR = "19000000-0000-4000-8000-0000000000a2"; // accounting-staff actor (real User row — AuditLog FK)
const OWNER_USER = "19000000-0000-4000-8000-0000000000a3"; // owner's portal User (for notify assertions)
const OWNER = "19000000-0000-4000-8000-0000000000a4";
const PROPERTY = "19000000-0000-4000-8000-0000000000a6";
const IVOWN_SERIES = "19000000-0000-4000-8000-0000000000b1";

const EFFECTIVE_DATE = "2026-01-01"; // month M — deliberately in the past relative to "now" in this dev environment
const PERIOD_MONTH = new Date(Date.UTC(2026, 0, 1));

// ─── Cleanup / seed (FK-safe order — mirrors remittance+offset integration
// suites combined: offset allocations before ledger AND before charge;
// remittance allocations before ledger AND before period; AuditLog.actor is
// onDelete:Restrict) ─────────────────────────────────────────────────────

async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  await db.notification.deleteMany({ where: org });
  await db.ownerReceivableOffsetAllocation.deleteMany({ where: org });
  await db.ownerRemittanceAllocation.deleteMany({ where: org });
  await db.ownerLedgerEntry.deleteMany({ where: org });
  await db.ownerStatementPeriod.deleteMany({ where: org });
  await db.billingDocumentLine.deleteMany({ where: { document: { organizationId: ORG } } });
  await db.billingDocument.deleteMany({ where: org });
  await db.charge.deleteMany({ where: org });
  await db.documentSeries.deleteMany({ where: org });
  await db.payment.deleteMany({ where: org }); // must stay empty — cleaned defensively
  await db.auditLog.deleteMany({ where: org }); // before user (Restrict FK)
  await db.property.deleteMany({ where: org });
  await db.party.deleteMany({ where: org });
  await db.user.deleteMany({ where: org });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function seedOrg(currency = "MYR") {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG,
      name: "T9 Reverse Org",
      slug: "t9-reverse-org",
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
    data: { id: OWNER, organizationId: ORG, displayName: "T9 Owner", partyType: "individual", status: "active" },
  });
  await db.user.create({
    data: { id: ACTOR, organizationId: ORG, email: "t9-actor@example.test", fullName: "T9 Actor", status: "active", role: "manager", userType: "operator" },
  });
  // Owner's portal User — required by notifyOwnerOfReversal to create the notification.
  await db.user.create({
    data: { id: OWNER_USER, organizationId: ORG, partyId: OWNER, email: "t9-owner@example.test", fullName: "T9 Owner Portal", status: "active", role: "owner", userType: "owner" },
  });
  await db.property.create({
    data: { id: PROPERTY, organizationId: ORG, name: "T9 Property", propertyCode: "T9-P1", propertyType: "apartment", addressLine1: "1 T9 St", city: "KL", country: "MY", status: "active", publishStatus: "draft" },
  });
  await db.documentSeries.create({
    data: { id: IVOWN_SERIES, organizationId: ORG, code: "IVOWN", prefix: "IVOWN", padding: 4, includeYear: false, active: true },
  });
}

/** Raw-seed an active OwnerLedgerEntry income row so computeAvailableOwnerPayableC has payable to draw from (Task-5/6 precedent). */
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

async function seedIncomeRow(amount: string) {
  const db = getDb();
  return db.ownerLedgerEntry.create({
    data: ledgerRowData({ direction: "income", category: "rental_income", amount }),
  });
}

/** Raw-seed an OwnerStatementPeriod (combined scope — apartmentId:null — this
 *  suite doesn't exercise propertyId derivation, already covered by Task 6's
 *  own suite, so no real Apartment row is needed). */
async function seedPeriod(overrides: Partial<Prisma.OwnerStatementPeriodUncheckedCreateInput> = {}) {
  const db = getDb();
  return db.ownerStatementPeriod.create({
    data: {
      organizationId: ORG,
      ownerPartyId: OWNER,
      apartmentId: null,
      periodMonth: PERIOD_MONTH,
      netPayoutC: 100000,
      idempotencyKey: `t9-period-${randomUUID()}`,
      sourceMaxUpdatedAt: PERIOD_MONTH,
      ...overrides,
    },
  });
}

let chargeSeq = 0;
let docSeq = 0;

/** Raw-seed an IVOWN owner-receivable invoice (offset.integration.test.ts
 *  precedent). `outstandingAmount` per line defaults to that line's own
 *  `amount` (a fresh, fully-outstanding charge) but can be overridden to
 *  simulate a charge that's ALREADY partially collected via unrelated means
 *  BEFORE the offset under test — see offset_reverse_unit_check below for
 *  why that matters. */
async function seedIvownInvoice(opts: {
  ownerPartyId?: string;
  lines: { amount: string; outstandingAmount?: string }[];
}): Promise<{ documentId: string; lineIds: string[]; chargeIds: string[] }> {
  const db = getDb();
  const ownerPartyId = opts.ownerPartyId ?? OWNER;
  docSeq += 1;
  const subtotal = opts.lines.reduce((s, l) => s + Number(l.amount), 0).toFixed(2);
  const doc = await db.billingDocument.create({
    data: {
      organizationId: ORG,
      docType: "invoice",
      documentNumber: `IVOWN-T9-${docSeq}`,
      seriesId: IVOWN_SERIES,
      counterpartyType: "owner",
      partyId: ownerPartyId,
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
        chargeNumber: `T9-CHG-${chargeSeq}`,
        partyId: ownerPartyId,
        chargeType: "management_fee",
        status: "posted",
        dueDate: new Date(EFFECTIVE_DATE),
        amount: l.amount,
        currency: "MYR",
        outstandingAmount: l.outstandingAmount ?? l.amount,
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

// ─── Hono app harness — BOTH routers mounted at their REAL app.ts base
// paths, so one app instance can create a remittance/offset AND reverse it
// (incl. cross-endpoint wrong_kind checks) through the actual route tree ──

const MANAGER: SessionPayload = { userId: ACTOR, orgId: ORG, role: "manager", userType: "operator" };
const EDITOR: SessionPayload = { userId: ACTOR, orgId: ORG, role: "editor", userType: "operator" };
const ACCOUNTANT: SessionPayload = { userId: ACTOR, orgId: ORG, role: "accountant", userType: "operator" };

function makeApp(session: SessionPayload = MANAGER) {
  const app = new Hono<{ Variables: { session: SessionPayload } }>();
  app.use("*", async (c, next) => {
    c.set("session", session);
    await next();
  });
  app.route("/api/owner-remittances", ownerRemittanceRoutes);
  app.route("/api/owner-receivable-offsets", ownerReceivableOffsetRoutes);
  return app;
}

async function request(path: string, body: unknown, session: SessionPayload = MANAGER) {
  const app = makeApp(session);
  const res = await app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  // Robust to a non-JSON error body (Hono's plain-text 500 default page for
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
    ownerPartyId: OWNER,
    amount: "100.00",
    effectiveDate: EFFECTIVE_DATE,
    settlementKind: "OWNER_REMITTANCE",
    paymentMethod: "bank_transfer",
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
    ownerPartyId: OWNER,
    effectiveDate: EFFECTIVE_DATE,
    currency: "MYR",
    lineAllocations: [],
    idempotencyKey: randomUUID(),
    ...overrides,
  };
}

type ReversePayload = { reason: string; idempotencyKey: string };

function reversePayload(overrides: Partial<ReversePayload> = {}): ReversePayload {
  return {
    reason: "T9 test reversal",
    idempotencyKey: randomUUID(),
    ...overrides,
  };
}

async function postRemittance(payload: RemittancePayload, session: SessionPayload = MANAGER) {
  return request("/api/owner-remittances", payload, session);
}
async function postOffset(payload: OffsetPayload, session: SessionPayload = MANAGER) {
  return request("/api/owner-receivable-offsets", payload, session);
}
async function postReverse(
  basePath: "/api/owner-remittances" | "/api/owner-receivable-offsets",
  entryId: string,
  payload: ReversePayload,
  session: SessionPayload = MANAGER,
) {
  return request(`${basePath}/${entryId}/reverse`, payload, session);
}

async function availableC(): Promise<number> {
  return getDb().$transaction((tx) => computeAvailableOwnerPayableC(tx, ORG, OWNER));
}

// Number(), not raw .toString() — Prisma's Decimal.toString() strips
// trailing zeros ("0"/"60", not "0.00"/"60.00"); offset.integration.test.ts
// precedent (matches applyAllocationToChargeTx's own read convention).
async function chargeOutstanding(chargeId: string): Promise<number> {
  const db = getDb();
  const c = await db.charge.findUniqueOrThrow({ where: { id: chargeId }, select: { outstandingAmount: true } });
  return Number(c.outstandingAmount.toString());
}

function entryId(json: Record<string, unknown>): string {
  return (json.data as { entryId: string }).entryId;
}

dn("POST /:id/reverse — Task 9 integration", () => {
  beforeEach(async () => {
    process.env.ENABLE_PHASE2_OWNER_REMITTANCE = "true";
    await cleanup();
    await seedOrg();
    await seedBase();
  });

  afterAll(async () => {
    await cleanup();
  });

  // ── Cycle 1: remittance reversal — the money-critical happy path ────────

  it("(reverse_remittance) a 400 remittance reversed — payable restored, original row unchanged, ONE reversal entry", async () => {
    await seedIncomeRow("1000.00"); // availableC = 100000
    const period = await seedPeriod({ netPayoutC: 100000 });
    expect(await availableC()).toBe(100000);

    const create = await postRemittance(
      remittancePayload({ amount: "400.00", allocations: [{ ownerStatementPeriodId: period.id, allocatedAmount: "400.00" }] }),
    );
    expect(create.status).toBe(201);
    const originalId = entryId(create.json);
    expect(await availableC()).toBe(60000); // 100000 - 40000

    const rev = await postReverse("/api/owner-remittances", originalId, reversePayload());
    expect(rev.status).toBe(201);
    const reversalId = entryId(rev.json);
    expect(reversalId).not.toBe(originalId);

    // Restored via Task-3's +amount balance math (original -400, reversal +400 -> net 0 -> back to 100000).
    expect(await availableC()).toBe(100000);

    const db = getDb();
    const original = await db.ownerLedgerEntry.findUniqueOrThrow({ where: { id: originalId } });
    expect(original.status).toBe("active"); // NEVER mutated
    expect(original.reversalOfEntryId).toBeNull(); // NO back-pointer on the original

    const reversalRows = await db.ownerLedgerEntry.findMany({
      where: { organizationId: ORG, reversalOfEntryId: originalId },
    });
    expect(reversalRows).toHaveLength(1); // exactly ONE reversal entry
    const reversal = reversalRows[0]!;
    expect(reversal.id).toBe(reversalId);
    expect(reversal.status).toBe("active");
    expect(reversal.direction).toBe("payout");
    expect(reversal.settlementKind).toBe("OWNER_REMITTANCE");
    expect(Number(reversal.amount.toString())).toBe(400); // SAME amount as the original
    expect(reversal.includeInPayout).toBe(false);
    // NO cash fields on a reversal (it's a ledger correction, never a fresh cash event).
    expect(reversal.paymentMethod).toBeNull();
    expect(reversal.bankReference).toBeNull();
    expect(reversal.proofKey).toBeNull();
    expect(reversal.proofStatus).toBeNull();

    const audit = await db.auditLog.findFirst({
      where: { organizationId: ORG, entityId: reversalId, action: "owner_remittance.reverse" },
    });
    expect(audit).not.toBeNull();
  });

  it("(notify) reversing a remittance notifies the owner's portal user, post-commit", async () => {
    await seedIncomeRow("1000.00");
    const period = await seedPeriod({ netPayoutC: 100000 });
    const create = await postRemittance(
      remittancePayload({ amount: "100.00", allocations: [{ ownerStatementPeriodId: period.id, allocatedAmount: "100.00" }] }),
    );
    const originalId = entryId(create.json);

    const db = getDb();
    const notifBefore = await db.notification.count({ where: { organizationId: ORG, userId: OWNER_USER } });

    const rev = await postReverse("/api/owner-remittances", originalId, reversePayload());
    expect(rev.status).toBe(201);

    expect(await db.notification.count({ where: { organizationId: ORG, userId: OWNER_USER } })).toBe(notifBefore + 1);
  });

  // ── Cycle 2: restore-exactly-once — double_reverse (MANDATORY sabotage target) ─

  it("(double_reverse) reversing an already-reversed remittance — 409 ALREADY_REVERSED, no 2nd reversal row, payable NOT over-restored", async () => {
    await seedIncomeRow("1000.00");
    const period = await seedPeriod({ netPayoutC: 100000 });
    const create = await postRemittance(
      remittancePayload({ amount: "400.00", allocations: [{ ownerStatementPeriodId: period.id, allocatedAmount: "400.00" }] }),
    );
    const originalId = entryId(create.json);

    const first = await postReverse("/api/owner-remittances", originalId, reversePayload());
    expect(first.status).toBe(201);
    expect(await availableC()).toBe(100000); // restored exactly once

    // A GENUINELY NEW reversal attempt (fresh idempotencyKey — not a replay of the first).
    const second = await postReverse("/api/owner-remittances", originalId, reversePayload());
    expect(second.status).toBe(409);
    expect(second.json).toEqual({ error: "ALREADY_REVERSED" });

    const db = getDb();
    const reversalRows = await db.ownerLedgerEntry.count({ where: { organizationId: ORG, reversalOfEntryId: originalId } });
    expect(reversalRows).toBe(1); // STILL just one

    // The money-critical assertion: NOT over-restored to 140000 (100000 + a 2nd +400).
    expect(await availableC()).toBe(100000);
  });

  it("(entry_not_active) reversing a directly-voided (Phase-1 manual-void) remittance — 409 ENTRY_NOT_ACTIVE, nothing written", async () => {
    await seedIncomeRow("1000.00");
    const period = await seedPeriod({ netPayoutC: 100000 });
    const create = await postRemittance(
      remittancePayload({ amount: "200.00", allocations: [{ ownerStatementPeriodId: period.id, allocatedAmount: "200.00" }] }),
    );
    const originalId = entryId(create.json);

    const db = getDb();
    await db.ownerLedgerEntry.update({ where: { id: originalId }, data: { status: "void" } });

    const rev = await postReverse("/api/owner-remittances", originalId, reversePayload());
    expect(rev.status).toBe(409);
    expect(rev.json).toEqual({ error: "ENTRY_NOT_ACTIVE" });
    expect(await db.ownerLedgerEntry.count({ where: { organizationId: ORG, reversalOfEntryId: originalId } })).toBe(0);
  });

  // ── Cycle 2b: reverse-of-a-reversal — CANNOT_REVERSE_A_REVERSAL (MANDATORY
  // sabotage target). A reversal entry (reversalOfEntryId already set) must
  // NOT itself be reversible: ALREADY_REVERSED only rejects a SECOND
  // reversal OF THE SAME ORIGINAL — it does not, and structurally cannot,
  // catch a reversal request TARGETING a reversal row (a fresh reversal has
  // no reversal of its own yet, so that lookup finds nothing). Without a
  // guard, computeOwnerRunningBalance (owner-net-payout.ts) adds +amount for
  // ANY active row carrying reversalOfEntryId, unconditionally — reversing a
  // reversal would append a SECOND +amount row, over-restoring payable by
  // one full amount, and the chain (reverse R2 → R3 → …) inflates it without
  // bound, which in turn lets a real remittance exceed what's actually owed
  // (computeAvailableOwnerPayableC gates on that inflated ceiling). ────────

  it("(reverse_a_remittance_reversal) reversing a remittance's OWN reversal — 409 CANNOT_REVERSE_A_REVERSAL, no 2nd reversal row, payable NOT inflated", async () => {
    await seedIncomeRow("1000.00");
    const period = await seedPeriod({ netPayoutC: 100000 });
    const create = await postRemittance(
      remittancePayload({ amount: "400.00", allocations: [{ ownerStatementPeriodId: period.id, allocatedAmount: "400.00" }] }),
    );
    const originalId = entryId(create.json);
    expect(await availableC()).toBe(60000); // 100000 - 40000

    const first = await postReverse("/api/owner-remittances", originalId, reversePayload());
    expect(first.status).toBe(201);
    const reversalId = entryId(first.json);
    expect(await availableC()).toBe(100000); // restored correctly, exactly once
    const availAfterCorrectReverse = await availableC();

    // Attempt to reverse R1 ITSELF (reversalOfEntryId already set) — must be rejected.
    const second = await postReverse("/api/owner-remittances", reversalId, reversePayload());
    expect(second.status).toBe(409);
    expect(second.json).toEqual({ error: "CANNOT_REVERSE_A_REVERSAL" });

    const db = getDb();
    // NO 2nd reversal (R2) row was written.
    expect(await db.ownerLedgerEntry.count({ where: { organizationId: ORG, reversalOfEntryId: reversalId } })).toBe(0);

    // THE money-critical assertion: UNCHANGED from immediately after the
    // FIRST (correct) reverse — never inflated to 140000 (100000 + a 2nd +400).
    expect(await availableC()).toBe(availAfterCorrectReverse);
    expect(await availableC()).toBe(100000);
  });

  it("(reverse_an_offset_reversal) reversing an offset's OWN reversal — 409 CANNOT_REVERSE_A_REVERSAL, no 2nd reversal row, payable NOT inflated", async () => {
    await seedIncomeRow("500.00"); // availableC = 50000
    const inv = await seedIvownInvoice({ lines: [{ amount: "100.00" }] });

    const create = await postOffset(offsetPayload({ lineAllocations: [{ billingDocumentLineId: inv.lineIds[0]!, allocatedAmount: "100.00" }] }));
    const originalId = entryId(create.json);
    expect(await availableC()).toBe(40000);

    const first = await postReverse("/api/owner-receivable-offsets", originalId, reversePayload());
    expect(first.status).toBe(201);
    const reversalId = entryId(first.json);
    expect(await availableC()).toBe(50000); // restored correctly, exactly once
    const availAfterCorrectReverse = await availableC();

    // Attempt to reverse R1 ITSELF — must be rejected.
    const second = await postReverse("/api/owner-receivable-offsets", reversalId, reversePayload());
    expect(second.status).toBe(409);
    expect(second.json).toEqual({ error: "CANNOT_REVERSE_A_REVERSAL" });

    const db = getDb();
    // NO 2nd reversal (R2) row was written.
    expect(await db.ownerLedgerEntry.count({ where: { organizationId: ORG, reversalOfEntryId: reversalId } })).toBe(0);

    // THE money-critical assertion: UNCHANGED from immediately after the
    // FIRST (correct) reverse — never inflated to 60000 (50000 + a 2nd +100).
    expect(await availableC()).toBe(availAfterCorrectReverse);
    expect(await availableC()).toBe(50000);
    // The charge's outstanding is also untouched by the rejected 2nd
    // reverse (R1 carries no OwnerReceivableOffsetAllocation rows of its
    // own — those belong only to the ORIGINAL offset entry — so even
    // absent the guard the charge-restore loop would find nothing to
    // restore a 2nd time; this guard's job is specifically the PAYABLE side).
    expect(await chargeOutstanding(inv.chargeIds[0]!)).toBe(100);
  });

  // ── Cycle 3: offset reversal — restores BOTH payable and the receivable ──

  it("(reverse_offset_restores_both) a 100 offset that settled a line to outstanding 0 — reverse restores payable by 100 AND the line's Charge.outstandingAmount back to 100, EACH exactly once, no Payment/refund row", async () => {
    await seedIncomeRow("500.00"); // availableC = 50000
    const inv = await seedIvownInvoice({ lines: [{ amount: "100.00" }] });

    const create = await postOffset(offsetPayload({ lineAllocations: [{ billingDocumentLineId: inv.lineIds[0]!, allocatedAmount: "100.00" }] }));
    expect(create.status).toBe(201);
    const originalId = entryId(create.json);
    expect(await chargeOutstanding(inv.chargeIds[0]!)).toBe(0);
    expect(await availableC()).toBe(40000);

    const rev = await postReverse("/api/owner-receivable-offsets", originalId, reversePayload());
    expect(rev.status).toBe(201);
    const reversalId = entryId(rev.json);

    expect(await availableC()).toBe(50000); // payable restored by 100
    expect(await chargeOutstanding(inv.chargeIds[0]!)).toBe(100); // RM-verified — restored to 100

    const db = getDb();
    expect(await db.payment.count({ where: { organizationId: ORG } })).toBe(0); // no cash refund, ever

    const reversal = await db.ownerLedgerEntry.findUniqueOrThrow({ where: { id: reversalId } });
    expect(reversal.reversalOfEntryId).toBe(originalId);
    expect(reversal.settlementKind).toBe("OWNER_RECEIVABLE_OFFSET");
    expect(Number(reversal.amount.toString())).toBe(100);
    expect(reversal.paymentMethod).toBeNull();

    const charge = await db.charge.findUniqueOrThrow({ where: { id: inv.chargeIds[0]! }, select: { status: true } });
    expect(charge.status).toBe("posted"); // no longer "paid" — outstanding == amount again

    const audit = await db.auditLog.findFirst({
      where: { organizationId: ORG, entityId: reversalId, action: "owner_remittance.reverse_offset" },
    });
    expect(audit).not.toBeNull();
  });

  // ── Cycle 4: the RM/cents unit-boundary pin (MANDATORY sabotage target) ──

  it("(offset_reverse_unit_check) reverse an offset that settled 60.00 off a PARTIALLY-outstanding 1000.00 charge — outstanding restored by EXACTLY 60.00, not 6000.00 (a 100x bug would inflate/clamp to a value CLEARLY different from 260.00)", async () => {
    await seedIncomeRow("1000.00"); // availableC = 100000, comfortably above 60
    // amount=1000.00, but outstanding STARTS at 260.00 (simulating 740.00
    // already collected via unrelated means before this offset) — chosen so
    // a 100x-inflated restore (passing allocatedAmountC=6000 as if it were
    // RM, instead of 60.00) clamps to the charge's 1000.00 ceiling, a value
    // CLEARLY distinguishable from the correct 260.00. A fully-settled-to-0
    // charge (as in reverse_offset_restores_both above) can't distinguish a
    // 100x bug from correct behavior here: both the correct restore (0+60=60)
    // and the buggy one (0+6000, clamped to a 60.00 chargeAmount ceiling = 60)
    // land on the SAME visible value when chargeAmount itself is the cap.
    const inv = await seedIvownInvoice({ lines: [{ amount: "1000.00", outstandingAmount: "260.00" }] });

    const create = await postOffset(offsetPayload({ lineAllocations: [{ billingDocumentLineId: inv.lineIds[0]!, allocatedAmount: "60.00" }] }));
    expect(create.status).toBe(201);
    expect(await chargeOutstanding(inv.chargeIds[0]!)).toBe(200); // 260 - 60
    const originalId = entryId(create.json);

    const rev = await postReverse("/api/owner-receivable-offsets", originalId, reversePayload());
    expect(rev.status).toBe(201);

    // THE load-bearing assertion: EXACTLY 260.00 (200 + 60), never 1000.00
    // (the 100x-bug clamp ceiling) and never any other inflated value.
    expect(await chargeOutstanding(inv.chargeIds[0]!)).toBe(260);
  });

  // ── Cycle 5: idempotency (GC6) — replay never re-restores ───────────────

  it("(idempotent_replay) same reverse request (key+reason) sent twice — one reversal, 2nd call returns the first, payable not double-restored", async () => {
    await seedIncomeRow("1000.00");
    const period = await seedPeriod({ netPayoutC: 100000 });
    const create = await postRemittance(
      remittancePayload({ amount: "250.00", allocations: [{ ownerStatementPeriodId: period.id, allocatedAmount: "250.00" }] }),
    );
    const originalId = entryId(create.json);

    const payload = reversePayload();
    const first = await postReverse("/api/owner-remittances", originalId, payload);
    expect(first.status).toBe(201);
    const reversalId = entryId(first.json);

    const db = getDb();
    const countBefore = await db.ownerLedgerEntry.count({ where: { organizationId: ORG } });
    const availBefore = await availableC();

    const second = await postReverse("/api/owner-remittances", originalId, payload); // IDENTICAL payload
    expect(second.status).toBe(200);
    expect(entryId(second.json)).toBe(reversalId);

    expect(await db.ownerLedgerEntry.count({ where: { organizationId: ORG } })).toBe(countBefore); // nothing new
    expect(await availableC()).toBe(availBefore); // unchanged
  });

  it("(offset_idempotent_replay_no_double_restore) replaying an offset-reversal request does NOT re-run the charge-restore loop", async () => {
    await seedIncomeRow("500.00");
    const inv = await seedIvownInvoice({ lines: [{ amount: "60.00" }] });
    const create = await postOffset(offsetPayload({ lineAllocations: [{ billingDocumentLineId: inv.lineIds[0]!, allocatedAmount: "60.00" }] }));
    const originalId = entryId(create.json);

    const payload = reversePayload();
    const first = await postReverse("/api/owner-receivable-offsets", originalId, payload);
    expect(first.status).toBe(201);
    expect(await chargeOutstanding(inv.chargeIds[0]!)).toBe(60);

    const second = await postReverse("/api/owner-receivable-offsets", originalId, payload);
    expect(second.status).toBe(200);
    expect(entryId(second.json)).toBe(entryId(first.json));

    // The money-critical assertion: still 60, NOT double-restored to 120.
    expect(await chargeOutstanding(inv.chargeIds[0]!)).toBe(60);
    const db = getDb();
    expect(await db.ownerLedgerEntry.count({ where: { organizationId: ORG, reversalOfEntryId: originalId } })).toBe(1);
  });

  it("(IDEMPOTENCY_KEY_REUSED) same idempotencyKey, DIFFERENT reason — 409, no new reversal written", async () => {
    await seedIncomeRow("1000.00");
    const period = await seedPeriod({ netPayoutC: 100000 });
    const create = await postRemittance(
      remittancePayload({ amount: "100.00", allocations: [{ ownerStatementPeriodId: period.id, allocatedAmount: "100.00" }] }),
    );
    const originalId = entryId(create.json);

    const key = randomUUID();
    const first = await postReverse("/api/owner-remittances", originalId, reversePayload({ idempotencyKey: key, reason: "reason A" }));
    expect(first.status).toBe(201);

    const second = await postReverse(
      "/api/owner-remittances",
      originalId,
      reversePayload({ idempotencyKey: key, reason: "reason B - genuinely different" }),
    );
    expect(second.status).toBe(409);
    expect(second.json).toEqual({ error: "IDEMPOTENCY_KEY_REUSED" });

    const db = getDb();
    expect(await db.ownerLedgerEntry.count({ where: { organizationId: ORG, reversalOfEntryId: originalId } })).toBe(1);
  });

  // ── Cycle 6: recognition period — reversal's OWN effectiveDate, not the original's ─

  it("(later_period_isolation) original remittance in month M (2026-01) — the reversal's statementMonth is the CURRENT month, not M; the original's own statementMonth stays untouched", async () => {
    await seedIncomeRow("1000.00");
    const period = await seedPeriod({ netPayoutC: 100000 });
    const create = await postRemittance(
      remittancePayload({ amount: "150.00", allocations: [{ ownerStatementPeriodId: period.id, allocatedAmount: "150.00" }] }),
    );
    const originalId = entryId(create.json);

    const db = getDb();
    const originalBefore = await db.ownerLedgerEntry.findUniqueOrThrow({ where: { id: originalId } });
    expect(originalBefore.statementMonth.toISOString().slice(0, 10)).toBe("2026-01-01");

    const beforeCall = new Date();
    const rev = await postReverse("/api/owner-remittances", originalId, reversePayload());
    expect(rev.status).toBe(201);
    const afterCall = new Date();

    const reversal = await db.ownerLedgerEntry.findUniqueOrThrow({ where: { id: entryId(rev.json) } });
    const monthLow = new Date(Date.UTC(beforeCall.getUTCFullYear(), beforeCall.getUTCMonth(), 1)).toISOString().slice(0, 10);
    const monthHigh = new Date(Date.UTC(afterCall.getUTCFullYear(), afterCall.getUTCMonth(), 1)).toISOString().slice(0, 10);
    const actual = reversal.statementMonth.toISOString().slice(0, 10);
    expect([monthLow, monthHigh]).toContain(actual); // "now", not M
    expect(actual).not.toBe("2026-01-01"); // isolated from the original's month

    // The original's OWN statementMonth is NEVER retroactively touched.
    const originalAfter = await db.ownerLedgerEntry.findUniqueOrThrow({ where: { id: originalId } });
    expect(originalAfter.statementMonth.toISOString().slice(0, 10)).toBe("2026-01-01");
  });

  it("(frozen_statement_unchanged) a frozen earlier OwnerStatementPeriod snapshot stays byte-unchanged after a later reversal", async () => {
    const db = getDb();
    const frozen = await db.ownerStatementPeriod.create({
      data: {
        organizationId: ORG,
        ownerPartyId: OWNER,
        apartmentId: null,
        periodMonth: PERIOD_MONTH, // 2026-01
        status: "frozen",
        issuedAt: new Date("2026-02-01T00:00:00.000Z"),
        openingBalanceC: 0,
        closingBalanceC: 40000,
        netPayoutC: 40000,
        snapshotJson: { totals: { payoutsTotal: "150.00" }, lines: [] },
        pdfKey: "frozen/t9/2026-01.pdf",
        idempotencyKey: `t9-frozen-${randomUUID()}`,
        sourceMaxUpdatedAt: PERIOD_MONTH,
      },
    });
    const before = await db.ownerStatementPeriod.findUniqueOrThrow({ where: { id: frozen.id } });

    await seedIncomeRow("1000.00");
    // A SEPARATE, open period the remittance actually allocates against — the
    // frozen period above is never touched by the create OR the reverse.
    const openPeriod = await seedPeriod({ netPayoutC: 100000 });
    const create = await postRemittance(
      remittancePayload({ amount: "150.00", allocations: [{ ownerStatementPeriodId: openPeriod.id, allocatedAmount: "150.00" }] }),
    );
    const originalId = entryId(create.json);
    const rev = await postReverse("/api/owner-remittances", originalId, reversePayload());
    expect(rev.status).toBe(201);

    const after = await db.ownerStatementPeriod.findUniqueOrThrow({ where: { id: frozen.id } });
    expect(JSON.stringify(after)).toBe(JSON.stringify(before)); // byte-unchanged, incl. updatedAt
  });

  // ── Cycle 7: wrong_kind / not_found ──────────────────────────────────────

  it("(wrong_kind_offset_via_remittance_endpoint) reversing an OWNER_RECEIVABLE_OFFSET via the remittance-reverse endpoint — 400 NOT_A_REMITTANCE, nothing written", async () => {
    await seedIncomeRow("500.00");
    const inv = await seedIvownInvoice({ lines: [{ amount: "60.00" }] });
    const create = await postOffset(offsetPayload({ lineAllocations: [{ billingDocumentLineId: inv.lineIds[0]!, allocatedAmount: "60.00" }] }));
    const offsetId = entryId(create.json);

    const rev = await postReverse("/api/owner-remittances", offsetId, reversePayload());
    expect(rev.status).toBe(400);
    expect(rev.json).toEqual({ error: "NOT_A_REMITTANCE" });

    const db = getDb();
    expect(await db.ownerLedgerEntry.count({ where: { organizationId: ORG, reversalOfEntryId: offsetId } })).toBe(0);
    expect(await chargeOutstanding(inv.chargeIds[0]!)).toBe(0); // untouched
  });

  it("(wrong_kind_remittance_via_offset_endpoint) reversing an OWNER_REMITTANCE via the offset-reverse endpoint — 400 NOT_AN_OFFSET, nothing written", async () => {
    await seedIncomeRow("1000.00");
    const period = await seedPeriod({ netPayoutC: 100000 });
    const create = await postRemittance(
      remittancePayload({ amount: "100.00", allocations: [{ ownerStatementPeriodId: period.id, allocatedAmount: "100.00" }] }),
    );
    const remittanceId = entryId(create.json);

    const rev = await postReverse("/api/owner-receivable-offsets", remittanceId, reversePayload());
    expect(rev.status).toBe(400);
    expect(rev.json).toEqual({ error: "NOT_AN_OFFSET" });

    const db = getDb();
    expect(await db.ownerLedgerEntry.count({ where: { organizationId: ORG, reversalOfEntryId: remittanceId } })).toBe(0);
  });

  it("(not_found) reversing a non-existent id via either endpoint — 404, nothing written", async () => {
    const neverCreated = randomUUID();

    const remRev = await postReverse("/api/owner-remittances", neverCreated, reversePayload());
    expect(remRev.status).toBe(404);
    expect(remRev.json).toEqual({ error: "REMITTANCE_NOT_FOUND" });

    const offRev = await postReverse("/api/owner-receivable-offsets", neverCreated, reversePayload());
    expect(offRev.status).toBe(404);
    expect(offRev.json).toEqual({ error: "OFFSET_NOT_FOUND" });

    const db = getDb();
    expect(await db.ownerLedgerEntry.count({ where: { organizationId: ORG } })).toBe(0);
  });

  // ── Cycle 8: permission (requireWorkspaceOrRank("accounting","manager")) + flag gate ─

  it("(P1) a role with neither the accounting workspace nor rank>=manager (editor) — 403", async () => {
    await seedIncomeRow("1000.00");
    const period = await seedPeriod({ netPayoutC: 100000 });
    const create = await postRemittance(
      remittancePayload({ amount: "100.00", allocations: [{ ownerStatementPeriodId: period.id, allocatedAmount: "100.00" }] }),
    );
    const originalId = entryId(create.json);

    const rev = await postReverse("/api/owner-remittances", originalId, reversePayload(), EDITOR);
    expect(rev.status).toBe(403);
  });

  it("(P2) a role qualifying via the WORKSPACE path alone (accountant, rank < manager) succeeds — proves OR logic, not AND", async () => {
    await seedIncomeRow("1000.00");
    const period = await seedPeriod({ netPayoutC: 100000 });
    const create = await postRemittance(
      remittancePayload({ amount: "100.00", allocations: [{ ownerStatementPeriodId: period.id, allocatedAmount: "100.00" }] }),
    );
    const originalId = entryId(create.json);

    const rev = await postReverse("/api/owner-remittances", originalId, reversePayload(), ACCOUNTANT);
    expect(rev.status).toBe(201);
  });

  it("(F1) flag-off — canonical 404, before auth is even evaluated", async () => {
    process.env.ENABLE_PHASE2_OWNER_REMITTANCE = "false";
    const rev = await postReverse("/api/owner-remittances", randomUUID(), reversePayload(), EDITOR); // EDITOR would 403 if the flag gate didn't fire FIRST
    expect(rev.status).toBe(404);
    expect(rev.json).toEqual({ error: "not_found" });
  });
});
