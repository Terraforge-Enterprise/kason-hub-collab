/**
 * Task 3 (seam #2) — frozen-period guard on OWNER charge-adjustment
 * create + void, real LOCAL Postgres (opt-in RUN_INTEGRATION=1).
 *
 * assertPeriodOpen is keyed on the LINKED owner charge's billingMonth (never
 * a client-supplied note date) and is placed ABOVE the existing owner 403
 * guard in both services — it fires even while owner create/void stay
 * disabled, so the guard is testable NOW and survives Task 4's later removal
 * of the two 403 returns unchanged.
 *
 * Run (localhost DB):
 *   cd apps/api
 *   set -a; . ../../.env; set +a
 *   RUN_INTEGRATION=1 ENABLE_PHASE2_INVOICE_ADJUSTMENTS=true \
 *     ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER=true ENABLE_PHASE2_OWNER_BILLING=true \
 *     npx vitest run src/modules/billing-documents/__tests__/charge-adjustment-frozen-period.integration.test.ts
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getDb } from "@kason/db";
import { createChargeAdjustmentService } from "../charge-adjustment.service";
import { voidChargeAdjustmentService } from "../charge-adjustment-void.service";
import { ClosedPeriodError } from "../../owner-ledger/closed-period";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
  process.env.ENABLE_PHASE2_BILLING_DOCS = "1";
  process.env.ENABLE_PHASE2_INVOICE_ADJUSTMENTS = "1";
  process.env.ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER = "1";
}

// Fixed disjoint UUIDs (mnemonic prefix f2pg; hex f2c9 — unused by any other suite)
const ORG = "f2c90000-0000-4000-8000-000000000001";
const USER = "f2c90000-0000-4000-8000-000000000002";
const OWNER = "f2c90000-0000-4000-8000-000000000003";
const CAT = "f2c90000-0000-4000-8000-000000000004";
const SERIES_DEP = "f2c90000-0000-4000-8000-000000000005";
const SERIES_CN = "f2c90000-0000-4000-8000-000000000006";
const SESSION = { orgId: ORG, userId: USER, role: "admin" };

// Frozen month (2026-06) — an OwnerStatementPeriod row is seeded frozen for
// it. Open month (2026-08) — no period row, so assertPeriodOpen's own
// "no period yet ⇒ allowed" no-op path is what's under test.
const FROZEN_MONTH = new Date("2026-06-01");
const FROZEN_PERIOD = new Date(Date.UTC(2026, 5, 1));
const OPEN_MONTH = new Date("2026-08-01");

async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  await db.chargeEvent.deleteMany({ where: org });
  await db.billingDocumentLine.deleteMany({ where: { document: org } });
  await db.billingDocument.deleteMany({ where: org });
  await db.charge.deleteMany({ where: org });
  await db.ownerStatementPeriod.deleteMany({ where: org });
  await db.referenceSequence.deleteMany({ where: org });
  await db.chargeCategory.deleteMany({ where: org });
  await db.documentSeries.deleteMany({ where: org });
  await db.auditLog.deleteMany({ where: org });
  await db.user.deleteMany({ where: { id: USER } });
  await db.party.deleteMany({ where: org });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function seedBase() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG, name: "F2C9 Frozen-Period Adjustment Test Org", slug: `org-${ORG}`, status: "active",
      defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free",
    },
  });
  await db.user.create({
    data: {
      id: USER, organizationId: ORG, email: "f2c9@test.local", passwordHash: "x", role: "admin",
      fullName: "F2C9 Admin", status: "active", userType: "operator",
    },
  });
  await db.party.create({
    data: { id: OWNER, organizationId: ORG, displayName: "F2C9 Owner", partyType: "individual", status: "active" },
  });
  await db.documentSeries.create({
    data: { id: SERIES_DEP, organizationId: ORG, code: "DEP", prefix: "DEP", padding: 4, includeYear: false, active: true },
  });
  await db.documentSeries.create({
    data: { id: SERIES_CN, organizationId: ORG, code: "CN", prefix: "CN", padding: 4, includeYear: false, active: true },
  });
  await db.chargeCategory.create({
    data: {
      id: CAT, organizationId: ORG, code: "mgmt_fee", name: "Management fee",
      family: "pay_back_landlord", docType: "debit_note", seriesId: SERIES_DEP,
      defaultSstRate: 0, eInvoiceEligible: false, ledgerCategory: "utility_income",
      isSystem: true, active: true, sortOrder: 1,
    },
  });
}

/** Seed a posted OWNER charge + an issued IVOWN invoice document (1 line). */
async function seedOwnerInvoiceCharge(opts: {
  chargeId: string;
  docId: string;
  documentNumber: string;
  billingMonth: Date;
}) {
  const db = getDb();
  await db.charge.create({
    data: {
      id: opts.chargeId, organizationId: ORG, chargeNumber: `F2C9-${opts.chargeId.slice(-6)}`,
      partyId: OWNER, chargeType: "maintenance", categoryId: CAT, status: "posted",
      postedAt: new Date(), description: "Management fee", dueDate: opts.billingMonth,
      amount: "100.00", currency: "MYR", outstandingAmount: "100.00",
      billingMonth: opts.billingMonth,
    },
  });
  await db.billingDocument.create({
    data: {
      id: opts.docId, organizationId: ORG, docType: "invoice",
      documentNumber: opts.documentNumber, seriesId: SERIES_DEP, status: "issued",
      issuedById: USER, counterpartyType: "owner", partyId: OWNER,
      billingMonth: opts.billingMonth,
      subtotal: "100.00", sstAmount: 0, total: "100.00",
      lines: {
        create: [{
          chargeId: opts.chargeId, categoryId: CAT, description: "Management fee",
          amount: "100.00", sstRate: 0, sstAmount: 0,
        }],
      },
    },
  });
}

async function freezePeriod(periodMonth: Date) {
  await getDb().ownerStatementPeriod.create({
    data: {
      organizationId: ORG,
      ownerPartyId: OWNER,
      apartmentId: null,
      periodMonth,
      status: "frozen",
      idempotencyKey: `ownerstmt:${OWNER}:${periodMonth.toISOString().slice(0, 7)}`,
      sourceMaxUpdatedAt: new Date(),
    },
  });
}

// Fixed row ids
const C1 = "f2c90000-0000-4000-8000-000000000011";
const D1 = "f2c90000-0000-4000-8000-000000000012";
const C2 = "f2c90000-0000-4000-8000-000000000021";
const D2 = "f2c90000-0000-4000-8000-000000000022";
const CN2 = "f2c90000-0000-4000-8000-000000000023";
const C3 = "f2c90000-0000-4000-8000-000000000031";
const D3 = "f2c90000-0000-4000-8000-000000000032";

dn("owner charge-adjustment frozen-period guard (integration)", () => {
  beforeEach(async () => {
    await cleanup();
    await seedBase();
  });
  afterAll(cleanup);

  it("frozen create rejected: owner CREATE into a frozen statement month throws ClosedPeriodError, mints NO note, leaves outstanding untouched", async () => {
    await seedOwnerInvoiceCharge({ chargeId: C1, docId: D1, documentNumber: "IVOWN-F001", billingMonth: FROZEN_MONTH });
    await freezePeriod(FROZEN_PERIOD);

    await expect(
      createChargeAdjustmentService(SESSION, { chargeId: C1, kind: "credit", amount: "20.00", reason: "test" }),
    ).rejects.toBeInstanceOf(ClosedPeriodError);

    const db = getDb();
    const charge = await db.charge.findUniqueOrThrow({ where: { id: C1 } });
    expect(Number(charge.outstandingAmount.toString())).toBe(100);
    const notes = await db.billingDocument.count({ where: { organizationId: ORG, originalDocumentId: D1 } });
    expect(notes).toBe(0);
  });

  it("frozen void rejected: VOID of an existing active owner note in a frozen statement month throws ClosedPeriodError; note stays ISSUED, ledger unchanged", async () => {
    await seedOwnerInvoiceCharge({ chargeId: C2, docId: D2, documentNumber: "IVOWN-F002", billingMonth: FROZEN_MONTH });
    const db = getDb();
    // Directly-inserted active owner CN (mirrors charge-adjustment-void.integration.test.ts's
    // B6 fixture) — owner create is still 403-blocked, so this is the only way to get an
    // existing active owner note to attempt a void against.
    await db.billingDocument.create({
      data: {
        id: CN2, organizationId: ORG, docType: "credit_note", documentNumber: "CN-F002",
        seriesId: SERIES_CN, status: "issued", documentStatus: "ISSUED", issuedById: USER,
        counterpartyType: "owner", partyId: OWNER, originalDocumentId: D2,
        creditAmount: "0.00", subtotal: "20.00", sstAmount: 0, total: "20.00",
        lines: { create: [{ chargeId: C2, categoryId: CAT, description: "owner correction", amount: "20.00", sstRate: 0, sstAmount: 0 }] },
      },
    });
    await freezePeriod(FROZEN_PERIOD);

    await expect(
      voidChargeAdjustmentService(SESSION, CN2, { reason: "test" }),
    ).rejects.toBeInstanceOf(ClosedPeriodError);

    const note = await db.billingDocument.findUniqueOrThrow({ where: { id: CN2 } });
    expect(note.documentStatus).toBe("ISSUED");
    const charge = await db.charge.findUniqueOrThrow({ where: { id: C2 } });
    expect(Number(charge.outstandingAmount.toString())).toBe(100);
  });

  it("open month not blocked by frozen guard: owner CREATE in an OPEN month is a no-op for assertPeriodOpen and now succeeds (seam #4 removed the owner 403)", async () => {
    await seedOwnerInvoiceCharge({ chargeId: C3, docId: D3, documentNumber: "IVOWN-F003", billingMonth: OPEN_MONTH });
    // No OwnerStatementPeriod row seeded for OPEN_MONTH — "no period yet ⇒ allowed".

    const result = await createChargeAdjustmentService(SESSION, { chargeId: C3, kind: "credit", amount: "10.00", reason: "test" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(201);
    expect(result.data.docType).toBe("credit_note");
  });
});
