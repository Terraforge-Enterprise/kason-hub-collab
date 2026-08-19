/**
 * Task 8 integration tests — POST /owner-receivable-offsets (real Postgres,
 * full route→service→repo wiring through an in-process Hono app —
 * remittance.integration.test.ts / allocate.integration.test.ts precedent).
 *
 * ⚠️ MONEY-CRITICAL: recordOffsetService reuses payments.repository.ts's
 * applyAllocationToChargeTx (the SAME rail single/batch payment allocation
 * uses) to decrement each settled charge's outstanding. That rail takes its
 * money argument in RINGGIT DECIMALS, while every other quantity in THIS
 * module (guards, OwnerReceivableOffsetAllocation.allocatedAmountC) is
 * integer CENTS. exact_settle_unit_check below is the load-bearing test that
 * pins this exact boundary — see settleIvownChargeTx's own docstring
 * (owner-remittance.repository.ts) for the full unit-conversion contract.
 *
 * Local-DB safety guard + fixed disjoint org uuid ("18" prefix — grep-verified
 * absent from every other integration suite; 15=Task-5 repo, 16=Task-6
 * create, 17=Task-7 allocate) mirror remittance.integration.test.ts.
 *
 * Run:
 *   export DATABASE_URL=$(grep -E '^DATABASE_URL=' .env | head -1 | sed -E 's/^DATABASE_URL=//; s/^"//; s/"$//')
 *   export SESSION_SECRET=$(grep -E '^SESSION_SECRET=' .env | head -1 | sed -E 's/^SESSION_SECRET=//; s/^"//; s/"$//')
 *   RUN_INTEGRATION=1 npx vitest run apps/api/src/modules/owner-remittance/__tests__/offset.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { Hono } from "hono";
import { getDb } from "@kason/db";
import type { Prisma } from "@kason/db";
import type { SessionPayload } from "../../../lib/auth";
import { ownerReceivableOffsetRoutes } from "../owner-receivable-offset.routes";
import { computeAvailableOwnerPayableC } from "../owner-remittance.repository";
import { voidEntryService } from "../../owner-ledger/owner-ledger.service";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

// ─── Fixed disjoint UUIDs ("18" prefix; 15=Task-5 repo, 16=Task-6 create, 17=Task-7 allocate) ─

const ORG = "18000000-0000-4000-8000-0000000000a1";
const ACTOR = "18000000-0000-4000-8000-0000000000a2"; // accounting-staff actor (real User row — AuditLog FK)
const OWNER = "18000000-0000-4000-8000-0000000000a4";
const OWNER2 = "18000000-0000-4000-8000-0000000000a5"; // cross-owner isolation (OWNER_MISMATCH)
const PROPERTY = "18000000-0000-4000-8000-0000000000a6";
const PROPERTY2 = "18000000-0000-4000-8000-0000000000a7";
const IVOWN_SERIES = "18000000-0000-4000-8000-0000000000b1";
const IVTEN_SERIES = "18000000-0000-4000-8000-0000000000b2";

const EFFECTIVE_DATE = "2026-01-01";
const PERIOD_MONTH = new Date(Date.UTC(2026, 0, 1));

// ─── Cleanup / seed (FK-safe order — OwnerReceivableOffsetAllocation.charge is
// onDelete:Restrict, so allocations MUST be deleted before charges; AuditLog
// actor is onDelete:Restrict, so audit rows MUST be deleted before users) ───

async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  await db.ownerReceivableOffsetAllocation.deleteMany({ where: org });
  await db.ownerLedgerEntry.deleteMany({ where: org });
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
      name: "T8 Offset Org",
      slug: "t8-offset-org",
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
    data: { id: OWNER, organizationId: ORG, displayName: "T8 Owner", partyType: "individual", status: "active" },
  });
  await db.party.create({
    data: { id: OWNER2, organizationId: ORG, displayName: "T8 Owner 2", partyType: "individual", status: "active" },
  });
  await db.user.create({
    data: { id: ACTOR, organizationId: ORG, email: "t8-actor@example.test", fullName: "T8 Actor", status: "active", role: "manager", userType: "operator" },
  });
  await db.property.create({
    data: { id: PROPERTY, organizationId: ORG, name: "T8 Property", propertyCode: "T8-P1", propertyType: "apartment", addressLine1: "1 T8 St", city: "KL", country: "MY", status: "active", publishStatus: "draft" },
  });
  await db.property.create({
    data: { id: PROPERTY2, organizationId: ORG, name: "T8 Property 2", propertyCode: "T8-P2", propertyType: "apartment", addressLine1: "2 T8 St", city: "KL", country: "MY", status: "active", publishStatus: "draft" },
  });
  await db.documentSeries.create({
    data: { id: IVOWN_SERIES, organizationId: ORG, code: "IVOWN", prefix: "IVOWN", padding: 4, includeYear: false, active: true },
  });
  await db.documentSeries.create({
    data: { id: IVTEN_SERIES, organizationId: ORG, code: "IVTEN", prefix: "IVTEN", padding: 4, includeYear: false, active: true },
  });
}

let chargeSeq = 0;
let docSeq = 0;

/**
 * Raw-seed an IVOWN owner-receivable invoice: docType "invoice",
 * ledgerTreatment "MANAGER_REVENUE", IVOWN series, partyId=ownerPartyId, with
 * charge-backed lines. NOTE: this deliberately sets ledgerTreatment
 * explicitly — issueStatementIvownDocumentTx (billing-documents/issue.service.ts,
 * the REAL owner-statement IVOWN mint) currently does NOT stamp it (verified
 * by reading that function), so a statement-generated IVOWN invoice would
 * FAIL this task's NOT_IVOWN_RECEIVABLE gate today. That is a real, named
 * scope boundary (see the report's self-review), not a test-seeding shortcut.
 */
async function seedIvownInvoice(opts: {
  ownerPartyId?: string;
  propertyId?: string | null;
  ledgerTreatment?: string | null;
  lines: { amount: string }[];
}): Promise<{ documentId: string; lineIds: string[]; chargeIds: string[] }> {
  const db = getDb();
  const ownerPartyId = opts.ownerPartyId ?? OWNER;
  docSeq += 1;
  const subtotal = opts.lines.reduce((s, l) => s + Number(l.amount), 0).toFixed(2);
  const doc = await db.billingDocument.create({
    data: {
      organizationId: ORG,
      docType: "invoice",
      documentNumber: `IVOWN-T8-${docSeq}`,
      seriesId: IVOWN_SERIES,
      counterpartyType: "owner",
      partyId: ownerPartyId,
      propertyId: opts.propertyId === undefined ? PROPERTY : opts.propertyId,
      issuedById: ACTOR,
      subtotal,
      total: subtotal,
      ledgerTreatment: opts.ledgerTreatment === undefined ? "MANAGER_REVENUE" : opts.ledgerTreatment,
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
        chargeNumber: `T8-CHG-${chargeSeq}`,
        partyId: ownerPartyId,
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

/** Raw-seed an IVTEN (tenant) invoice line, ledgerTreatment MANAGER_REVENUE —
 *  isolates the SERIES gate (not the ledgerTreatment gate, which would ALSO
 *  reject a null-ledgerTreatment doc — see not_ivown_null_ledger_treatment). */
async function seedIvtenLine(): Promise<{ lineId: string; chargeId: string }> {
  const db = getDb();
  docSeq += 1;
  const doc = await db.billingDocument.create({
    data: {
      organizationId: ORG, docType: "invoice", documentNumber: `IVTEN-T8-${docSeq}`,
      seriesId: IVTEN_SERIES, counterpartyType: "tenant", partyId: OWNER,
      issuedById: ACTOR, subtotal: "50.00", total: "50.00", ledgerTreatment: "MANAGER_REVENUE",
    },
    select: { id: true },
  });
  chargeSeq += 1;
  const charge = await db.charge.create({
    data: {
      organizationId: ORG, chargeNumber: `T8-TEN-${chargeSeq}`, partyId: OWNER, chargeType: "rent",
      status: "posted", dueDate: new Date(EFFECTIVE_DATE), amount: "50.00", currency: "MYR",
      outstandingAmount: "50.00", attachmentKeys: [],
    },
    select: { id: true },
  });
  const line = await db.billingDocumentLine.create({
    data: { documentId: doc.id, chargeId: charge.id, description: "Rent", amount: "50.00" },
    select: { id: true },
  });
  return { lineId: line.id, chargeId: charge.id };
}

/** Raw-seed a credit-note line with chargeId=null (R12a overpayment-CN shape). */
async function seedNullChargeLine(): Promise<{ lineId: string }> {
  const db = getDb();
  docSeq += 1;
  const doc = await db.billingDocument.create({
    data: {
      organizationId: ORG, docType: "credit_note", documentNumber: `CN-T8-${docSeq}`,
      seriesId: IVOWN_SERIES, counterpartyType: "owner", partyId: OWNER,
      issuedById: ACTOR, subtotal: "10.00", total: "10.00",
    },
    select: { id: true },
  });
  const line = await db.billingDocumentLine.create({
    data: { documentId: doc.id, chargeId: null, categoryId: null, description: "Overpayment credit", amount: "10.00" },
    select: { id: true },
  });
  return { lineId: line.id };
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

async function seedIncomeRow(amount: string, ownerPartyId = OWNER) {
  const db = getDb();
  return db.ownerLedgerEntry.create({
    data: ledgerRowData({ direction: "income", category: "rental_income", amount, ownerPartyId }),
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
  app.route("/", ownerReceivableOffsetRoutes);
  return app;
}

type Payload = {
  ownerPartyId: string;
  effectiveDate: string;
  currency: string;
  lineAllocations: { billingDocumentLineId: string; allocatedAmount: string }[];
  memo?: string;
  idempotencyKey: string;
};

function basePayload(overrides: Partial<Payload> = {}): Payload {
  return {
    ownerPartyId: OWNER,
    effectiveDate: EFFECTIVE_DATE,
    currency: "MYR",
    lineAllocations: [],
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

// Number(), not raw .toString() — Prisma's Decimal.toString() strips
// trailing zeros ("0"/"60", not "0.00"/"60.00"; empirically confirmed against
// real Postgres), matching applyAllocationToChargeTx's OWN read convention
// (payments.repository.ts: `Number(charge.outstandingAmount.toString())`).
async function chargeOutstanding(chargeId: string): Promise<number> {
  const db = getDb();
  const c = await db.charge.findUniqueOrThrow({ where: { id: chargeId }, select: { outstandingAmount: true } });
  return Number(c.outstandingAmount.toString());
}

dn("POST /owner-receivable-offsets — Task 8 integration", () => {
  beforeEach(async () => {
    process.env.ENABLE_PHASE2_OWNER_REMITTANCE = "true";
    await cleanup();
    await seedOrg();
    await seedBase();
  });

  afterAll(async () => {
    await cleanup();
  });

  // ── Cycle 1: the money-critical happy path ──────────────────────────────

  it("(offset_two_lines) 100 offset across a 60+40 IVOWN doc — both charges settle exactly, ONE payout entry (-100 payable), ZERO Payment rows, invoice PAID", async () => {
    await seedIncomeRow("500.00"); // availableC = 50000
    const inv = await seedIvownInvoice({ lines: [{ amount: "60.00" }, { amount: "40.00" }] });

    process.env.ENABLE_PHASE2_BILLING_DOCS = "true"; // exercise the post-commit status refresh too
    let result: Awaited<ReturnType<typeof post>>;
    try {
      result = await post(
        basePayload({
          lineAllocations: [
            { billingDocumentLineId: inv.lineIds[0]!, allocatedAmount: "60.00" },
            { billingDocumentLineId: inv.lineIds[1]!, allocatedAmount: "40.00" },
          ],
        }),
      );
    } finally {
      delete process.env.ENABLE_PHASE2_BILLING_DOCS;
    }

    expect(result.status).toBe(201);
    const entryId = (result.json.data as { entryId: string }).entryId;
    expect(entryId).toEqual(expect.any(String));

    // 100×-bug catcher: verify the RECEIVABLE charge's outstanding in RM, not cents.
    expect(await chargeOutstanding(inv.chargeIds[0]!)).toBe(0);
    expect(await chargeOutstanding(inv.chargeIds[1]!)).toBe(0);

    const db = getDb();
    const charges = await db.charge.findMany({ where: { id: { in: inv.chargeIds } }, select: { status: true } });
    expect(charges.every((c) => c.status === "paid")).toBe(true);

    // Invoice balance -> 0 / PAID (derived settlementStatus, refreshed post-commit).
    const doc = await db.billingDocument.findUniqueOrThrow({ where: { id: inv.documentId } });
    expect(doc.settlementStatus).toBe("PAID");

    // ONE OWNER_RECEIVABLE_OFFSET entry, -100 payable, no cash fields.
    const entries = await db.ownerLedgerEntry.findMany({ where: { organizationId: ORG, settlementKind: "OWNER_RECEIVABLE_OFFSET" } });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.id).toBe(entryId);
    expect(Number(entries[0]!.amount.toString())).toBe(100);
    expect(entries[0]!.direction).toBe("payout");
    expect(entries[0]!.includeInPayout).toBe(false);
    expect(entries[0]!.paymentMethod).toBeNull();
    expect(entries[0]!.bankReference).toBeNull();
    expect(entries[0]!.proofKey).toBeNull();

    // NO Payment EVER — this is a non-cash settlement.
    expect(await db.payment.count({ where: { organizationId: ORG } })).toBe(0);

    // Allocation rows — one per charge, in CENTS.
    const allocs = await db.ownerReceivableOffsetAllocation.findMany({ where: { organizationId: ORG } });
    expect(allocs).toHaveLength(2);
    expect(allocs.map((a) => a.allocatedAmountC).sort((a, b) => a - b)).toEqual([4000, 6000]);
    expect(allocs.every((a) => a.offsetEntryId === entryId)).toBe(true);
  });

  // ── Money-hole regression (whole-branch adversarial review): a settled
  // offset cannot be undone via the Phase-1 shallow void ─────────────────────
  // voidEntryService's R2 guard only checks sourceChargeId/sourceUtilityBillId,
  // both of which are ALWAYS null on a Phase-2 payout entry (insertPayoutEntry's
  // own contract) — only settlementKind distinguishes it. Without the guard,
  // calling voidEntryService on this entry would flip status→"void", dropping
  // it from computeAvailableOwnerPayableC's status:"active" filter and
  // silently freeing the 100.00 payable WITHOUT restoring the settled
  // charges — the exact money hole. Reuses the SAME settled offset as
  // (offset_two_lines) above, then calls voidEntryService directly (the exact
  // Phase-1 admin void path) and proves BOTH halves of the invariant hold
  // against REAL Postgres rows: the entry is not silently voided, and neither
  // the payable nor the settled charges move.
  it("(void_blocked) a settled offset entry cannot be voided via voidEntryService — payable stays reduced, charges stay settled", async () => {
    await seedIncomeRow("500.00"); // availableC = 50000 before the offset
    const inv = await seedIvownInvoice({ lines: [{ amount: "60.00" }, { amount: "40.00" }] });

    const created = await post(
      basePayload({
        lineAllocations: [
          { billingDocumentLineId: inv.lineIds[0]!, allocatedAmount: "60.00" },
          { billingDocumentLineId: inv.lineIds[1]!, allocatedAmount: "40.00" },
        ],
      }),
    );
    expect(created.status).toBe(201);
    const entryId = (created.json.data as { entryId: string }).entryId;

    const db = getDb();
    // Pre-void snapshot: the offset settled both charges and drew payable
    // down by 100.00 — confirm the money actually moved before attempting
    // the void (otherwise a "nothing changed" assertion later would be
    // vacuous).
    const availableBefore = await db.$transaction((tx) => computeAvailableOwnerPayableC(tx, ORG, OWNER));
    expect(availableBefore).toBe(40000); // 50000 - 10000 (the 100.00 offset)
    expect(await chargeOutstanding(inv.chargeIds[0]!)).toBe(0);
    expect(await chargeOutstanding(inv.chargeIds[1]!)).toBe(0);

    const entry = await db.ownerLedgerEntry.findUniqueOrThrow({ where: { id: entryId } });
    const voidResult = await voidEntryService(
      { orgId: ORG, actorUserId: ACTOR, actorRole: "admin", ip: "127.0.0.1", userAgent: "vitest" },
      entryId,
      entry.updatedAt.toISOString(),
    );

    expect(voidResult).toEqual({ ok: false, status: 409, error: "CANNOT_VOID_PHASE2_ENTRY" });

    // Post-attempt: entry still active, payable still 400.00, charges still
    // settled — nothing moved.
    const afterEntry = await db.ownerLedgerEntry.findUniqueOrThrow({ where: { id: entryId } });
    expect(afterEntry.status).toBe("active");
    const availableAfter = await db.$transaction((tx) => computeAvailableOwnerPayableC(tx, ORG, OWNER));
    expect(availableAfter).toBe(40000);
    expect(await chargeOutstanding(inv.chargeIds[0]!)).toBe(0);
    expect(await chargeOutstanding(inv.chargeIds[1]!)).toBe(0);
  });

  // ── Cycle 2: per-line / per-payable exceed guards ───────────────────────

  it("(over_line) 100 offset against a single 60-outstanding line — 409 OFFSET_EXCEEDS_LINE_OUTSTANDING, nothing written", async () => {
    await seedIncomeRow("500.00"); // payable comfortably above 100 — isolates the LINE guard from the PAYABLE guard
    const inv = await seedIvownInvoice({ lines: [{ amount: "60.00" }] });

    const { status, json } = await post(
      basePayload({ lineAllocations: [{ billingDocumentLineId: inv.lineIds[0]!, allocatedAmount: "100.00" }] }),
    );

    expect(status).toBe(409);
    expect(json).toEqual({ error: "OFFSET_EXCEEDS_LINE_OUTSTANDING" });
    expect(await chargeOutstanding(inv.chargeIds[0]!)).toBe(60); // untouched
    const db = getDb();
    expect(await db.ownerLedgerEntry.count({ where: { organizationId: ORG, settlementKind: "OWNER_RECEIVABLE_OFFSET" } })).toBe(0);
    expect(await db.ownerReceivableOffsetAllocation.count({ where: { organizationId: ORG } })).toBe(0);
  });

  it("(over_payable) payable 80, line outstanding 100, 100 offset — 409 OFFSET_EXCEEDS_PAYABLE, no receipt", async () => {
    await seedIncomeRow("80.00"); // availableC = 8000
    const inv = await seedIvownInvoice({ lines: [{ amount: "100.00" }] });

    const { status, json } = await post(
      basePayload({ lineAllocations: [{ billingDocumentLineId: inv.lineIds[0]!, allocatedAmount: "100.00" }] }),
    );

    expect(status).toBe(409);
    expect(json).toEqual({ error: "OFFSET_EXCEEDS_PAYABLE" });
    expect(await chargeOutstanding(inv.chargeIds[0]!)).toBe(100);
    const db = getDb();
    expect(await db.ownerLedgerEntry.count({ where: { organizationId: ORG, settlementKind: "OWNER_RECEIVABLE_OFFSET" } })).toBe(0);
    expect(await db.payment.count({ where: { organizationId: ORG } })).toBe(0);
  });

  // ── Cycle 3: IVOWN-receivable validation ────────────────────────────────

  it("(not_ivown_ivten) an IVTEN (tenant-series) doc line — 422 NOT_IVOWN_RECEIVABLE", async () => {
    await seedIncomeRow("500.00");
    const { lineId, chargeId } = await seedIvtenLine();

    const { status, json } = await post(basePayload({ lineAllocations: [{ billingDocumentLineId: lineId, allocatedAmount: "50.00" }] }));

    expect(status).toBe(422);
    expect(json).toEqual({ error: "NOT_IVOWN_RECEIVABLE" });
    expect(await chargeOutstanding(chargeId)).toBe(50);
  });

  it("(not_ivown_null_charge) an overpayment-CN-shaped line with chargeId=null — 422 NOT_IVOWN_RECEIVABLE", async () => {
    await seedIncomeRow("500.00");
    const { lineId } = await seedNullChargeLine();

    const { status, json } = await post(basePayload({ lineAllocations: [{ billingDocumentLineId: lineId, allocatedAmount: "10.00" }] }));

    expect(status).toBe(422);
    expect(json).toEqual({ error: "NOT_IVOWN_RECEIVABLE" });
  });

  it("(not_ivown_null_ledger_treatment) a real IVOWN-series owner invoice whose ledgerTreatment was never stamped — 422 NOT_IVOWN_RECEIVABLE (documents a real scope boundary: issueStatementIvownDocumentTx does not set ledgerTreatment today)", async () => {
    await seedIncomeRow("500.00");
    const inv = await seedIvownInvoice({ ledgerTreatment: null, lines: [{ amount: "60.00" }] });

    const { status, json } = await post(
      basePayload({ lineAllocations: [{ billingDocumentLineId: inv.lineIds[0]!, allocatedAmount: "60.00" }] }),
    );

    expect(status).toBe(422);
    expect(json).toEqual({ error: "NOT_IVOWN_RECEIVABLE" });
  });

  it("(owner_mismatch) a genuine IVOWN line belonging to a DIFFERENT owner — 422 OWNER_MISMATCH", async () => {
    await seedIncomeRow("500.00");
    const inv = await seedIvownInvoice({ ownerPartyId: OWNER2, lines: [{ amount: "30.00" }] });

    const { status, json } = await post(
      basePayload({ lineAllocations: [{ billingDocumentLineId: inv.lineIds[0]!, allocatedAmount: "30.00" }] }),
    );

    expect(status).toBe(422);
    expect(json).toEqual({ error: "OWNER_MISMATCH" });
  });

  // ── Cycle 4: the RM/cents unit-boundary pin ─────────────────────────────

  it("(exact_settle_unit_check) 60.00 line, EXACTLY 60.00 offset — outstanding drops to EXACTLY 0.00 (a 100× bug would fail this dramatically)", async () => {
    await seedIncomeRow("60.00");
    const inv = await seedIvownInvoice({ lines: [{ amount: "60.00" }] });

    const { status } = await post(basePayload({ lineAllocations: [{ billingDocumentLineId: inv.lineIds[0]!, allocatedAmount: "60.00" }] }));

    expect(status).toBe(201);
    // A 100× unit bug (passing allocatedAmountC=6000 straight into the RM-expecting
    // rail) would read 6000 > 60.00 outstanding -> {exceeded:true} -> 409 instead of
    // this 201, OR (if the exceed-guard were bypassed some other way) drive
    // outstanding to something other than exactly "0.00". Both are excluded here.
    expect(await chargeOutstanding(inv.chargeIds[0]!)).toBe(0);
    const db = getDb();
    const charge = await db.charge.findUniqueOrThrow({ where: { id: inv.chargeIds[0]! }, select: { status: true } });
    expect(charge.status).toBe("paid");
  });

  // ── Cycle 5: idempotency (GC6) ───────────────────────────────────────────

  it("(idempotent_replay) same key + identical payload, called TWICE — second call replays: same entryId, 200, NO new writes, charges untouched by the replay", async () => {
    await seedIncomeRow("500.00");
    const inv = await seedIvownInvoice({ lines: [{ amount: "60.00" }, { amount: "40.00" }] });
    const payload = basePayload({
      lineAllocations: [
        { billingDocumentLineId: inv.lineIds[0]!, allocatedAmount: "60.00" },
        { billingDocumentLineId: inv.lineIds[1]!, allocatedAmount: "40.00" },
      ],
    });

    const first = await post(payload);
    expect(first.status).toBe(201);
    const entryId = (first.json.data as { entryId: string }).entryId;

    const db = getDb();
    const entryCountBefore = await db.ownerLedgerEntry.count({ where: { organizationId: ORG } });
    const allocCountBefore = await db.ownerReceivableOffsetAllocation.count({ where: { organizationId: ORG } });

    const second = await post(payload);

    expect(second.status).toBe(200);
    expect((second.json.data as { entryId: string }).entryId).toBe(entryId);
    expect(await db.ownerLedgerEntry.count({ where: { organizationId: ORG } })).toBe(entryCountBefore);
    expect(await db.ownerReceivableOffsetAllocation.count({ where: { organizationId: ORG } })).toBe(allocCountBefore);
    // The replay must NOT re-apply the settlement — charges stay exactly as the FIRST call left them.
    expect(await chargeOutstanding(inv.chargeIds[0]!)).toBe(0);
    expect(await chargeOutstanding(inv.chargeIds[1]!)).toBe(0);
  });

  it("(IDEMPOTENCY_KEY_REUSED) same key, DIFFERENT payload — 409, nothing new written", async () => {
    await seedIncomeRow("500.00");
    const db = getDb();
    const key = randomUUID();
    await db.ownerLedgerEntry.create({
      data: ledgerRowData({
        direction: "payout",
        category: "owner_payout",
        amount: "50.00",
        includeInPayout: false,
        settlementKind: "OWNER_RECEIVABLE_OFFSET",
        idempotencyKey: key,
        requestFingerprint: "seed-fingerprint-does-not-match-anything",
      }),
    });
    const inv = await seedIvownInvoice({ lines: [{ amount: "60.00" }] });
    const before = await db.ownerLedgerEntry.count({ where: { organizationId: ORG } });

    const { status, json } = await post(
      basePayload({ idempotencyKey: key, lineAllocations: [{ billingDocumentLineId: inv.lineIds[0]!, allocatedAmount: "60.00" }] }),
    );

    expect(status).toBe(409);
    expect(json).toEqual({ error: "IDEMPOTENCY_KEY_REUSED" });
    expect(await db.ownerLedgerEntry.count({ where: { organizationId: ORG } })).toBe(before);
    expect(await chargeOutstanding(inv.chargeIds[0]!)).toBe(60); // untouched
  });

  // ── Cycle 6: propertyId derivation ───────────────────────────────────────

  it("(propertyId_single) all lines resolve to the SAME property — entry.propertyId is that property", async () => {
    await seedIncomeRow("500.00");
    const inv = await seedIvownInvoice({ propertyId: PROPERTY, lines: [{ amount: "20.00" }, { amount: "30.00" }] });

    const { status, json } = await post(
      basePayload({
        lineAllocations: [
          { billingDocumentLineId: inv.lineIds[0]!, allocatedAmount: "20.00" },
          { billingDocumentLineId: inv.lineIds[1]!, allocatedAmount: "30.00" },
        ],
      }),
    );

    expect(status).toBe(201);
    const db = getDb();
    const entry = await db.ownerLedgerEntry.findUniqueOrThrow({ where: { id: (json.data as { entryId: string }).entryId } });
    expect(entry.propertyId).toBe(PROPERTY);
  });

  it("(propertyId_multi) lines resolve to TWO DIFFERENT properties — entry.propertyId is null (owner-level)", async () => {
    await seedIncomeRow("500.00");
    const invA = await seedIvownInvoice({ propertyId: PROPERTY, lines: [{ amount: "20.00" }] });
    const invB = await seedIvownInvoice({ propertyId: PROPERTY2, lines: [{ amount: "30.00" }] });

    const { status, json } = await post(
      basePayload({
        lineAllocations: [
          { billingDocumentLineId: invA.lineIds[0]!, allocatedAmount: "20.00" },
          { billingDocumentLineId: invB.lineIds[0]!, allocatedAmount: "30.00" },
        ],
      }),
    );

    expect(status).toBe(201);
    const db = getDb();
    const entry = await db.ownerLedgerEntry.findUniqueOrThrow({ where: { id: (json.data as { entryId: string }).entryId } });
    expect(entry.propertyId).toBeNull();
  });

  it("(propertyId_null_doc) one line's document has NO propertyId — entry.propertyId is null even though the OTHER line is single-property", async () => {
    await seedIncomeRow("500.00");
    const invA = await seedIvownInvoice({ propertyId: PROPERTY, lines: [{ amount: "20.00" }] });
    const invNull = await seedIvownInvoice({ propertyId: null, lines: [{ amount: "10.00" }] });

    const { status, json } = await post(
      basePayload({
        lineAllocations: [
          { billingDocumentLineId: invA.lineIds[0]!, allocatedAmount: "20.00" },
          { billingDocumentLineId: invNull.lineIds[0]!, allocatedAmount: "10.00" },
        ],
      }),
    );

    expect(status).toBe(201);
    const db = getDb();
    const entry = await db.ownerLedgerEntry.findUniqueOrThrow({ where: { id: (json.data as { entryId: string }).entryId } });
    expect(entry.propertyId).toBeNull();
  });

  // ── Cycle 7: currency + magnitude guards ────────────────────────────────

  it("(currency_mismatch) request currency differs from Organization.defaultCurrency — 422, nothing written", async () => {
    await seedIncomeRow("500.00"); // org default is MYR (seedOrg())
    const inv = await seedIvownInvoice({ lines: [{ amount: "60.00" }] });

    const { status, json } = await post(
      basePayload({ currency: "SGD", lineAllocations: [{ billingDocumentLineId: inv.lineIds[0]!, allocatedAmount: "60.00" }] }),
    );

    expect(status).toBe(422);
    expect(json).toEqual({ error: "CURRENCY_MISMATCH" });
    expect(await chargeOutstanding(inv.chargeIds[0]!)).toBe(60);
  });

  it("(AMOUNT_TOO_LARGE) Σ lineAllocations exceeds the Decimal(12,2) cap — 422, nothing written [B25]", async () => {
    await seedIncomeRow("500.00");
    const inv = await seedIvownInvoice({ lines: [{ amount: "60.00" }] });

    const { status, json } = await post(
      basePayload({ lineAllocations: [{ billingDocumentLineId: inv.lineIds[0]!, allocatedAmount: "12345678901.00" }] }),
    );

    expect(status).toBe(422);
    expect(json).toEqual({ error: "AMOUNT_TOO_LARGE" });
    const db = getDb();
    expect(await db.ownerLedgerEntry.count({ where: { organizationId: ORG, settlementKind: "OWNER_RECEIVABLE_OFFSET" } })).toBe(0);
  });

  // ── Cycle 8: permission (requireWorkspaceOrRank("accounting","manager")) ───

  it("(P1) a role with neither the accounting workspace nor rank>=manager (editor) — 403", async () => {
    await seedIncomeRow("500.00");
    const inv = await seedIvownInvoice({ lines: [{ amount: "60.00" }] });
    const { status } = await post(
      basePayload({ lineAllocations: [{ billingDocumentLineId: inv.lineIds[0]!, allocatedAmount: "60.00" }] }),
      EDITOR,
    );
    expect(status).toBe(403);
  });

  it("(P2) a role qualifying via the WORKSPACE path alone (accountant, rank < manager) succeeds — proves OR logic, not AND", async () => {
    await seedIncomeRow("500.00");
    const inv = await seedIvownInvoice({ lines: [{ amount: "60.00" }] });
    const { status } = await post(
      basePayload({ lineAllocations: [{ billingDocumentLineId: inv.lineIds[0]!, allocatedAmount: "60.00" }] }),
      ACCOUNTANT,
    );
    expect(status).toBe(201);
  });

  // ── Cycle 9: flag-gate ─────────────────────────────────────────────────────

  it("(F1) flag-off — canonical 404, before auth is even evaluated", async () => {
    process.env.ENABLE_PHASE2_OWNER_REMITTANCE = "false";
    const { status, json } = await post(basePayload(), EDITOR); // EDITOR would 403 if the flag gate didn't fire FIRST
    expect(status).toBe(404);
    expect(json).toEqual({ error: "not_found" });
  });

  // ── Cycle 10: settle-rail error mapping (StaleError/PartyMismatchError) ────
  // settleIvownChargeTx (via applyAllocationToChargeTx, payments.repository.ts)
  // shares the SAME guarded charge-mutation rail every payment-allocation path
  // uses. A StaleError (voided charge / optimistic updatedAt-in-WHERE miss) or
  // PartyMismatchError (charge.partyId != expected owner) thrown mid-loop must
  // map to a clean 409/422 — NOT escape to app.onError's uncaught->500 default
  // — AND must roll back ANY charge already settled earlier in the SAME loop
  // (same whole-tx atomicity OFFSET_EXCEEDS_LINE_OUTSTANDING already gets).

  it("(offset_conflict_stale_charge) two-charge offset — A settles first, B is VOIDED (StaleError) — 409 OFFSET_CONFLICT, A's settlement rolled back too, nothing written", async () => {
    await seedIncomeRow("500.00");
    const inv = await seedIvownInvoice({ lines: [{ amount: "60.00" }, { amount: "40.00" }] });
    const db = getDb();
    // Simulate "B was voided out-of-band between the client loading the offset
    // form and this request committing" — applyAllocationToChargeTx's void
    // check (payments.repository.ts) fires BEFORE any amount comparison, so
    // this is a deterministic, non-flaky StaleError trigger (no real
    // concurrent transaction interleaving needed).
    await db.charge.update({ where: { id: inv.chargeIds[1]! }, data: { status: "void" } });

    const { status, json } = await post(
      basePayload({
        lineAllocations: [
          { billingDocumentLineId: inv.lineIds[0]!, allocatedAmount: "60.00" }, // A — would settle if processed alone
          { billingDocumentLineId: inv.lineIds[1]!, allocatedAmount: "10.00" }, // B — voided, well within its own 40.00 outstanding
        ],
      }),
    );

    expect(status).toBe(409);
    expect(json).toEqual({ error: "OFFSET_CONFLICT" });
    // A's would-be settlement is UNDONE — whole tx rolled back, not just B skipped.
    expect(await chargeOutstanding(inv.chargeIds[0]!)).toBe(60);
    expect(await chargeOutstanding(inv.chargeIds[1]!)).toBe(40);
    expect(await db.ownerLedgerEntry.count({ where: { organizationId: ORG, settlementKind: "OWNER_RECEIVABLE_OFFSET" } })).toBe(0);
    expect(await db.ownerReceivableOffsetAllocation.count({ where: { organizationId: ORG } })).toBe(0);
    expect(await db.payment.count({ where: { organizationId: ORG } })).toBe(0);
  });

  it("(offset_charge_party_mismatch) two-charge offset — A settles first, B's Charge.partyId is desynced from the document owner (PartyMismatchError) — 422 OFFSET_CHARGE_PARTY_MISMATCH, A's settlement rolled back too, nothing written", async () => {
    await seedIncomeRow("500.00");
    const inv = await seedIvownInvoice({ lines: [{ amount: "60.00" }, { amount: "40.00" }] });
    const db = getDb();
    // Desync ONLY the Charge row's own partyId from its document's partyId —
    // the document (and hence the line's OWNER_MISMATCH pre-check at guard 4,
    // which reads docLine.document.partyId) still resolves to OWNER, so this
    // is invisible until applyAllocationToChargeTx's OWN charge-level partyId
    // check fires deep in the settlement rail (a defense-in-depth check, not
    // a duplicate of the pre-check — the two read different columns/tables).
    await db.charge.update({ where: { id: inv.chargeIds[1]! }, data: { partyId: OWNER2 } });

    const { status, json } = await post(
      basePayload({
        lineAllocations: [
          { billingDocumentLineId: inv.lineIds[0]!, allocatedAmount: "60.00" }, // A — would settle if processed alone
          { billingDocumentLineId: inv.lineIds[1]!, allocatedAmount: "10.00" }, // B — party-desynced, well within its own 40.00 outstanding
        ],
      }),
    );

    expect(status).toBe(422);
    expect(json).toEqual({ error: "OFFSET_CHARGE_PARTY_MISMATCH" });
    // A's would-be settlement is UNDONE — whole tx rolled back, not just B skipped.
    expect(await chargeOutstanding(inv.chargeIds[0]!)).toBe(60);
    expect(await chargeOutstanding(inv.chargeIds[1]!)).toBe(40);
    expect(await db.ownerLedgerEntry.count({ where: { organizationId: ORG, settlementKind: "OWNER_RECEIVABLE_OFFSET" } })).toBe(0);
    expect(await db.ownerReceivableOffsetAllocation.count({ where: { organizationId: ORG } })).toBe(0);
    expect(await db.payment.count({ where: { organizationId: ORG } })).toBe(0);
  });

  // ── Cycle 11: multi-charge partial-exceed atomicity (pins existing
  // whole-tx-rollback behavior — the settlement loop already runs inside the
  // SAME $transaction as insertPayoutEntry, but that was never directly
  // pinned by a test where ONE charge in the offset would-be-settle and a
  // LATER one in the SAME request exceeds; see this file's sabotage spot-
  // check, appended to the fix report, for proof this test actually bites) ─

  it("(offset_multi_charge_atomicity) two-charge offset — A (60/60) settles first, B (50 requested / 40 outstanding) EXCEEDS — 409 OFFSET_EXCEEDS_LINE_OUTSTANDING, A's settlement rolled back too, nothing written", async () => {
    await seedIncomeRow("500.00"); // payable comfortably above 110 — isolates the LINE guard from the PAYABLE guard
    const inv = await seedIvownInvoice({ lines: [{ amount: "60.00" }, { amount: "40.00" }] });

    const { status, json } = await post(
      basePayload({
        lineAllocations: [
          { billingDocumentLineId: inv.lineIds[0]!, allocatedAmount: "60.00" }, // A — exactly settles if processed alone
          { billingDocumentLineId: inv.lineIds[1]!, allocatedAmount: "50.00" }, // B — exceeds its own 40.00 outstanding
        ],
      }),
    );

    expect(status).toBe(409);
    expect(json).toEqual({ error: "OFFSET_EXCEEDS_LINE_OUTSTANDING" });
    // A's would-be settlement is UNDONE — the whole tx rolled back, not just B rejected.
    const db = getDb();
    expect(await chargeOutstanding(inv.chargeIds[0]!)).toBe(60); // RM-verified — NOT settled
    expect(await chargeOutstanding(inv.chargeIds[1]!)).toBe(40); // untouched
    const chargeA = await db.charge.findUniqueOrThrow({ where: { id: inv.chargeIds[0]! }, select: { status: true } });
    expect(chargeA.status).toBe("posted"); // NOT "paid" — the status flip is rolled back too
    expect(await db.ownerLedgerEntry.count({ where: { organizationId: ORG, settlementKind: "OWNER_RECEIVABLE_OFFSET" } })).toBe(0);
    expect(await db.ownerReceivableOffsetAllocation.count({ where: { organizationId: ORG } })).toBe(0);
    expect(await db.payment.count({ where: { organizationId: ORG } })).toBe(0);
  });

  // ── Cycle 12: retry-after-conflict cleanliness (GC6 — a 409 OFFSET_CONFLICT
  // must be genuinely retryable: since the WHOLE tx (including the payout
  // entry carrying idempotencyKey) rolled back, a same-key retry once the
  // transient condition clears must re-enter as a FRESH attempt, not
  // IDEMPOTENCY_KEY_REUSED) ──────────────────────────────────────────────

  it("(offset_conflict_retry_succeeds) same idempotencyKey retried after a 409 OFFSET_CONFLICT, once the charge is un-voided — second call succeeds cleanly as a fresh attempt (NOT IDEMPOTENCY_KEY_REUSED)", async () => {
    await seedIncomeRow("500.00");
    const inv = await seedIvownInvoice({ lines: [{ amount: "60.00" }] });
    const db = getDb();
    await db.charge.update({ where: { id: inv.chargeIds[0]! }, data: { status: "void" } });

    const payload = basePayload({ lineAllocations: [{ billingDocumentLineId: inv.lineIds[0]!, allocatedAmount: "60.00" }] });

    const first = await post(payload);
    expect(first.status).toBe(409);
    expect(first.json).toEqual({ error: "OFFSET_CONFLICT" });
    // Scoped to settlementKind — ORG already has ONE OwnerLedgerEntry (the
    // income row seedIncomeRow just created to fund the payable); the offset
    // itself must leave behind ZERO OWNER_RECEIVABLE_OFFSET rows.
    expect(await db.ownerLedgerEntry.count({ where: { organizationId: ORG, settlementKind: "OWNER_RECEIVABLE_OFFSET" } })).toBe(0);

    // The transient condition clears (e.g. the void was itself a mistake, corrected out-of-band).
    await db.charge.update({ where: { id: inv.chargeIds[0]! }, data: { status: "posted" } });

    const second = await post(payload); // SAME idempotencyKey

    expect(second.status).toBe(201); // fresh attempt, not a replay — the first call wrote nothing to replay
    expect(second.json).not.toEqual({ error: "IDEMPOTENCY_KEY_REUSED" });
    expect(await chargeOutstanding(inv.chargeIds[0]!)).toBe(0);
    expect(await db.ownerLedgerEntry.count({ where: { organizationId: ORG, settlementKind: "OWNER_RECEIVABLE_OFFSET" } })).toBe(1);
  });
});
