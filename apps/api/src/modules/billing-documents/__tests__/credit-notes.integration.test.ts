/**
 * voidPostedChargeWithCreditNote — real LOCAL Postgres (opt-in RUN_INTEGRATION=1).
 *
 * Proves: unpaid posted charge → full CN (creditAmount 0), charge credited,
 * outstanding 0, original doc offset; partially-paid RM100/RM40-paid → CN total
 * 100.00 with creditAmount 40.00 under hold_credit; absent handling on a paid
 * charge → 409 REVERT_PAYMENT_FIRST; refund → RN issuance + Refund row +
 * CN.creditAmount = collected − refund.amount (Task 8), over-refund → 400
 * REFUND_EXCEEDS_COLLECTED; legacy charge with NO document → plain void fallback.
 *
 * Run:
 *   cd apps/api
 *   RUN_INTEGRATION=1 ENABLE_PHASE2_OWNER_BILLING=1 ENABLE_PHASE2_BILLING_DOCS=1 \
 *     npx vitest run src/modules/billing-documents/__tests__/credit-notes.integration.test.ts
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getDb } from "@kason/db";
import { voidPostedChargeWithCreditNote } from "../credit-notes.service";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
  process.env.ENABLE_PHASE2_BILLING_DOCS = "1";
}

// Fixed disjoint UUIDs (prefix 9c30; unused by any other suite)
const ORG = "9c300000-0000-4000-8000-000000000001";
const USER = "9c300000-0000-4000-8000-000000000002";
const TENANT = "9c300000-0000-4000-8000-000000000003";
const CAT = "9c300000-0000-4000-8000-000000000004";
const SERIES_DEP = "9c300000-0000-4000-8000-000000000005";
const SERIES_CN = "9c300000-0000-4000-8000-000000000006";
const SERIES_RN = "9c300000-0000-4000-8000-000000000007";

async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  await db.refund.deleteMany({ where: org });
  await db.billingDocumentLine.deleteMany({ where: { document: org } });
  await db.billingDocument.deleteMany({ where: org });
  await db.paymentAllocation.deleteMany({ where: org });
  await db.payment.deleteMany({ where: org });
  await db.chargeEvent.deleteMany({ where: org });
  await db.charge.deleteMany({ where: org });
  await db.ownerLedgerEntry.deleteMany({ where: org });
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
      id: ORG, name: "P3 CN Test Org", slug: `org-${ORG}`, status: "active",
      defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free",
    },
  });
  await db.user.create({
    data: {
      id: USER, organizationId: ORG, email: "p3cn@test.local", passwordHash: "x", role: "admin",
      fullName: "P3 Admin", status: "active", userType: "operator",
    },
  });
  await db.party.create({
    data: { id: TENANT, organizationId: ORG, displayName: "CN Tenant", partyType: "individual", status: "active" },
  });
  await db.documentSeries.create({
    data: { id: SERIES_DEP, organizationId: ORG, code: "DEP", prefix: "DEP", padding: 4, includeYear: false, active: true },
  });
  await db.documentSeries.create({
    data: { id: SERIES_CN, organizationId: ORG, code: "CN", prefix: "CN", padding: 4, includeYear: false, active: true },
  });
  await db.documentSeries.create({
    data: { id: SERIES_RN, organizationId: ORG, code: "RN", prefix: "RN", padding: 4, includeYear: false, active: true },
  });
  await db.chargeCategory.create({
    data: {
      id: CAT, organizationId: ORG, code: "rental", name: "Monthly rental",
      family: "pay_back_landlord", docType: "debit_note", seriesId: SERIES_DEP,
      defaultSstRate: 0, eInvoiceEligible: false, ledgerCategory: "rental_income",
      isSystem: true, active: true, sortOrder: 1,
    },
  });
}

/** Seed a posted charge + its issued DEP debit-note document (1 line). */
async function seedChargeWithDocument(opts: {
  chargeId: string;
  docId: string;
  documentNumber: string;
  amount: string;
  outstanding: string;
  status: string;
}) {
  const db = getDb();
  await db.charge.create({
    data: {
      id: opts.chargeId, organizationId: ORG, chargeNumber: `CN-TEST-${opts.chargeId.slice(0, 8)}`,
      partyId: TENANT, chargeType: "rental", categoryId: CAT, status: opts.status,
      postedAt: new Date(), description: "Rent June", dueDate: new Date("2026-06-30"),
      amount: opts.amount, currency: "MYR", outstandingAmount: opts.outstanding,
      billingMonth: new Date("2026-06-01"),
    },
  });
  await db.billingDocument.create({
    data: {
      id: opts.docId, organizationId: ORG, docType: "debit_note",
      documentNumber: opts.documentNumber, seriesId: SERIES_DEP, status: "issued",
      issuedById: USER, counterpartyType: "tenant", partyId: TENANT,
      billingMonth: new Date("2026-06-01"),
      subtotal: opts.amount, sstAmount: 0, total: opts.amount,
      lines: {
        create: [{
          chargeId: opts.chargeId, categoryId: CAT, description: "Rent June",
          amount: opts.amount, sstRate: 0, sstAmount: 0,
        }],
      },
    },
  });
}

const C_UNPAID = "9c300000-0000-4000-8000-000000000011";
const D_UNPAID = "9c300000-0000-4000-8000-000000000012";
const C_PARTIAL = "9c300000-0000-4000-8000-000000000013";
const D_PARTIAL = "9c300000-0000-4000-8000-000000000014";
const C_LEGACY = "9c300000-0000-4000-8000-000000000015";

dn("voidPostedChargeWithCreditNote (integration)", () => {
  beforeEach(async () => {
    await cleanup();
    await seedBase();
  });
  afterAll(cleanup);

  it("unpaid posted charge → full CN, charge credited, outstanding 0, original offset", async () => {
    await seedChargeWithDocument({
      chargeId: C_UNPAID, docId: D_UNPAID, documentNumber: "DEP-9001",
      amount: "100.00", outstanding: "100.00", status: "posted",
    });
    const r = await voidPostedChargeWithCreditNote({
      organizationId: ORG, chargeId: C_UNPAID, reason: "posted in error",
      actorUserId: USER, actorRole: "admin",
    });
    expect(r.plainVoid).toBe(false);
    expect(r.creditNoteNumber).toMatch(/^CN-\d{4}$/);

    const db = getDb();
    const charge = await db.charge.findUniqueOrThrow({ where: { id: C_UNPAID } });
    expect(charge.status).toBe("credited");
    expect(Number(charge.outstandingAmount.toString())).toBe(0);
    expect(charge.cancelledReason).toBe("posted in error");

    const cn = await db.billingDocument.findUniqueOrThrow({ where: { id: r.creditNoteId! } });
    expect(cn.docType).toBe("credit_note");
    expect(cn.originalDocumentId).toBe(D_UNPAID);
    expect(Number(cn.total.toString())).toBe(100);
    expect(Number(cn.creditAmount!.toString())).toBe(0);

    const original = await db.billingDocument.findUniqueOrThrow({ where: { id: D_UNPAID } });
    expect(original.status).toBe("offset");

    const events = await db.chargeEvent.findMany({ where: { organizationId: ORG, chargeId: C_UNPAID } });
    expect(events.map((e) => e.eventType)).toContain("charge_credited");
  });

  it("partially-paid RM100 / RM40 collected + hold_credit → CN total 100.00, creditAmount 40.00", async () => {
    await seedChargeWithDocument({
      chargeId: C_PARTIAL, docId: D_PARTIAL, documentNumber: "DEP-9002",
      amount: "100.00", outstanding: "60.00", status: "partially_paid",
    });
    const r = await voidPostedChargeWithCreditNote({
      organizationId: ORG, chargeId: C_PARTIAL, reason: "tenant moved out mid-month",
      paidHandling: "hold_credit", actorUserId: USER, actorRole: "admin",
    });
    const db = getDb();
    const cn = await db.billingDocument.findUniqueOrThrow({ where: { id: r.creditNoteId! } });
    expect(Number(cn.total.toString())).toBe(100);
    expect(Number(cn.creditAmount!.toString())).toBe(40);
    const charge = await db.charge.findUniqueOrThrow({ where: { id: C_PARTIAL } });
    expect(charge.status).toBe("credited");
    expect(Number(charge.outstandingAmount.toString())).toBe(0);
  });

  it("collected money + NO strategy (and no paidHandling) → 400 STRATEGY_REQUIRED, nothing written", async () => {
    // R1: the old error_revert_first default (409 REVERT_PAYMENT_FIRST, forcing
    // the operator to un-record a real payment) is gone. A collected charge
    // corrected without an explicit strategy now yields 400 STRATEGY_REQUIRED.
    await seedChargeWithDocument({
      chargeId: C_PARTIAL, docId: D_PARTIAL, documentNumber: "DEP-9003",
      amount: "100.00", outstanding: "60.00", status: "partially_paid",
    });
    await expect(
      voidPostedChargeWithCreditNote({
        organizationId: ORG, chargeId: C_PARTIAL, reason: "mistake",
        actorUserId: USER, actorRole: "admin",
      }),
    ).rejects.toMatchObject({ status: 400, code: "STRATEGY_REQUIRED" });
    const db = getDb();
    const charge = await db.charge.findUniqueOrThrow({ where: { id: C_PARTIAL } });
    expect(charge.status).toBe("partially_paid"); // tx rolled back
    expect(await db.billingDocument.count({ where: { organizationId: ORG, docType: "credit_note" } })).toBe(0);
  });

  it("collected money + a legacy/unmapped paidHandling (error_revert_first) + no strategy → 400 STRATEGY_REQUIRED", async () => {
    // A stale client sending the removed error_revert_first value must NOT crash
    // or silently pass — it maps to no strategy → STRATEGY_REQUIRED.
    await seedChargeWithDocument({
      chargeId: C_PARTIAL, docId: D_PARTIAL, documentNumber: "DEP-9003b",
      amount: "100.00", outstanding: "60.00", status: "partially_paid",
    });
    await expect(
      voidPostedChargeWithCreditNote({
        organizationId: ORG, chargeId: C_PARTIAL, reason: "stale client",
        paidHandling: "error_revert_first", actorUserId: USER, actorRole: "admin",
      }),
    ).rejects.toMatchObject({ status: 400, code: "STRATEGY_REQUIRED" });
  });

  it("deprecated paidHandling 'hold_credit' (no strategy) → maps to CREDIT_ADJUSTMENT, CN succeeds", async () => {
    // One-release alias: the collected RM40 becomes spendable CN credit exactly
    // as before, without the caller supplying the R1 strategy.
    await seedChargeWithDocument({
      chargeId: C_PARTIAL, docId: D_PARTIAL, documentNumber: "DEP-9003c",
      amount: "100.00", outstanding: "60.00", status: "partially_paid",
    });
    const r = await voidPostedChargeWithCreditNote({
      organizationId: ORG, chargeId: C_PARTIAL, reason: "alias path",
      paidHandling: "hold_credit", actorUserId: USER, actorRole: "admin",
    });
    expect(r.plainVoid).toBe(false);
    const db = getDb();
    const cn = await db.billingDocument.findUniqueOrThrow({ where: { id: r.creditNoteId! } });
    expect(Number(cn.creditAmount!.toString())).toBe(40);
    const charge = await db.charge.findUniqueOrThrow({ where: { id: C_PARTIAL } });
    expect(charge.status).toBe("credited");
  });

  it("explicit strategy CREDIT_ADJUSTMENT (no paidHandling) → CN succeeds, allocation-keeping credit", async () => {
    await seedChargeWithDocument({
      chargeId: C_PARTIAL, docId: D_PARTIAL, documentNumber: "DEP-9003d",
      amount: "100.00", outstanding: "60.00", status: "partially_paid",
    });
    const r = await voidPostedChargeWithCreditNote({
      organizationId: ORG, chargeId: C_PARTIAL, reason: "explicit strategy",
      strategy: "CREDIT_ADJUSTMENT", actorUserId: USER, actorRole: "admin",
    });
    expect(r.plainVoid).toBe(false);
    const db = getDb();
    const cn = await db.billingDocument.findUniqueOrThrow({ where: { id: r.creditNoteId! } });
    expect(Number(cn.creditAmount!.toString())).toBe(40);
  });

  it("paidHandling refund → CN (creditAmount = collected − refund) + RN + Refund row", async () => {
    await seedChargeWithDocument({
      chargeId: C_PARTIAL, docId: D_PARTIAL, documentNumber: "DEP-9004",
      amount: "100.00", outstanding: "60.00", status: "partially_paid",
    });
    // The collected RM40 must have a real payment behind it for the refund to reference.
    const db = getDb();
    const payment = await db.payment.create({
      data: {
        organizationId: ORG, paymentNumber: "PAY-REFUND-SRC", partyId: TENANT,
        paymentType: "incoming", paymentMethod: "bank_transfer", status: "posted",
        amount: "40.00", currency: "MYR", receivedAt: new Date(),
      },
      select: { id: true },
    });
    await db.paymentAllocation.create({
      data: {
        organizationId: ORG, paymentId: payment.id, chargeId: C_PARTIAL,
        allocatedAmount: "40.00", allocatedAt: new Date(),
      },
    });

    const r = await voidPostedChargeWithCreditNote({
      organizationId: ORG, chargeId: C_PARTIAL, reason: "tenant refunded",
      paidHandling: "refund",
      refund: { amount: "40.00", method: "bank_transfer", bankRef: "MBB-777", refundedAt: "2026-07-02" },
      actorUserId: USER, actorRole: "admin",
    });
    expect(r.refundNoteNumber).toMatch(/^RN-\d{4}$/);

    const cn = await db.billingDocument.findUniqueOrThrow({ where: { id: r.creditNoteId! } });
    expect(Number(cn.creditAmount!.toString())).toBe(0); // fully refunded → no spendable credit

    const rn = await db.billingDocument.findFirstOrThrow({
      where: { organizationId: ORG, docType: "refund_note" },
    });
    expect(rn.originalDocumentId).toBe(D_PARTIAL);
    expect(Number(rn.total.toString())).toBe(40);

    const refund = await db.refund.findFirstOrThrow({ where: { organizationId: ORG } });
    expect(refund.refundNoteDocumentId).toBe(rn.id);
    expect(refund.originalPaymentId).toBe(payment.id);
    expect(refund.bankRef).toBe("MBB-777");
  });

  it("refund exceeding the collected portion → 400 REFUND_EXCEEDS_COLLECTED", async () => {
    await seedChargeWithDocument({
      chargeId: C_PARTIAL, docId: D_PARTIAL, documentNumber: "DEP-9005",
      amount: "100.00", outstanding: "60.00", status: "partially_paid",
    });
    await expect(
      voidPostedChargeWithCreditNote({
        organizationId: ORG, chargeId: C_PARTIAL, reason: "over-refund attempt",
        paidHandling: "refund",
        refund: { amount: "90.00", method: "bank_transfer", refundedAt: "2026-07-02" },
        actorUserId: USER, actorRole: "admin",
      }),
    ).rejects.toMatchObject({ status: 400, code: "REFUND_EXCEEDS_COLLECTED" });
  });

  it("legacy charge with NO document → plain void fallback (no CN row)", async () => {
    const db = getDb();
    await db.charge.create({
      data: {
        id: C_LEGACY, organizationId: ORG, chargeNumber: "LEGACY-1", partyId: TENANT,
        chargeType: "rent", status: "posted", postedAt: new Date(),
        dueDate: new Date("2026-06-30"), amount: "50.00", currency: "MYR",
        outstandingAmount: "50.00",
      },
    });
    const r = await voidPostedChargeWithCreditNote({
      organizationId: ORG, chargeId: C_LEGACY, reason: "pre-cutover row",
      actorUserId: USER, actorRole: "admin",
    });
    expect(r).toMatchObject({ plainVoid: true, creditNoteId: null, creditNoteNumber: null });
    const charge = await db.charge.findUniqueOrThrow({ where: { id: C_LEGACY } });
    expect(charge.status).toBe("void");
    expect(Number(charge.outstandingAmount.toString())).toBe(0);
    expect(await db.billingDocument.count({ where: { organizationId: ORG } })).toBe(0);
  });
});
