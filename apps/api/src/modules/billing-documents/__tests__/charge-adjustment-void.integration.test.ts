/**
 * Phase 4.1 — VOID a charge-scoped credit/debit note (safe-default BLOCK),
 * TENANT-ONLY, flag-gated — real LOCAL Postgres (opt-in RUN_INTEGRATION=1).
 *
 * There are NO reversal rails for a spent CreditApplication or a Refund, so
 * void is allowed only when the note has no such downstream settlement;
 * otherwise 409. Never mutates/deletes issued history — void flips
 * documentStatus to CANCELLED and reverses the charge's outstandingAmount.
 *
 * Run (localhost DB):
 *   cd apps/api
 *   RUN_INTEGRATION=1 ENABLE_PHASE2_BILLING_DOCS=1 ENABLE_PHASE2_INVOICE_ADJUSTMENTS=1 \
 *     npx vitest run src/modules/billing-documents/__tests__/charge-adjustment-void.integration.test.ts
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getDb } from "@kason/db";
import { createChargeAdjustmentService } from "../charge-adjustment.service";
import { voidChargeAdjustmentService } from "../charge-adjustment-void.service";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
  process.env.ENABLE_PHASE2_BILLING_DOCS = "1";
  process.env.ENABLE_PHASE2_INVOICE_ADJUSTMENTS = "1";
}

// Fixed disjoint UUIDs (prefix b760; unused by any other suite)
const ORG = "b7600000-0000-4000-8000-000000000001";
const USER = "b7600000-0000-4000-8000-000000000002";
const TENANT = "b7600000-0000-4000-8000-000000000003";
const OWNER = "b7600000-0000-4000-8000-000000000009";
const CAT = "b7600000-0000-4000-8000-000000000004";
const SERIES_DEP = "b7600000-0000-4000-8000-000000000005";
const SERIES_CN = "b7600000-0000-4000-8000-000000000006";
const SERIES_DN = "b7600000-0000-4000-8000-000000000007";
const SESSION = { orgId: ORG, userId: USER, role: "admin" };

async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  await db.refund.deleteMany({ where: org });
  await db.creditApplication.deleteMany({ where: org });
  await db.paymentAllocation.deleteMany({ where: org });
  await db.payment.deleteMany({ where: org });
  await db.chargeEvent.deleteMany({ where: org });
  await db.billingDocumentLine.deleteMany({ where: { document: org } });
  await db.billingDocument.deleteMany({ where: org });
  await db.charge.deleteMany({ where: org });
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
      id: ORG, name: "B760 Void Adjustment Test Org", slug: `org-${ORG}`, status: "active",
      defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free",
    },
  });
  await db.user.create({
    data: {
      id: USER, organizationId: ORG, email: "b760@test.local", passwordHash: "x", role: "admin",
      fullName: "B760 Admin", status: "active", userType: "operator",
    },
  });
  await db.party.create({
    data: { id: TENANT, organizationId: ORG, displayName: "B760 Tenant", partyType: "individual", status: "active" },
  });
  await db.party.create({
    data: { id: OWNER, organizationId: ORG, displayName: "B760 Owner", partyType: "individual", status: "active" },
  });
  await db.documentSeries.create({
    data: { id: SERIES_DEP, organizationId: ORG, code: "DEP", prefix: "DEP", padding: 4, includeYear: false, active: true },
  });
  await db.documentSeries.create({
    data: { id: SERIES_CN, organizationId: ORG, code: "CN", prefix: "CN", padding: 4, includeYear: false, active: true },
  });
  await db.documentSeries.create({
    data: { id: SERIES_DN, organizationId: ORG, code: "DN", prefix: "DN", padding: 4, includeYear: false, active: true },
  });
  await db.chargeCategory.create({
    data: {
      id: CAT, organizationId: ORG, code: "utility_tnb", name: "Electricity",
      family: "pay_back_landlord", docType: "debit_note", seriesId: SERIES_DEP,
      defaultSstRate: 0, eInvoiceEligible: false, ledgerCategory: "utility_income",
      isSystem: true, active: true, sortOrder: 1,
    },
  });
}

/** Seed a posted charge + an issued invoice document (1 line) for it. counterpartyType defaults tenant. */
async function seedInvoiceCharge(opts: {
  chargeId: string;
  docId: string;
  documentNumber: string;
  description: string;
  amount: string;
  outstanding: string;
  status: string;
  counterpartyType?: "tenant" | "owner";
}) {
  const db = getDb();
  const partyId = (opts.counterpartyType ?? "tenant") === "owner" ? OWNER : TENANT;
  await db.charge.create({
    data: {
      id: opts.chargeId, organizationId: ORG, chargeNumber: `B760-${opts.chargeId.slice(-6)}`,
      partyId, chargeType: "utility", categoryId: CAT, status: opts.status,
      postedAt: new Date(), description: opts.description, dueDate: new Date("2026-06-30"),
      amount: opts.amount, currency: "MYR", outstandingAmount: opts.outstanding,
      billingMonth: new Date("2026-06-01"),
    },
  });
  await db.billingDocument.create({
    data: {
      id: opts.docId, organizationId: ORG, docType: "invoice",
      documentNumber: opts.documentNumber, seriesId: SERIES_DEP, status: "issued",
      issuedById: USER, counterpartyType: opts.counterpartyType ?? "tenant", partyId,
      billingMonth: new Date("2026-06-01"),
      subtotal: opts.amount, sstAmount: 0, total: opts.amount,
      lines: {
        create: [{
          chargeId: opts.chargeId, categoryId: CAT, description: opts.description,
          amount: opts.amount, sstRate: 0, sstAmount: 0,
        }],
      },
    },
  });
}

/** Seed a posted+cleared Payment fully allocated to one charge (simulates a paid invoice). */
async function seedPaidPayment(opts: { paymentId: string; chargeId: string; amount: string }) {
  const db = getDb();
  await db.payment.create({
    data: {
      id: opts.paymentId, organizationId: ORG, paymentNumber: `B760-PMT-${opts.paymentId.slice(-6)}`,
      partyId: TENANT, paymentType: "manual", paymentMethod: "bank_transfer", status: "posted",
      amount: opts.amount, currency: "MYR", receivedAt: new Date("2026-06-05"),
    },
  });
  await db.paymentAllocation.create({
    data: {
      organizationId: ORG, paymentId: opts.paymentId, chargeId: opts.chargeId,
      allocatedAmount: opts.amount, allocatedAt: new Date("2026-06-05"),
    },
  });
}

// Fixed row ids
const C1 = "b7600000-0000-4000-8000-000000000011";
const D1 = "b7600000-0000-4000-8000-000000000012";

dn("void charge-scoped credit/debit note (integration)", () => {
  beforeEach(async () => {
    await cleanup();
    await seedBase();
  });
  afterAll(cleanup);

  it("B1: void an UNAPPLIED credit note restores outstanding, CANCELLED, history preserved", async () => {
    await seedInvoiceCharge({
      chargeId: C1, docId: D1, documentNumber: "DEP-9101", description: "Water",
      amount: "123.00", outstanding: "123.00", status: "posted",
    });
    const created = await createChargeAdjustmentService(SESSION, {
      chargeId: C1, kind: "credit", amount: "23.00", reason: "over-read correction",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    // Sanity: outstanding reduced 123 -> 100 by the create path.
    const db = getDb();
    let charge = await db.charge.findUniqueOrThrow({ where: { id: C1 } });
    expect(Number(charge.outstandingAmount.toString())).toBe(100);

    const result = await voidChargeAdjustmentService(SESSION, created.data.id, { reason: "wrong reading, void" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(200);
    expect(result.data.documentStatus).toBe("CANCELLED");
    expect(result.data.id).toBe(created.data.id);

    charge = await db.charge.findUniqueOrThrow({ where: { id: C1 } });
    expect(Number(charge.outstandingAmount.toString())).toBe(123);

    // History preserved: note row still exists, CANCELLED, not deleted.
    const note = await db.billingDocument.findUniqueOrThrow({ where: { id: created.data.id } });
    expect(note.documentStatus).toBe("CANCELLED");
    expect(note.docType).toBe("credit_note");
    expect(note.total.toString()).toBe("23");

    // Formula-B adjustedTotal (active notes only) is back to the original 123 —
    // the voided note (documentStatus CANCELLED) drops out of ACTIVE_ADJUSTMENT_NOTE_STATUSES.
    const notes = await db.billingDocument.findMany({
      where: { organizationId: ORG, originalDocumentId: D1, documentStatus: "ISSUED" },
    });
    const adjusted = notes.reduce(
      (s, n) => (n.docType === "debit_note" ? s + Number(n.total.toString()) : s - Number(n.total.toString())),
      123,
    );
    expect(adjusted).toBe(123);
  });

  it("B2: void an UNPAID debit note removes the increment, sets CANCELLED", async () => {
    await seedInvoiceCharge({
      chargeId: C1, docId: D1, documentNumber: "DEP-9102", description: "Electricity",
      amount: "400.00", outstanding: "400.00", status: "posted",
    });
    const created = await createChargeAdjustmentService(SESSION, {
      chargeId: C1, kind: "debit", amount: "50.00", reason: "meter correction",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const db = getDb();
    let charge = await db.charge.findUniqueOrThrow({ where: { id: C1 } });
    expect(Number(charge.outstandingAmount.toString())).toBe(450);

    const result = await voidChargeAdjustmentService(SESSION, created.data.id, { reason: "meter correction reverted" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.documentStatus).toBe("CANCELLED");

    charge = await db.charge.findUniqueOrThrow({ where: { id: C1 } });
    expect(Number(charge.outstandingAmount.toString())).toBe(400);

    const note = await db.billingDocument.findUniqueOrThrow({ where: { id: created.data.id } });
    expect(note.documentStatus).toBe("CANCELLED");
    expect(note.docType).toBe("debit_note");
  });

  it("B3: void recalculates settlement — paid invoice + DN -> PARTIALLY_PAID; void DN -> back to PAID", async () => {
    await seedInvoiceCharge({
      chargeId: C1, docId: D1, documentNumber: "DEP-9103", description: "Sewerage",
      amount: "100.00", outstanding: "0.00", status: "paid",
    });
    await seedPaidPayment({ paymentId: "b7600000-0000-4000-8000-0000000000c1", chargeId: C1, amount: "100.00" });

    const created = await createChargeAdjustmentService(SESSION, {
      chargeId: C1, kind: "debit", amount: "50.00", reason: "extra charge",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const db = getDb();
    let invoice = await db.billingDocument.findUniqueOrThrow({ where: { id: D1 } });
    expect(invoice.settlementStatus).toBe("PARTIALLY_PAID");

    const result = await voidChargeAdjustmentService(SESSION, created.data.id, { reason: "revert" });
    expect(result.ok).toBe(true);

    invoice = await db.billingDocument.findUniqueOrThrow({ where: { id: D1 } });
    expect(invoice.settlementStatus).toBe("PAID");
    const charge = await db.charge.findUniqueOrThrow({ where: { id: C1 } });
    expect(Number(charge.outstandingAmount.toString())).toBe(0);
  });

  it("B9: voiding a non-note docType (the invoice itself) is rejected 400 NOT_A_NOTE, nothing mutated", async () => {
    await seedInvoiceCharge({
      chargeId: C1, docId: D1, documentNumber: "DEP-9109", description: "Rent",
      amount: "100.00", outstanding: "100.00", status: "posted",
    });
    const result = await voidChargeAdjustmentService(SESSION, D1, { reason: "test" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
    expect(result.error).toBe("NOT_A_NOTE");

    const db = getDb();
    const invoice = await db.billingDocument.findUniqueOrThrow({ where: { id: D1 } });
    expect(invoice.documentStatus).toBe("ISSUED");
  });

  it("B13: voiding a nonexistent (incl. cross-org) note id is rejected 400 NOT_A_NOTE, never leaking existence", async () => {
    const result = await voidChargeAdjustmentService(SESSION, "b7600000-0000-4000-8000-0000000000ff", { reason: "test" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
    expect(result.error).toBe("NOT_A_NOTE");
  });

  it("B10: voiding a note with no charge-scoped line (all lines chargeId=null) is rejected 400 NOT_CHARGE_SCOPED", async () => {
    await seedInvoiceCharge({
      chargeId: C1, docId: D1, documentNumber: "DEP-9110", description: "Rent",
      amount: "100.00", outstanding: "100.00", status: "posted",
    });
    const db = getDb();
    const overpaymentCn = "b7600000-0000-4000-8000-0000000000e1";
    await db.billingDocument.create({
      data: {
        id: overpaymentCn, organizationId: ORG, docType: "credit_note", documentNumber: "CN-9110",
        seriesId: SERIES_CN, status: "issued", documentStatus: "ISSUED", issuedById: USER,
        counterpartyType: "tenant", partyId: TENANT, originalDocumentId: D1,
        creditAmount: "10.00", subtotal: "10.00", sstAmount: 0, total: "10.00",
        // Overpayment-CN line shape (R12a): chargeId + categoryId both null.
        lines: { create: [{ chargeId: null, categoryId: null, description: "overpayment", amount: "10.00", sstRate: 0, sstAmount: 0 }] },
      },
    });

    const result = await voidChargeAdjustmentService(SESSION, overpaymentCn, { reason: "test" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
    expect(result.error).toBe("NOT_CHARGE_SCOPED");
  });

  it("B6: voiding a note linked to an OWNER invoice now succeeds (seam #4 removed the 403) and reverses the outstanding reduction", async () => {
    const ownerChargeId = "b7600000-0000-4000-8000-000000000031";
    const ownerDocId = "b7600000-0000-4000-8000-000000000032";
    await seedInvoiceCharge({
      chargeId: ownerChargeId, docId: ownerDocId, documentNumber: "IVOWN-9106", description: "Management fee",
      // outstanding=80: the state a properly-issued CN(20) would already have left behind
      // (100 − 20), so voiding it should restore outstanding to 100.
      amount: "100.00", outstanding: "80.00", status: "posted", counterpartyType: "owner",
    });
    const db = getDb();
    const ownerCn = "b7600000-0000-4000-8000-000000000033";
    await db.billingDocument.create({
      data: {
        id: ownerCn, organizationId: ORG, docType: "credit_note", documentNumber: "CN-9106",
        seriesId: SERIES_CN, status: "issued", documentStatus: "ISSUED", issuedById: USER,
        counterpartyType: "owner", partyId: OWNER, originalDocumentId: ownerDocId,
        creditAmount: "0.00", subtotal: "20.00", sstAmount: 0, total: "20.00",
        lines: { create: [{ chargeId: ownerChargeId, categoryId: CAT, description: "owner correction", amount: "20.00", sstRate: 0, sstAmount: 0 }] },
      },
    });

    const result = await voidChargeAdjustmentService(SESSION, ownerCn, { reason: "test" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(200);
    expect(result.data.documentStatus).toBe("CANCELLED");

    const note = await db.billingDocument.findUniqueOrThrow({ where: { id: ownerCn } });
    expect(note.documentStatus).toBe("CANCELLED");
    const charge = await db.charge.findUniqueOrThrow({ where: { id: ownerChargeId } });
    expect(Number(charge.outstandingAmount.toString())).toBe(100);
  });

  it("B11: voiding a note whose charge is already status=credited is rejected 400 CHARGE_FULLY_CREDITED_USE_CORRECTION", async () => {
    await seedInvoiceCharge({
      chargeId: C1, docId: D1, documentNumber: "DEP-9111", description: "Aircond",
      amount: "100.00", outstanding: "100.00", status: "posted",
    });
    const created = await createChargeAdjustmentService(SESSION, {
      chargeId: C1, kind: "debit", amount: "20.00", reason: "test",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const db = getDb();
    // Simulate the OTHER correction path (voidPostedChargeWithCreditNote) having
    // since fully credited this charge.
    await db.charge.update({ where: { id: C1 }, data: { status: "credited", outstandingAmount: "0.00" } });

    const result = await voidChargeAdjustmentService(SESSION, created.data.id, { reason: "test" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
    expect(result.error).toBe("CHARGE_FULLY_CREDITED_USE_CORRECTION");

    const note = await db.billingDocument.findUniqueOrThrow({ where: { id: created.data.id } });
    expect(note.documentStatus).toBe("ISSUED");
    const charge = await db.charge.findUniqueOrThrow({ where: { id: C1 } });
    expect(Number(charge.outstandingAmount.toString())).toBe(0);
  });

  it("B4: BLOCK — a credit note whose spendable credit has a CreditApplication is rejected 409, nothing mutated", async () => {
    await seedInvoiceCharge({
      chargeId: C1, docId: D1, documentNumber: "DEP-9104", description: "Sewerage",
      amount: "100.00", outstanding: "0.00", status: "paid",
    });
    const created = await createChargeAdjustmentService(SESSION, {
      chargeId: C1, kind: "credit", amount: "30.00", reason: "billed twice",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.data.creditAmount).toBe("30.00");

    const db = getDb();
    const appliedPaymentId = "b7600000-0000-4000-8000-0000000000a1";
    await db.payment.create({
      data: {
        id: appliedPaymentId, organizationId: ORG, paymentNumber: "B760-CNA-1", partyId: TENANT,
        paymentType: "credit_application", paymentMethod: "credit_note", status: "posted",
        amount: "30.00", currency: "MYR", receivedAt: new Date(),
      },
    });
    await db.creditApplication.create({
      data: { organizationId: ORG, creditDocumentId: created.data.id, paymentId: appliedPaymentId, appliedById: USER },
    });

    const result = await voidChargeAdjustmentService(SESSION, created.data.id, { reason: "test" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(result.error).toBe("NOTE_HAS_DOWNSTREAM_SETTLEMENTS");

    const note = await db.billingDocument.findUniqueOrThrow({ where: { id: created.data.id } });
    expect(note.documentStatus).toBe("ISSUED");
    const charge = await db.charge.findUniqueOrThrow({ where: { id: C1 } });
    expect(Number(charge.outstandingAmount.toString())).toBe(0);
  });

  it("B14: BLOCK — a credit note whose spendable credit was refunded (refund_note + Refund linked) is rejected 409, nothing mutated", async () => {
    await seedInvoiceCharge({
      chargeId: C1, docId: D1, documentNumber: "DEP-9114", description: "Sewerage",
      amount: "100.00", outstanding: "0.00", status: "paid",
    });
    const created = await createChargeAdjustmentService(SESSION, {
      chargeId: C1, kind: "credit", amount: "40.00", reason: "billed twice",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const db = getDb();
    const rnId = "b7600000-0000-4000-8000-0000000000b1";
    await db.billingDocument.create({
      data: {
        id: rnId, organizationId: ORG, docType: "refund_note", documentNumber: "RN-9114",
        seriesId: SERIES_CN, status: "issued", documentStatus: "ISSUED", issuedById: USER,
        counterpartyType: "tenant", partyId: TENANT, originalDocumentId: created.data.id,
        subtotal: "40.00", sstAmount: 0, total: "40.00",
      },
    });
    const refundPaymentId = "b7600000-0000-4000-8000-0000000000b2";
    await db.payment.create({
      data: {
        id: refundPaymentId, organizationId: ORG, paymentNumber: "B760-PMT-refund", partyId: TENANT,
        paymentType: "manual", paymentMethod: "bank_transfer", status: "posted",
        amount: "40.00", currency: "MYR", receivedAt: new Date(),
      },
    });
    await db.refund.create({
      data: {
        organizationId: ORG, refundNoteDocumentId: rnId, originalPaymentId: refundPaymentId,
        amount: "40.00", method: "bank_transfer", refundedAt: new Date(), recordedById: USER,
      },
    });

    const result = await voidChargeAdjustmentService(SESSION, created.data.id, { reason: "test" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(result.error).toBe("NOTE_HAS_DOWNSTREAM_SETTLEMENTS");

    const note = await db.billingDocument.findUniqueOrThrow({ where: { id: created.data.id } });
    expect(note.documentStatus).toBe("ISSUED");
  });

  it("B5: BLOCK — a debit note whose charge outstanding was reduced below the note total is rejected 409, nothing mutated", async () => {
    await seedInvoiceCharge({
      chargeId: C1, docId: D1, documentNumber: "DEP-9105", description: "Electricity",
      amount: "400.00", outstanding: "400.00", status: "posted",
    });
    const created = await createChargeAdjustmentService(SESSION, {
      chargeId: C1, kind: "debit", amount: "50.00", reason: "meter correction",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const db = getDb();
    // Simulate a payment collecting 420 of the 450 outstanding — 30 remains,
    // strictly less than the DN's own 50 total.
    await db.charge.update({ where: { id: C1 }, data: { outstandingAmount: "30.00" } });

    const result = await voidChargeAdjustmentService(SESSION, created.data.id, { reason: "test" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(result.error).toBe("NOTE_HAS_DOWNSTREAM_SETTLEMENTS");

    const note = await db.billingDocument.findUniqueOrThrow({ where: { id: created.data.id } });
    expect(note.documentStatus).toBe("ISSUED");
    const charge = await db.charge.findUniqueOrThrow({ where: { id: C1 } });
    expect(Number(charge.outstandingAmount.toString())).toBe(30);
  });

  it("B15: boundary — outstanding exactly equal to the DN total is NOT blocked, void succeeds", async () => {
    await seedInvoiceCharge({
      chargeId: C1, docId: D1, documentNumber: "DEP-9115", description: "Electricity",
      amount: "400.00", outstanding: "400.00", status: "posted",
    });
    const created = await createChargeAdjustmentService(SESSION, {
      chargeId: C1, kind: "debit", amount: "50.00", reason: "meter correction",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const db = getDb();
    // Outstanding == note.total exactly (50) — the `<` guard must not block this.
    await db.charge.update({ where: { id: C1 }, data: { outstandingAmount: "50.00" } });

    const result = await voidChargeAdjustmentService(SESSION, created.data.id, { reason: "test" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.documentStatus).toBe("CANCELLED");

    const charge = await db.charge.findUniqueOrThrow({ where: { id: C1 } });
    expect(Number(charge.outstandingAmount.toString())).toBe(0);
  });

  it("B7: idempotent — void twice sequentially -> second is a 200 no-op, single CANCELLED, no double restore", async () => {
    await seedInvoiceCharge({
      chargeId: C1, docId: D1, documentNumber: "DEP-9107", description: "Water",
      amount: "123.00", outstanding: "123.00", status: "posted",
    });
    const created = await createChargeAdjustmentService(SESSION, {
      chargeId: C1, kind: "credit", amount: "23.00", reason: "over-read",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const first = await voidChargeAdjustmentService(SESSION, created.data.id, { reason: "void 1" });
    const second = await voidChargeAdjustmentService(SESSION, created.data.id, { reason: "void 2" });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.data.documentStatus).toBe("CANCELLED");

    const db = getDb();
    const charge = await db.charge.findUniqueOrThrow({ where: { id: C1 } });
    // NOT double-restored: 123 (original) -> not 123+23=146.
    expect(Number(charge.outstandingAmount.toString())).toBe(123);

    const events = await db.chargeEvent.count({
      where: { organizationId: ORG, chargeId: C1, eventType: "charge_adjustment_voided" },
    });
    expect(events).toBe(1);
    const audits = await db.auditLog.count({
      where: { organizationId: ORG, action: "billing-docs.charge_adjustment.void", entityId: created.data.id },
    });
    expect(audits).toBe(1);
  });

  it("B19: true concurrent double-void (Promise.all) on the SAME note serializes to exactly one restore", async () => {
    await seedInvoiceCharge({
      chargeId: C1, docId: D1, documentNumber: "DEP-9119", description: "Water",
      amount: "123.00", outstanding: "123.00", status: "posted",
    });
    const created = await createChargeAdjustmentService(SESSION, {
      chargeId: C1, kind: "credit", amount: "23.00", reason: "over-read",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const [a, b] = await Promise.all([
      voidChargeAdjustmentService(SESSION, created.data.id, { reason: "race A" }),
      voidChargeAdjustmentService(SESSION, created.data.id, { reason: "race B" }),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);

    const db = getDb();
    const charge = await db.charge.findUniqueOrThrow({ where: { id: C1 } });
    expect(Number(charge.outstandingAmount.toString())).toBe(123);
    const events = await db.chargeEvent.count({
      where: { organizationId: ORG, chargeId: C1, eventType: "charge_adjustment_voided" },
    });
    expect(events).toBe(1);
  });

  it("B17: voiding one note on a charge with a sibling active note leaves the sibling untouched", async () => {
    await seedInvoiceCharge({
      chargeId: C1, docId: D1, documentNumber: "DEP-9117", description: "Electricity",
      amount: "100.00", outstanding: "100.00", status: "posted",
    });
    const dn = await createChargeAdjustmentService(SESSION, {
      chargeId: C1, kind: "debit", amount: "30.00", reason: "extra usage",
    });
    expect(dn.ok).toBe(true);
    if (!dn.ok) return;
    // outstanding now 130.
    const cn = await createChargeAdjustmentService(SESSION, {
      chargeId: C1, kind: "credit", amount: "20.00", reason: "correction",
    });
    expect(cn.ok).toBe(true);
    if (!cn.ok) return;
    // outstanding now 110 (130 - 20, fully reduces since unpaid).

    const result = await voidChargeAdjustmentService(SESSION, cn.data.id, { reason: "void the CN" });
    expect(result.ok).toBe(true);

    const db = getDb();
    const charge = await db.charge.findUniqueOrThrow({ where: { id: C1 } });
    // Back to 130 (the DN's +30 stays intact — only the CN's -20 unwound).
    expect(Number(charge.outstandingAmount.toString())).toBe(130);

    const dnNote = await db.billingDocument.findUniqueOrThrow({ where: { id: dn.data.id } });
    expect(dnNote.documentStatus).toBe("ISSUED");
    expect(dnNote.total.toString()).toBe("30");
  });
});
