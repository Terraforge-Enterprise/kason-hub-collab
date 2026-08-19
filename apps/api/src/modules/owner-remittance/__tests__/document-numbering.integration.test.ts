/**
 * Redesign P1 integration tests — REM- remittance display numbering (real
 * Postgres, calling recordRemittanceService / recordOffsetService /
 * reverseRemittanceService directly — no Hono route layer, since auth/role
 * gating is already covered by remittance.integration.test.ts /
 * offset.integration.test.ts / reverse.integration.test.ts and is not this
 * file's concern).
 *
 * Mints ONLY at recordRemittanceService's payout write (OWNER_REMITTANCE /
 * PRE_STATEMENT_REMITTANCE — real cash-out to the owner). NEVER at
 * recordOffsetService (OWNER_RECEIVABLE_OFFSET) or a reversal write (either
 * kind) — neither is new cash to the owner.
 *
 * Local-DB safety guard + fixed disjoint org uuid ("22" prefix — grep-verified
 * absent from every other integration suite at authoring time; 15=Task-5 repo,
 * 16=Task-6 create, 17=Task-7 allocate, 18=Task-8 offset, 19=Task-9 reverse,
 * 20=concurrency, 21=authz) mirrors remittance.integration.test.ts.
 *
 * Run:
 *   export DATABASE_URL=$(grep -E '^DATABASE_URL=' .env | head -1 | sed -E 's/^DATABASE_URL=//; s/^"//; s/"$//')
 *   RUN_INTEGRATION=1 npx vitest run apps/api/src/modules/owner-remittance/__tests__/document-numbering.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getDb } from "@kason/db";
import type { Prisma } from "@kason/db";
import {
  recordRemittanceService,
  recordOffsetService,
  reverseRemittanceService,
  type RemittanceActorCtx,
} from "../owner-remittance.service";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

// ─── Fixed disjoint UUIDs ("22" prefix) ──────────────────────────────────────

const ORG = "22000000-0000-4000-8000-0000000000a1";
const ACTOR = "22000000-0000-4000-8000-0000000000a2";
const OWNER = "22000000-0000-4000-8000-0000000000a4";
const PROPERTY = "22000000-0000-4000-8000-0000000000a6";
const APARTMENT = "22000000-0000-4000-8000-0000000000a8";
const IVOWN_SERIES = "22000000-0000-4000-8000-0000000000b1";

const EFFECTIVE_DATE = "2026-01-01";
const PERIOD_MONTH = new Date(Date.UTC(2026, 0, 1));

const actor: RemittanceActorCtx = { orgId: ORG, actorUserId: ACTOR, actorRole: "manager" };

// ─── Cleanup / seed (FK-safe order — mirrors remittance.integration.test.ts / offset.integration.test.ts) ──

async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  await db.notification.deleteMany({ where: org });
  await db.ownerRemittanceAllocation.deleteMany({ where: org });
  await db.ownerReceivableOffsetAllocation.deleteMany({ where: org });
  await db.ownerLedgerEntry.deleteMany({ where: org });
  await db.ownerStatementPeriod.deleteMany({ where: org });
  await db.billingDocumentLine.deleteMany({ where: { document: { organizationId: ORG } } });
  await db.billingDocument.deleteMany({ where: org });
  await db.charge.deleteMany({ where: org });
  // ensureChargeCategorySeeds (called by the REM mint path) lazily seeds BOTH
  // DocumentSeries and ChargeCategory rows — ChargeCategory.seriesId FKs to
  // DocumentSeries, so it must be cleared first.
  await db.chargeCategory.deleteMany({ where: org });
  await db.documentSeries.deleteMany({ where: org });
  await db.auditLog.deleteMany({ where: org });
  await db.property.deleteMany({ where: org });
  await db.party.deleteMany({ where: org });
  await db.user.deleteMany({ where: org });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function seedOrg() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG,
      name: "P1 Doc-Numbering Org",
      slug: "p1-doc-numbering-org",
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
    data: { id: OWNER, organizationId: ORG, displayName: "P1 Owner", partyType: "individual", status: "active" },
  });
  await db.user.create({
    data: { id: ACTOR, organizationId: ORG, email: "p1-actor@example.test", fullName: "P1 Actor", status: "active", role: "manager", userType: "operator" },
  });
  await db.property.create({
    data: { id: PROPERTY, organizationId: ORG, name: "P1 Property", propertyCode: "P1-P1", propertyType: "apartment", addressLine1: "1 P1 St", city: "KL", country: "MY", status: "active", publishStatus: "draft" },
  });
  // IVOWN series — required by recordOffsetService's NOT_IVOWN_RECEIVABLE check.
  await db.documentSeries.create({
    data: { id: IVOWN_SERIES, organizationId: ORG, code: "IVOWN", prefix: "IVOWN", padding: 4, includeYear: false, active: true },
  });
}

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

async function seedPeriod(overrides: Partial<Prisma.OwnerStatementPeriodUncheckedCreateInput> = {}) {
  const db = getDb();
  return db.ownerStatementPeriod.create({
    data: {
      organizationId: ORG,
      ownerPartyId: OWNER,
      apartmentId: APARTMENT,
      periodMonth: PERIOD_MONTH,
      netPayoutC: 100000,
      idempotencyKey: `p1-period-${randomUUID()}`,
      sourceMaxUpdatedAt: PERIOD_MONTH,
      ...overrides,
    },
  });
}

let docSeq = 0;
let chargeSeq = 0;

/** Raw-seed an IVOWN owner-receivable invoice (mirrors offset.integration.test.ts's seedIvownInvoice). */
async function seedIvownInvoice(lines: { amount: string }[]) {
  const db = getDb();
  docSeq += 1;
  const subtotal = lines.reduce((s, l) => s + Number(l.amount), 0).toFixed(2);
  const doc = await db.billingDocument.create({
    data: {
      organizationId: ORG,
      docType: "invoice",
      documentNumber: `IVOWN-P1-${docSeq}`,
      seriesId: IVOWN_SERIES,
      counterpartyType: "owner",
      partyId: OWNER,
      propertyId: PROPERTY,
      issuedById: ACTOR,
      subtotal,
      total: subtotal,
      ledgerTreatment: "MANAGER_REVENUE",
      commercialDocumentType: "OWNER_SERVICE_INVOICE",
    },
    select: { id: true },
  });
  const lineAllocations: { billingDocumentLineId: string; allocatedAmount: string }[] = [];
  for (const l of lines) {
    chargeSeq += 1;
    const charge = await db.charge.create({
      data: {
        organizationId: ORG,
        chargeNumber: `P1-CHG-${chargeSeq}`,
        partyId: OWNER,
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
    const line = await db.billingDocumentLine.create({
      data: { documentId: doc.id, chargeId: charge.id, description: "Management fee", amount: l.amount },
      select: { id: true },
    });
    lineAllocations.push({ billingDocumentLineId: line.id, allocatedAmount: l.amount });
  }
  return lineAllocations;
}

dn("REM- remittance numbering (redesign P1, integration)", () => {
  beforeEach(async () => {
    process.env.ENABLE_PHASE2_OWNER_REMITTANCE = "true";
    delete process.env.ENABLE_OWNER_DOC_NUMBERING;
    await cleanup();
    await seedOrg();
    await seedBase();
  });

  afterAll(async () => {
    await cleanup();
    delete process.env.ENABLE_PHASE2_OWNER_REMITTANCE;
    delete process.env.ENABLE_OWNER_DOC_NUMBERING;
  });

  it("(flag ON) mints REM-<seq> on a real OWNER_REMITTANCE payout", async () => {
    process.env.ENABLE_OWNER_DOC_NUMBERING = "true";
    await seedIncomeRow("1000.00");
    const period = await seedPeriod();

    const res = await recordRemittanceService(actor, {
      ownerPartyId: OWNER,
      amount: "100.00",
      effectiveDate: EFFECTIVE_DATE,
      settlementKind: "OWNER_REMITTANCE",
      paymentMethod: "bank_transfer",
      currency: "MYR",
      allocations: [{ ownerStatementPeriodId: period.id, allocatedAmount: "100.00" }],
      idempotencyKey: randomUUID(),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const db = getDb();
    const row = await db.ownerLedgerEntry.findUniqueOrThrow({ where: { id: res.data.entryId } });
    expect(row.remittanceNumber).toMatch(/^REM-\d{4,}$/);
  });

  it("(flag ON) mints REM-<seq> on a PRE_STATEMENT_REMITTANCE payout too (under-allocated is legal for this kind)", async () => {
    process.env.ENABLE_OWNER_DOC_NUMBERING = "true";
    await seedIncomeRow("1000.00");
    const period = await seedPeriod();

    const res = await recordRemittanceService(actor, {
      ownerPartyId: OWNER,
      amount: "100.00",
      effectiveDate: EFFECTIVE_DATE,
      settlementKind: "PRE_STATEMENT_REMITTANCE",
      paymentMethod: "bank_transfer",
      currency: "MYR",
      allocations: [{ ownerStatementPeriodId: period.id, allocatedAmount: "40.00" }],
      idempotencyKey: randomUUID(),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const db = getDb();
    const row = await db.ownerLedgerEntry.findUniqueOrThrow({ where: { id: res.data.entryId } });
    expect(row.remittanceNumber).toMatch(/^REM-\d{4,}$/);
  });

  it("(flag OFF) records the remittance but leaves remittanceNumber null", async () => {
    // ENABLE_OWNER_DOC_NUMBERING intentionally left unset (beforeEach forces dark).
    await seedIncomeRow("1000.00");
    const period = await seedPeriod();

    const res = await recordRemittanceService(actor, {
      ownerPartyId: OWNER,
      amount: "100.00",
      effectiveDate: EFFECTIVE_DATE,
      settlementKind: "OWNER_REMITTANCE",
      paymentMethod: "bank_transfer",
      currency: "MYR",
      allocations: [{ ownerStatementPeriodId: period.id, allocatedAmount: "100.00" }],
      idempotencyKey: randomUUID(),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const db = getDb();
    const row = await db.ownerLedgerEntry.findUniqueOrThrow({ where: { id: res.data.entryId } });
    expect(row.remittanceNumber).toBeNull();
  });

  it("(flag ON) a REPLAYED (identical key+payload) request does not mint a second number", async () => {
    process.env.ENABLE_OWNER_DOC_NUMBERING = "true";
    await seedIncomeRow("1000.00");
    const period = await seedPeriod();
    const key = randomUUID();
    const payload = {
      ownerPartyId: OWNER,
      amount: "100.00",
      effectiveDate: EFFECTIVE_DATE,
      settlementKind: "OWNER_REMITTANCE" as const,
      paymentMethod: "bank_transfer" as const,
      currency: "MYR" as const,
      allocations: [{ ownerStatementPeriodId: period.id, allocatedAmount: "100.00" }],
      idempotencyKey: key,
    };

    const first = await recordRemittanceService(actor, payload);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await recordRemittanceService(actor, payload);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    // Replay returns the SAME entry — never a second row, never a second number.
    expect(second.data.entryId).toBe(first.data.entryId);

    const db = getDb();
    expect(await db.ownerLedgerEntry.count({ where: { organizationId: ORG, settlementKind: "OWNER_REMITTANCE" } })).toBe(1);
  });

  it("(flag ON) the reversal of a numbered OWNER_REMITTANCE has remittanceNumber null (not new cash-out)", async () => {
    process.env.ENABLE_OWNER_DOC_NUMBERING = "true";
    await seedIncomeRow("1000.00");
    const period = await seedPeriod();

    const original = await recordRemittanceService(actor, {
      ownerPartyId: OWNER,
      amount: "100.00",
      effectiveDate: EFFECTIVE_DATE,
      settlementKind: "OWNER_REMITTANCE",
      paymentMethod: "bank_transfer",
      currency: "MYR",
      allocations: [{ ownerStatementPeriodId: period.id, allocatedAmount: "100.00" }],
      idempotencyKey: randomUUID(),
    });
    expect(original.ok).toBe(true);
    if (!original.ok) return;

    const db = getDb();
    const originalRow = await db.ownerLedgerEntry.findUniqueOrThrow({ where: { id: original.data.entryId } });
    expect(originalRow.remittanceNumber).toMatch(/^REM-\d{4,}$/); // sanity: original WAS numbered

    const reversed = await reverseRemittanceService(actor, original.data.entryId, {
      reason: "test reversal for P1 numbering",
      idempotencyKey: randomUUID(),
    });
    expect(reversed.ok).toBe(true);
    if (!reversed.ok) return;

    const reversalRow = await db.ownerLedgerEntry.findUniqueOrThrow({ where: { id: reversed.data.entryId } });
    expect(reversalRow.reversalOfEntryId).toBe(original.data.entryId);
    expect(reversalRow.remittanceNumber).toBeNull();

    // The ORIGINAL's own number is untouched by the reversal.
    const originalAfter = await db.ownerLedgerEntry.findUniqueOrThrow({ where: { id: original.data.entryId } });
    expect(originalAfter.remittanceNumber).toBe(originalRow.remittanceNumber);
  });

  it("(flag ON) an OWNER_RECEIVABLE_OFFSET payout (recordOffsetService) has remittanceNumber null (not cash-out)", async () => {
    process.env.ENABLE_OWNER_DOC_NUMBERING = "true";
    await seedIncomeRow("1000.00"); // available payable, so OFFSET_EXCEEDS_PAYABLE doesn't fire
    const lineAllocations = await seedIvownInvoice([{ amount: "60.00" }]);

    const res = await recordOffsetService(actor, {
      ownerPartyId: OWNER,
      effectiveDate: EFFECTIVE_DATE,
      currency: "MYR",
      lineAllocations,
      idempotencyKey: randomUUID(),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const db = getDb();
    const row = await db.ownerLedgerEntry.findUniqueOrThrow({ where: { id: res.data.entryId } });
    expect(row.settlementKind).toBe("OWNER_RECEIVABLE_OFFSET");
    expect(row.remittanceNumber).toBeNull();
  });
});
