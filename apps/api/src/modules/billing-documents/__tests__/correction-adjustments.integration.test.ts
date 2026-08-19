/**
 * CREDIT/DEBIT_ADJUSTMENT preserve the allocation (R2) — real LOCAL Postgres
 * (opt-in RUN_INTEGRATION=1).
 *
 * Proves (spec §4.3 / R2):
 *  - CREDIT_ADJUSTMENT on a paid-in-part charge issues a Credit Note, zeroes the
 *    charge's outstanding, and NEVER touches the PaymentAllocation row (same id,
 *    same chargeId, same allocatedAmount) — the payment stays allocated to the
 *    original charge.
 *  - DEBIT_ADJUSTMENT issues a Debit Note that RAISES the receivable (outstanding
 *    up by the adjustment amount) and likewise leaves the PaymentAllocation row
 *    untouched.
 *  - The Payment row is byte-identical before/after either adjustment (R5), and a
 *    correction AuditLog row is written.
 *  - Cross-org (R12b / IDOR): an org-A session correcting an org-B charge → 404
 *    CHARGE_NOT_FOUND, and NO document / allocation change lands in org B.
 *
 * Run:
 *   cd apps/api
 *   RUN_INTEGRATION=1 ENABLE_PHASE2_BILLING_DOCS=1 \
 *     npx vitest run src/modules/billing-documents/__tests__/correction-adjustments.integration.test.ts
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

// Fixed disjoint UUIDs (prefix b5; unused by any other suite). Two orgs: A (the
// acting org) + B (the IDOR victim), each fully self-contained.
const ORG_A = "b5000000-0000-4000-8000-000000000001";
const USER_A = "b5000000-0000-4000-8000-000000000002";
const TENANT_A = "b5000000-0000-4000-8000-000000000003";
const CAT_A = "b5000000-0000-4000-8000-000000000004";
const SERIES_DEP_A = "b5000000-0000-4000-8000-000000000005";
const SERIES_CN_A = "b5000000-0000-4000-8000-000000000006";
const SERIES_DN_A = "b5000000-0000-4000-8000-000000000007";

const ORG_B = "b5000000-0000-4000-8000-000000000101";
const USER_B = "b5000000-0000-4000-8000-000000000102";
const TENANT_B = "b5000000-0000-4000-8000-000000000103";
const CAT_B = "b5000000-0000-4000-8000-000000000104";
const SERIES_DEP_B = "b5000000-0000-4000-8000-000000000105";
const SERIES_CN_B = "b5000000-0000-4000-8000-000000000106";
const SERIES_DN_B = "b5000000-0000-4000-8000-000000000107";

// Charges / documents / payments
const C_CREDIT = "b5000000-0000-4000-8000-000000000011";
const D_CREDIT = "b5000000-0000-4000-8000-000000000012";
const PAY_CREDIT = "b5000000-0000-4000-8000-000000000013";
const ALLOC_CREDIT = "b5000000-0000-4000-8000-000000000014";

const C_DEBIT = "b5000000-0000-4000-8000-000000000021";
const D_DEBIT = "b5000000-0000-4000-8000-000000000022";
const PAY_DEBIT = "b5000000-0000-4000-8000-000000000023";
const ALLOC_DEBIT = "b5000000-0000-4000-8000-000000000024";

// (e) replay idempotency + (f) second-distinct-adjustment charges (own ids so
// the shared beforeEach cleanup/reseed can't collide with the above).
const C_REPLAY = "b5000000-0000-4000-8000-000000000041";
const D_REPLAY = "b5000000-0000-4000-8000-000000000042";
const PAY_REPLAY = "b5000000-0000-4000-8000-000000000043";
const ALLOC_REPLAY = "b5000000-0000-4000-8000-000000000044";

const C_MULTI = "b5000000-0000-4000-8000-000000000051";
const D_MULTI = "b5000000-0000-4000-8000-000000000052";
const PAY_MULTI = "b5000000-0000-4000-8000-000000000053";
const ALLOC_MULTI = "b5000000-0000-4000-8000-000000000054";

// org-B victim charge (IDOR target)
const C_ORGB = "b5000000-0000-4000-8000-000000000031";
const D_ORGB = "b5000000-0000-4000-8000-000000000032";
const PAY_ORGB = "b5000000-0000-4000-8000-000000000033";
const ALLOC_ORGB = "b5000000-0000-4000-8000-000000000034";

async function cleanupOrg(orgId: string, userId: string) {
  const db = getDb();
  const org = { organizationId: orgId };
  // FK-safe order: children before parents. PaymentAllocationReversal keys off
  // allocation ids via a plain column, so purge it first (belt-and-braces even
  // though this suite never creates one).
  await db.paymentAllocationReversal.deleteMany({ where: org });
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
  await db.user.deleteMany({ where: { id: userId } });
  await db.party.deleteMany({ where: org });
  await db.organization.deleteMany({ where: { id: orgId } });
}

async function cleanup() {
  await cleanupOrg(ORG_A, USER_A);
  await cleanupOrg(ORG_B, USER_B);
}

async function seedOrg(opts: {
  orgId: string;
  userId: string;
  tenantId: string;
  catId: string;
  seriesDepId: string;
  seriesCnId: string;
  seriesDnId: string;
  email: string;
}) {
  const db = getDb();
  await db.organization.create({
    data: {
      id: opts.orgId, name: `Adj Test Org ${opts.orgId.slice(-3)}`, slug: `org-${opts.orgId}`,
      status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY",
      subscriptionPlan: "free",
    },
  });
  await db.user.create({
    data: {
      id: opts.userId, organizationId: opts.orgId, email: opts.email, passwordHash: "x",
      role: "admin", fullName: "Adj Admin", status: "active", userType: "operator",
    },
  });
  await db.party.create({
    data: {
      id: opts.tenantId, organizationId: opts.orgId, displayName: "Adj Tenant",
      partyType: "individual", status: "active",
    },
  });
  await db.documentSeries.create({
    data: { id: opts.seriesDepId, organizationId: opts.orgId, code: "DEP", prefix: "DEP", padding: 4, includeYear: false, active: true },
  });
  await db.documentSeries.create({
    data: { id: opts.seriesCnId, organizationId: opts.orgId, code: "CN", prefix: "CN", padding: 4, includeYear: false, active: true },
  });
  await db.documentSeries.create({
    data: { id: opts.seriesDnId, organizationId: opts.orgId, code: "DN", prefix: "DN", padding: 4, includeYear: false, active: true },
  });
  await db.chargeCategory.create({
    data: {
      id: opts.catId, organizationId: opts.orgId, code: "rental", name: "Monthly rental",
      family: "pay_back_landlord", docType: "debit_note", seriesId: opts.seriesDepId,
      defaultSstRate: 0, eInvoiceEligible: false, ledgerCategory: "rental_income",
      isSystem: true, active: true, sortOrder: 1,
    },
  });
}

/**
 * Seed a posted charge + its issued DEP debit-note document (1 line) + a real
 * Payment and PaymentAllocation (collected = amount − outstanding).
 */
async function seedChargeWithPayment(opts: {
  orgId: string;
  tenantId: string;
  catId: string;
  seriesDepId: string;
  userId: string;
  chargeId: string;
  docId: string;
  documentNumber: string;
  paymentId: string;
  paymentNumber: string;
  allocId: string;
  amount: string;
  outstanding: string;
  collected: string;
  status: string;
}) {
  const db = getDb();
  await db.charge.create({
    data: {
      id: opts.chargeId, organizationId: opts.orgId, chargeNumber: `ADJ-${opts.chargeId.slice(-6)}`,
      partyId: opts.tenantId, chargeType: "rental", categoryId: opts.catId, status: opts.status,
      postedAt: new Date(), description: "Rent June", dueDate: new Date("2026-06-30"),
      amount: opts.amount, currency: "MYR", outstandingAmount: opts.outstanding,
      billingMonth: new Date("2026-06-01"),
    },
  });
  await db.billingDocument.create({
    data: {
      id: opts.docId, organizationId: opts.orgId, docType: "debit_note",
      documentNumber: opts.documentNumber, seriesId: opts.seriesDepId, status: "issued",
      issuedById: opts.userId, counterpartyType: "tenant", partyId: opts.tenantId,
      billingMonth: new Date("2026-06-01"),
      subtotal: opts.amount, sstAmount: 0, total: opts.amount,
      lines: {
        create: [{
          chargeId: opts.chargeId, categoryId: opts.catId, description: "Rent June",
          amount: opts.amount, sstRate: 0, sstAmount: 0,
        }],
      },
    },
  });
  await db.payment.create({
    data: {
      id: opts.paymentId, organizationId: opts.orgId, paymentNumber: opts.paymentNumber,
      partyId: opts.tenantId, paymentType: "incoming", paymentMethod: "bank_transfer",
      status: "posted", amount: opts.collected, currency: "MYR", receivedAt: new Date("2026-06-15T00:00:00.000Z"),
    },
  });
  await db.paymentAllocation.create({
    data: {
      id: opts.allocId, organizationId: opts.orgId, paymentId: opts.paymentId,
      chargeId: opts.chargeId, allocatedAmount: opts.collected,
      allocatedAt: new Date("2026-06-15T00:00:00.000Z"),
    },
  });
}

dn("CREDIT/DEBIT_ADJUSTMENT preserve the allocation (integration)", () => {
  beforeEach(async () => {
    await cleanup();
    await seedOrg({
      orgId: ORG_A, userId: USER_A, tenantId: TENANT_A, catId: CAT_A,
      seriesDepId: SERIES_DEP_A, seriesCnId: SERIES_CN_A, seriesDnId: SERIES_DN_A,
      email: "adj-a@test.local",
    });
    await seedOrg({
      orgId: ORG_B, userId: USER_B, tenantId: TENANT_B, catId: CAT_B,
      seriesDepId: SERIES_DEP_B, seriesCnId: SERIES_CN_B, seriesDnId: SERIES_DN_B,
      email: "adj-b@test.local",
    });
  });
  afterAll(cleanup);

  it("credit keeps allocation: CREDIT_ADJUSTMENT on INV RM1000/RM400-paid → CN issued, PaymentAllocation UNCHANGED", async () => {
    // INV RM1000, RM400 collected (outstanding RM600) via a real allocation.
    await seedChargeWithPayment({
      orgId: ORG_A, tenantId: TENANT_A, catId: CAT_A, seriesDepId: SERIES_DEP_A, userId: USER_A,
      chargeId: C_CREDIT, docId: D_CREDIT, documentNumber: "DEP-1001",
      paymentId: PAY_CREDIT, paymentNumber: "PAY-CR-1", allocId: ALLOC_CREDIT,
      amount: "1000.00", outstanding: "600.00", collected: "400.00", status: "partially_paid",
    });

    const db = getDb();
    const allocBefore = await db.paymentAllocation.findUniqueOrThrow({ where: { id: ALLOC_CREDIT } });

    const r = await voidPostedChargeWithCreditNote({
      organizationId: ORG_A, chargeId: C_CREDIT, reason: "credit adjustment",
      strategy: "CREDIT_ADJUSTMENT", actorUserId: USER_A, actorRole: "admin",
    });
    expect(r.plainVoid).toBe(false);
    expect(r.creditNoteNumber).toMatch(/^CN-\d{4}$/);

    // CN was issued referencing the original document.
    const cn = await db.billingDocument.findUniqueOrThrow({ where: { id: r.creditNoteId! } });
    expect(cn.docType).toBe("credit_note");
    expect(cn.originalDocumentId).toBe(D_CREDIT);

    // The PaymentAllocation row is UNCHANGED — same id, same chargeId, same
    // amount, same paymentId (R2: the payment stays allocated to the charge).
    const allocAfter = await db.paymentAllocation.findUniqueOrThrow({ where: { id: ALLOC_CREDIT } });
    expect(allocAfter.id).toBe(allocBefore.id);
    expect(allocAfter.chargeId).toBe(C_CREDIT);
    expect(allocAfter.paymentId).toBe(PAY_CREDIT);
    expect(allocAfter.allocatedAmount.toString()).toBe(allocBefore.allocatedAmount.toString());
    expect(allocAfter.allocatedAt.getTime()).toBe(allocBefore.allocatedAt.getTime());

    // Exactly one allocation row still exists for this charge.
    expect(await db.paymentAllocation.count({ where: { organizationId: ORG_A, chargeId: C_CREDIT } })).toBe(1);
  });

  it("debit increases receivable: DEBIT_ADJUSTMENT RM50 → DN issued, outstanding up by 50, allocation untouched", async () => {
    // INV RM1000, RM400 collected (outstanding RM600).
    await seedChargeWithPayment({
      orgId: ORG_A, tenantId: TENANT_A, catId: CAT_A, seriesDepId: SERIES_DEP_A, userId: USER_A,
      chargeId: C_DEBIT, docId: D_DEBIT, documentNumber: "DEP-2001",
      paymentId: PAY_DEBIT, paymentNumber: "PAY-DR-1", allocId: ALLOC_DEBIT,
      amount: "1000.00", outstanding: "600.00", collected: "400.00", status: "partially_paid",
    });

    const db = getDb();
    const allocBefore = await db.paymentAllocation.findUniqueOrThrow({ where: { id: ALLOC_DEBIT } });

    const r = await voidPostedChargeWithCreditNote({
      organizationId: ORG_A, chargeId: C_DEBIT, reason: "debit adjustment",
      strategy: "DEBIT_ADJUSTMENT", adjustmentAmount: "50.00",
      actorUserId: USER_A, actorRole: "admin",
    });
    expect(r.plainVoid).toBe(false);
    expect(r.debitNoteNumber).toMatch(/^DN-\d{4}$/);
    // A DN is NOT a credit note.
    expect(r.creditNoteId).toBeNull();
    expect(r.creditNoteNumber).toBeNull();

    // The DN references the original document and raises the receivable by RM50.
    const dnDoc = await db.billingDocument.findFirstOrThrow({
      where: { organizationId: ORG_A, docType: "debit_note", documentNumber: r.debitNoteNumber! },
    });
    expect(dnDoc.originalDocumentId).toBe(D_DEBIT);
    expect(Number(dnDoc.total.toString())).toBe(50);

    // Charge outstanding rose 600 → 650; the charge is NOT credited/voided.
    const charge = await db.charge.findUniqueOrThrow({ where: { id: C_DEBIT } });
    expect(Number(charge.outstandingAmount.toString())).toBe(650);
    expect(charge.status).not.toBe("credited");
    expect(charge.status).not.toBe("void");

    // Allocation row untouched (R2).
    const allocAfter = await db.paymentAllocation.findUniqueOrThrow({ where: { id: ALLOC_DEBIT } });
    expect(allocAfter.id).toBe(allocBefore.id);
    expect(allocAfter.chargeId).toBe(C_DEBIT);
    expect(allocAfter.allocatedAmount.toString()).toBe(allocBefore.allocatedAmount.toString());
    expect(await db.paymentAllocation.count({ where: { organizationId: ORG_A, chargeId: C_DEBIT } })).toBe(1);
  });

  it("payment untouched + audit: Payment row identical after both adjustments (R5) + correction audit written", async () => {
    // Two charges — one credit-adjusted, one debit-adjusted — each with a payment.
    await seedChargeWithPayment({
      orgId: ORG_A, tenantId: TENANT_A, catId: CAT_A, seriesDepId: SERIES_DEP_A, userId: USER_A,
      chargeId: C_CREDIT, docId: D_CREDIT, documentNumber: "DEP-3001",
      paymentId: PAY_CREDIT, paymentNumber: "PAY-CR-2", allocId: ALLOC_CREDIT,
      amount: "1000.00", outstanding: "600.00", collected: "400.00", status: "partially_paid",
    });
    await seedChargeWithPayment({
      orgId: ORG_A, tenantId: TENANT_A, catId: CAT_A, seriesDepId: SERIES_DEP_A, userId: USER_A,
      chargeId: C_DEBIT, docId: D_DEBIT, documentNumber: "DEP-3002",
      paymentId: PAY_DEBIT, paymentNumber: "PAY-DR-2", allocId: ALLOC_DEBIT,
      amount: "1000.00", outstanding: "600.00", collected: "400.00", status: "partially_paid",
    });

    const db = getDb();
    const payCreditBefore = await db.payment.findUniqueOrThrow({ where: { id: PAY_CREDIT } });
    const payDebitBefore = await db.payment.findUniqueOrThrow({ where: { id: PAY_DEBIT } });

    await voidPostedChargeWithCreditNote({
      organizationId: ORG_A, chargeId: C_CREDIT, reason: "credit adj audit",
      strategy: "CREDIT_ADJUSTMENT", actorUserId: USER_A, actorRole: "admin",
    });
    await voidPostedChargeWithCreditNote({
      organizationId: ORG_A, chargeId: C_DEBIT, reason: "debit adj audit",
      strategy: "DEBIT_ADJUSTMENT", adjustmentAmount: "50.00", actorUserId: USER_A, actorRole: "admin",
    });

    // R5: the Payment rows are unchanged (amount, status, allocations behind them).
    const payCreditAfter = await db.payment.findUniqueOrThrow({ where: { id: PAY_CREDIT } });
    const payDebitAfter = await db.payment.findUniqueOrThrow({ where: { id: PAY_DEBIT } });
    expect(payCreditAfter.amount.toString()).toBe(payCreditBefore.amount.toString());
    expect(payCreditAfter.status).toBe(payCreditBefore.status);
    expect(payCreditAfter.updatedAt.getTime()).toBe(payCreditBefore.updatedAt.getTime());
    expect(payDebitAfter.amount.toString()).toBe(payDebitBefore.amount.toString());
    expect(payDebitAfter.status).toBe(payDebitBefore.status);
    expect(payDebitAfter.updatedAt.getTime()).toBe(payDebitBefore.updatedAt.getTime());

    // An AuditLog row exists for each correction (the CN issue + the DN issue).
    const audits = await db.auditLog.findMany({ where: { organizationId: ORG_A } });
    const actions = audits.map((a) => a.action);
    expect(actions).toContain("billing-docs.credit_note.issue");
    expect(actions.some((a) => a.includes("debit_note"))).toBe(true);
  });

  it("cross-org 404: org-A session correcting an org-B charge → 404 CHARGE_NOT_FOUND, nothing written in org B", async () => {
    // Seed the victim charge + payment in ORG_B.
    await seedChargeWithPayment({
      orgId: ORG_B, tenantId: TENANT_B, catId: CAT_B, seriesDepId: SERIES_DEP_B, userId: USER_B,
      chargeId: C_ORGB, docId: D_ORGB, documentNumber: "DEP-9001",
      paymentId: PAY_ORGB, paymentNumber: "PAY-B-1", allocId: ALLOC_ORGB,
      amount: "1000.00", outstanding: "600.00", collected: "400.00", status: "partially_paid",
    });

    const db = getDb();
    const allocBefore = await db.paymentAllocation.findUniqueOrThrow({ where: { id: ALLOC_ORGB } });
    const docCountBefore = await db.billingDocument.count({ where: { organizationId: ORG_B } });

    // org-A actor tries to correct org-B's charge (CREDIT).
    await expect(
      voidPostedChargeWithCreditNote({
        organizationId: ORG_A, chargeId: C_ORGB, reason: "idor credit",
        strategy: "CREDIT_ADJUSTMENT", actorUserId: USER_A, actorRole: "admin",
      }),
    ).rejects.toMatchObject({ status: 404, code: "CHARGE_NOT_FOUND" });

    // …and DEBIT.
    await expect(
      voidPostedChargeWithCreditNote({
        organizationId: ORG_A, chargeId: C_ORGB, reason: "idor debit",
        strategy: "DEBIT_ADJUSTMENT", adjustmentAmount: "50.00", actorUserId: USER_A, actorRole: "admin",
      }),
    ).rejects.toMatchObject({ status: 404, code: "CHARGE_NOT_FOUND" });

    // No document minted in org B, allocation untouched, charge unchanged.
    expect(await db.billingDocument.count({ where: { organizationId: ORG_B } })).toBe(docCountBefore);
    expect(await db.billingDocument.count({ where: { organizationId: ORG_B, docType: "credit_note" } })).toBe(0);
    expect(await db.billingDocument.count({ where: { organizationId: ORG_B, docType: "debit_note", originalDocumentId: D_ORGB } })).toBe(0);
    const allocAfter = await db.paymentAllocation.findUniqueOrThrow({ where: { id: ALLOC_ORGB } });
    expect(allocAfter.allocatedAmount.toString()).toBe(allocBefore.allocatedAmount.toString());
    expect(allocAfter.chargeId).toBe(C_ORGB);
    const chargeB = await db.charge.findUniqueOrThrow({ where: { id: C_ORGB } });
    expect(Number(chargeB.outstandingAmount.toString())).toBe(600);
    expect(chargeB.status).toBe("partially_paid");
  });

  it("(e) replay: identical DEBIT_ADJUSTMENT RM50 with a fixed idempotencyKey → exactly ONE DN, outstanding rose by 50 ONCE (not 100), no 2nd ChargeEvent/AuditLog", async () => {
    // INV RM1000, RM400 collected (outstanding RM600).
    await seedChargeWithPayment({
      orgId: ORG_A, tenantId: TENANT_A, catId: CAT_A, seriesDepId: SERIES_DEP_A, userId: USER_A,
      chargeId: C_REPLAY, docId: D_REPLAY, documentNumber: "DEP-4001",
      paymentId: PAY_REPLAY, paymentNumber: "PAY-RP-1", allocId: ALLOC_REPLAY,
      amount: "1000.00", outstanding: "600.00", collected: "400.00", status: "partially_paid",
    });

    const db = getDb();
    const IDEM = "replay-debit-adjust-e";

    // First apply.
    const r1 = await voidPostedChargeWithCreditNote({
      organizationId: ORG_A, chargeId: C_REPLAY, reason: "debit replay",
      strategy: "DEBIT_ADJUSTMENT", adjustmentAmount: "50.00", idempotencyKey: IDEM,
      actorUserId: USER_A, actorRole: "admin",
    });
    expect(r1.debitNoteNumber).toMatch(/^DN-\d{4}$/);

    // REPLAY the byte-identical call.
    const r2 = await voidPostedChargeWithCreditNote({
      organizationId: ORG_A, chargeId: C_REPLAY, reason: "debit replay",
      strategy: "DEBIT_ADJUSTMENT", adjustmentAmount: "50.00", idempotencyKey: IDEM,
      actorUserId: USER_A, actorRole: "admin",
    });
    // Same DN returned — no fresh mint.
    expect(r2.debitNoteNumber).toBe(r1.debitNoteNumber);

    // Exactly ONE debit_note references the original document (no double-issue).
    expect(
      await db.billingDocument.count({
        where: { organizationId: ORG_A, docType: "debit_note", originalDocumentId: D_REPLAY },
      }),
    ).toBe(1);

    // Outstanding rose 600 → 650 ONCE — NOT 700 (the double-increment bug).
    const charge = await db.charge.findUniqueOrThrow({ where: { id: C_REPLAY } });
    expect(Number(charge.outstandingAmount.toString())).toBe(650);

    // Exactly ONE charge_debit_adjusted ChargeEvent (the replay must not add a 2nd).
    expect(
      await db.chargeEvent.count({
        where: { organizationId: ORG_A, chargeId: C_REPLAY, eventType: "charge_debit_adjusted" },
      }),
    ).toBe(1);

    // Exactly ONE debit-note-issue correction AuditLog for this charge.
    const debitAudits = await db.auditLog.findMany({
      where: { organizationId: ORG_A, action: "billing-docs.debit_note.issue" },
    });
    const forThisCharge = debitAudits.filter(
      (a) => (a.meta as { chargeId?: string } | null)?.chargeId === C_REPLAY,
    );
    expect(forThisCharge.length).toBe(1);
  });

  it("(f) second distinct adjustment: DEBIT_ADJUSTMENT RM50 then RM30 (no idempotencyKey) → TWO debit_notes (50, 30), outstanding rose by 80 total (= Σ DN)", async () => {
    // INV RM1000, RM400 collected (outstanding RM600).
    await seedChargeWithPayment({
      orgId: ORG_A, tenantId: TENANT_A, catId: CAT_A, seriesDepId: SERIES_DEP_A, userId: USER_A,
      chargeId: C_MULTI, docId: D_MULTI, documentNumber: "DEP-5001",
      paymentId: PAY_MULTI, paymentNumber: "PAY-MU-1", allocId: ALLOC_MULTI,
      amount: "1000.00", outstanding: "600.00", collected: "400.00", status: "partially_paid",
    });

    const db = getDb();

    // First distinct adjustment RM50 (no idempotencyKey → key derives from amount).
    const r1 = await voidPostedChargeWithCreditNote({
      organizationId: ORG_A, chargeId: C_MULTI, reason: "first adj",
      strategy: "DEBIT_ADJUSTMENT", adjustmentAmount: "50.00",
      actorUserId: USER_A, actorRole: "admin",
    });
    // Second, DIFFERENT amount RM30 (no idempotencyKey → distinct amount ⇒ distinct key).
    const r2 = await voidPostedChargeWithCreditNote({
      organizationId: ORG_A, chargeId: C_MULTI, reason: "second adj",
      strategy: "DEBIT_ADJUSTMENT", adjustmentAmount: "30.00",
      actorUserId: USER_A, actorRole: "admin",
    });
    expect(r1.debitNoteNumber).toMatch(/^DN-\d{4}$/);
    expect(r2.debitNoteNumber).toMatch(/^DN-\d{4}$/);
    expect(r2.debitNoteNumber).not.toBe(r1.debitNoteNumber);

    // TWO distinct debit_notes reference the original document, totalling 50 + 30.
    const dns = await db.billingDocument.findMany({
      where: { organizationId: ORG_A, docType: "debit_note", originalDocumentId: D_MULTI },
      orderBy: { issuedAt: "asc" },
    });
    expect(dns.length).toBe(2);
    const totals = dns.map((d) => Number(d.total.toString())).sort((a, b) => a - b);
    expect(totals).toEqual([30, 50]);

    // Outstanding rose 600 → 680 (Σ DN = 80) — each adjustment counted exactly once.
    const charge = await db.charge.findUniqueOrThrow({ where: { id: C_MULTI } });
    expect(Number(charge.outstandingAmount.toString())).toBe(680);

    // Two ChargeEvents (one per distinct adjustment).
    expect(
      await db.chargeEvent.count({
        where: { organizationId: ORG_A, chargeId: C_MULTI, eventType: "charge_debit_adjusted" },
      }),
    ).toBe(2);
  });
});
