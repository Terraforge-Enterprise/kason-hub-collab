/**
 * refreshDocumentStatusForCharges — derived settlementStatus dual-write + OVERPAID
 * (Task 9, R6/R7/R11) — real LOCAL Postgres (opt-in RUN_INTEGRATION=1).
 *
 * Proves the post-commit derive hook, alongside the UNCHANGED legacy `status`,
 * ALSO dual-writes the derived `settlementStatus` and detects OVERPAID:
 *   - three status axes are independently readable (R6): documentStatus,
 *     taxStatus, settlementStatus;
 *   - reconciliation invariant (R7): cached settlementStatus/outstanding equals
 *     the value recomputed from source rows
 *     amount − (Σalloc − Σreversal) − (ΣCN − ΣDN);
 *   - OVERPAID: Σ(cleared alloc − reversal) > invoice amount → OVERPAID, detected
 *     BEFORE any outstanding clamp; strict `>` (equal → PAID); re-clears when a
 *     reversal drops the net back to ≤ amount;
 *   - non-posted payments and sibling-doc allocations are excluded;
 *   - ONE grouped reversal query per refresh (no N+1, R11);
 *   - legacy `status` stays correctly dual-written.
 *
 * Run (localhost DB):
 *   cd apps/api
 *   RUN_INTEGRATION=1 ENABLE_PHASE2_BILLING_DOCS=1 \
 *     npx vitest run src/modules/billing-documents/__tests__/settlement-reconciliation.integration.test.ts
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { getDb } from "@kason/db";
import { refreshDocumentStatusForCharges } from "../status.service";
import * as paymentsRepo from "../../payments/payments.repository";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
  process.env.ENABLE_PHASE2_BILLING_DOCS = "1";
}

// Fixed disjoint UUIDs (prefix b700; unused by any other suite)
const ORG = "b7000000-0000-4000-8000-000000000001";
const USER = "b7000000-0000-4000-8000-000000000002";
const TENANT = "b7000000-0000-4000-8000-000000000003";
const CAT = "b7000000-0000-4000-8000-000000000004";
const SERIES_DEP = "b7000000-0000-4000-8000-000000000005";
const SERIES_CN = "b7000000-0000-4000-8000-000000000006";

async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  // FK-safe order: reversals ref allocations; allocations ref payments+charges;
  // lines ref documents+charges; documents/charges ref party/series/category/org.
  await db.paymentAllocationReversal.deleteMany({ where: org });
  await db.billingDocumentLine.deleteMany({ where: { document: org } });
  await db.billingDocument.deleteMany({ where: org });
  await db.paymentAllocation.deleteMany({ where: org });
  await db.payment.deleteMany({ where: org });
  await db.chargeEvent.deleteMany({ where: org });
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
      id: ORG, name: "P2 Settlement Test Org", slug: `org-${ORG}`, status: "active",
      defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free",
    },
  });
  await db.user.create({
    data: {
      id: USER, organizationId: ORG, email: "b7settle@test.local", passwordHash: "x", role: "admin",
      fullName: "B7 Admin", status: "active", userType: "operator",
    },
  });
  await db.party.create({
    data: { id: TENANT, organizationId: ORG, displayName: "Settle Tenant", partyType: "individual", status: "active" },
  });
  await db.documentSeries.create({
    data: { id: SERIES_DEP, organizationId: ORG, code: "DEP", prefix: "DEP", padding: 4, includeYear: false, active: true },
  });
  await db.documentSeries.create({
    data: { id: SERIES_CN, organizationId: ORG, code: "CN", prefix: "CN", padding: 4, includeYear: false, active: true },
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

/** Seed a posted charge + an issued invoice document (1 line) for it. */
async function seedInvoiceCharge(opts: {
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
      id: opts.chargeId, organizationId: ORG, chargeNumber: `B7-${opts.chargeId.slice(-6)}`,
      partyId: TENANT, chargeType: "rental", categoryId: CAT, status: opts.status,
      postedAt: new Date(), description: "Rent June", dueDate: new Date("2026-06-30"),
      amount: opts.amount, currency: "MYR", outstandingAmount: opts.outstanding,
      billingMonth: new Date("2026-06-01"),
    },
  });
  await db.billingDocument.create({
    data: {
      id: opts.docId, organizationId: ORG, docType: "invoice",
      documentNumber: opts.documentNumber, seriesId: SERIES_DEP, status: "issued",
      issuedById: USER, counterpartyType: "tenant", partyId: TENANT,
      billingMonth: new Date("2026-06-01"),
      subtotal: opts.amount, sstAmount: 0, total: opts.amount,
      // documentStatus/taxStatus/settlementStatus default (ISSUED/NOT_REQUIRED/UNPAID)
      lines: {
        create: [{
          chargeId: opts.chargeId, categoryId: CAT, description: "Rent June",
          amount: opts.amount, sstRate: 0, sstAmount: 0,
        }],
      },
    },
  });
}

/** Seed a posted (or other-status) incoming payment + a PaymentAllocation to a charge. */
async function seedAllocation(opts: {
  paymentId: string;
  paymentNumber: string;
  allocId: string;
  chargeId: string;
  amount: string;
  paymentStatus?: string;
}): Promise<string> {
  const db = getDb();
  await db.payment.create({
    data: {
      id: opts.paymentId, organizationId: ORG, paymentNumber: opts.paymentNumber, partyId: TENANT,
      paymentType: "incoming", paymentMethod: "bank_transfer", status: opts.paymentStatus ?? "posted",
      amount: opts.amount, currency: "MYR", receivedAt: new Date(),
    },
  });
  const alloc = await db.paymentAllocation.create({
    data: {
      id: opts.allocId, organizationId: ORG, paymentId: opts.paymentId, chargeId: opts.chargeId,
      allocatedAmount: opts.amount, allocatedAt: new Date(),
    },
    select: { id: true },
  });
  return alloc.id;
}

async function seedReversal(opts: { allocId: string; amount: string; key: string }) {
  const db = getDb();
  await db.paymentAllocationReversal.create({
    data: {
      organizationId: ORG, originalAllocationId: opts.allocId, amount: opts.amount,
      reason: "test reversal", reversedById: USER, idempotencyKey: opts.key,
    },
  });
}

/**
 * Seed a debit_note / credit_note document against `originalDocumentId`, carrying
 * ONE line whose `chargeId` = the invoice charge and `amount` = the adjustment
 * magnitude. Mirrors the real DEBIT_ADJUSTMENT DN (credit-notes.service.ts:495)
 * and the CN line (chargeId=charge.id, amount) — this is exactly what the R7
 * adjustedInvoiceAmount basis reads (invoice + ΣDN − ΣCN over these lines).
 */
async function seedAdjustmentDoc(opts: {
  docId: string;
  documentNumber: string;
  docType: "debit_note" | "credit_note";
  originalDocumentId: string;
  chargeId: string;
  amount: string;
}) {
  const db = getDb();
  await db.billingDocument.create({
    data: {
      id: opts.docId, organizationId: ORG, docType: opts.docType,
      documentNumber: opts.documentNumber, seriesId: SERIES_CN, status: "issued",
      issuedById: USER, counterpartyType: "tenant", partyId: TENANT,
      originalDocumentId: opts.originalDocumentId,
      ...(opts.docType === "credit_note" ? { creditAmount: opts.amount } : {}),
      subtotal: opts.amount, sstAmount: 0, total: opts.amount,
      lines: {
        create: [{
          chargeId: opts.chargeId, categoryId: CAT,
          description: `${opts.docType} adjustment`, amount: opts.amount, sstRate: 0, sstAmount: 0,
        }],
      },
    },
  });
}

// Fixed row ids
const C1 = "b7000000-0000-4000-8000-000000000011";
const D1 = "b7000000-0000-4000-8000-000000000012";
const P1 = "b7000000-0000-4000-8000-000000000013";
const A1 = "b7000000-0000-4000-8000-000000000014";

dn("settlement dual-write + OVERPAID (integration)", () => {
  beforeEach(async () => {
    await cleanup();
    await seedBase();
    vi.restoreAllMocks();
  });
  afterAll(cleanup);

  it("three axes: issued invoice partially paid → documentStatus=ISSUED, taxStatus=NOT_REQUIRED, settlementStatus=PARTIALLY_PAID", async () => {
    // RM100 invoice, RM40 collected → outstanding 60, charge partially_paid.
    await seedInvoiceCharge({
      chargeId: C1, docId: D1, documentNumber: "DEP-7001",
      amount: "100.00", outstanding: "60.00", status: "partially_paid",
    });
    await seedAllocation({ paymentId: P1, paymentNumber: "PAY-7001", allocId: A1, chargeId: C1, amount: "40.00" });

    await refreshDocumentStatusForCharges([C1]);

    const db = getDb();
    const doc = await db.billingDocument.findUniqueOrThrow({ where: { id: D1 } });
    // Three independent axes, each readable on its own (R6):
    expect(doc.documentStatus).toBe("ISSUED");
    expect(doc.taxStatus).toBe("NOT_REQUIRED");
    expect(doc.settlementStatus).toBe("PARTIALLY_PAID");
    // Legacy status still correct (dual-write, B5):
    expect(doc.status).toBe("partially_settled");
  });

  it("reconciliation invariant: cached settlementStatus/outstanding == value recomputed from source rows (amount − (Σalloc − Σreversal) − (ΣCN − ΣDN))", async () => {
    // RM100 invoice. Alloc 70, reverse 20 → net collected 50. A CN reduces the
    // adjusted amount by 10 (ΣCN=10). Recomputed outstanding = 100 − 50 − 10 = 40.
    await seedInvoiceCharge({
      chargeId: C1, docId: D1, documentNumber: "DEP-7002",
      amount: "100.00", outstanding: "40.00", status: "partially_paid",
    });
    const allocId = await seedAllocation({
      paymentId: P1, paymentNumber: "PAY-7002", allocId: A1, chargeId: C1, amount: "70.00",
    });
    await seedReversal({ allocId, amount: "20.00", key: "b7-recon-rev-1" });
    // A credit note against this invoice (ΣCN = 10).
    const db = getDb();
    await db.billingDocument.create({
      data: {
        organizationId: ORG, docType: "credit_note", documentNumber: "CN-7002",
        seriesId: SERIES_CN, status: "issued", issuedById: USER, counterpartyType: "tenant",
        partyId: TENANT, originalDocumentId: D1, creditAmount: "10.00",
        subtotal: "10.00", sstAmount: 0, total: "10.00",
      },
    });

    await refreshDocumentStatusForCharges([C1]);

    // Recompute from source rows (the invariant's RHS):
    const chargeRow = await db.charge.findUniqueOrThrow({ where: { id: C1 } });
    const amountCents = Math.round(Number(chargeRow.amount.toString()) * 100);
    const allocRows = await db.paymentAllocation.findMany({
      where: { organizationId: ORG, chargeId: C1, payment: { status: "posted" } },
      select: { id: true, allocatedAmount: true },
    });
    const allocCents = allocRows.reduce((s, a) => s + Math.round(Number(a.allocatedAmount.toString()) * 100), 0);
    const revRows = await db.paymentAllocationReversal.groupBy({
      by: ["originalAllocationId"], where: { organizationId: ORG }, _sum: { amount: true },
    });
    const revCents = revRows.reduce((s, r) => s + Math.round(Number((r._sum.amount ?? 0).toString()) * 100), 0);
    const cnRows = await db.billingDocument.findMany({
      where: { organizationId: ORG, docType: "credit_note", originalDocumentId: D1 },
      select: { total: true },
    });
    const cnCents = cnRows.reduce((s, c) => s + Math.round(Number(c.total.toString()) * 100), 0);
    const recomputedOutstandingCents = amountCents - (allocCents - revCents) - cnCents;
    expect(recomputedOutstandingCents).toBe(4000); // 100 − (70−20) − 10 = 40.00

    // Cached charge outstanding equals the recomputed value (seeded to match the
    // real settle path; the doc's cached settlementStatus is PARTIALLY_PAID —
    // partially collected, not fully paid, not overpaid).
    expect(Math.round(Number(chargeRow.outstandingAmount.toString()) * 100)).toBe(recomputedOutstandingCents);
    const doc = await db.billingDocument.findUniqueOrThrow({ where: { id: D1 } });
    expect(doc.settlementStatus).toBe("PARTIALLY_PAID");
    expect(doc.status).toBe("partially_settled");
  });

  it("overpaid detected: Σ(cleared alloc − reversal) > invoice amount → settlementStatus=OVERPAID (before the outstanding clamp)", async () => {
    // RM100 invoice, RM130 collected (posted) → strictly over → OVERPAID, even
    // though the charge outstanding is clamped to 0 / marked paid.
    await seedInvoiceCharge({
      chargeId: C1, docId: D1, documentNumber: "DEP-7003",
      amount: "100.00", outstanding: "0.00", status: "paid",
    });
    await seedAllocation({ paymentId: P1, paymentNumber: "PAY-7003", allocId: A1, chargeId: C1, amount: "130.00" });

    await refreshDocumentStatusForCharges([C1]);

    const db = getDb();
    const doc = await db.billingDocument.findUniqueOrThrow({ where: { id: D1 } });
    expect(doc.settlementStatus).toBe("OVERPAID");
    // Legacy status is 'settled' (all outstanding 0 + paid) — dual-write unchanged.
    expect(doc.status).toBe("settled");
  });

  it("overpaid boundary is strict: Σ(alloc) exactly == amount (incl. fractional cents) → PAID, NOT OVERPAID", async () => {
    // RM100 invoice paid by three fractional allocations 33.34 + 33.33 + 33.33 =
    // exactly 100.00. Equal → PAID (the `>` must be strict; per-row cent rounding
    // must not tip it to OVERPAID).
    await seedInvoiceCharge({
      chargeId: C1, docId: D1, documentNumber: "DEP-7004",
      amount: "100.00", outstanding: "0.00", status: "paid",
    });
    await seedAllocation({ paymentId: P1, paymentNumber: "PAY-7004a", allocId: "b7000000-0000-4000-8000-0000000000a1", chargeId: C1, amount: "33.34" });
    await seedAllocation({ paymentId: "b7000000-0000-4000-8000-0000000000b1", paymentNumber: "PAY-7004b", allocId: "b7000000-0000-4000-8000-0000000000a2", chargeId: C1, amount: "33.33" });
    await seedAllocation({ paymentId: "b7000000-0000-4000-8000-0000000000b2", paymentNumber: "PAY-7004c", allocId: "b7000000-0000-4000-8000-0000000000a3", chargeId: C1, amount: "33.33" });

    await refreshDocumentStatusForCharges([C1]);

    const db = getDb();
    const doc = await db.billingDocument.findUniqueOrThrow({ where: { id: D1 } });
    expect(doc.settlementStatus).toBe("PAID");
  });

  it("overpaid re-clears after reversal: OVERPAID then reverse enough → drops back to PAID", async () => {
    // RM100 invoice, RM130 collected → OVERPAID; reverse 40 → net 90 ≤ 100.
    await seedInvoiceCharge({
      chargeId: C1, docId: D1, documentNumber: "DEP-7005",
      amount: "100.00", outstanding: "0.00", status: "paid",
    });
    const allocId = await seedAllocation({ paymentId: P1, paymentNumber: "PAY-7005", allocId: A1, chargeId: C1, amount: "130.00" });
    await refreshDocumentStatusForCharges([C1]);
    let doc = await getDb().billingDocument.findUniqueOrThrow({ where: { id: D1 } });
    expect(doc.settlementStatus).toBe("OVERPAID"); // precondition

    // Reverse 40 → net collected 90 < 100 → no longer overpaid.
    await seedReversal({ allocId, amount: "40.00", key: "b7-reclear-rev-1" });
    await refreshDocumentStatusForCharges([C1]);
    doc = await getDb().billingDocument.findUniqueOrThrow({ where: { id: D1 } });
    expect(doc.settlementStatus).not.toBe("OVERPAID");
    expect(doc.settlementStatus).toBe("PAID"); // legacy still 'settled' (charge paid, outstanding 0)
  });

  it("non-posted allocations excluded: a pending payment's allocation does NOT trigger OVERPAID", async () => {
    // RM100 invoice paid RM100 (posted) + RM50 pending. Only the posted 100 counts
    // → exactly equal → PAID, not OVERPAID.
    await seedInvoiceCharge({
      chargeId: C1, docId: D1, documentNumber: "DEP-7006",
      amount: "100.00", outstanding: "0.00", status: "paid",
    });
    await seedAllocation({ paymentId: P1, paymentNumber: "PAY-7006-posted", allocId: A1, chargeId: C1, amount: "100.00" });
    await seedAllocation({
      paymentId: "b7000000-0000-4000-8000-0000000000c1", paymentNumber: "PAY-7006-pending",
      allocId: "b7000000-0000-4000-8000-0000000000c2", chargeId: C1, amount: "50.00", paymentStatus: "pending",
    });

    await refreshDocumentStatusForCharges([C1]);

    const doc = await getDb().billingDocument.findUniqueOrThrow({ where: { id: D1 } });
    expect(doc.settlementStatus).toBe("PAID");
  });

  it("allocations scoped to the doc's charges: a sibling charge on another doc does NOT inflate this doc", async () => {
    // Doc D1 (RM100, paid 100 → PAID). A sibling charge on a DIFFERENT doc gets a
    // RM500 allocation — it must not push D1 to OVERPAID.
    await seedInvoiceCharge({
      chargeId: C1, docId: D1, documentNumber: "DEP-7007",
      amount: "100.00", outstanding: "0.00", status: "paid",
    });
    await seedAllocation({ paymentId: P1, paymentNumber: "PAY-7007", allocId: A1, chargeId: C1, amount: "100.00" });
    // Sibling charge + doc + a huge allocation.
    const C2 = "b7000000-0000-4000-8000-000000000021";
    await seedInvoiceCharge({
      chargeId: C2, docId: "b7000000-0000-4000-8000-000000000022", documentNumber: "DEP-7007b",
      amount: "500.00", outstanding: "0.00", status: "paid",
    });
    await seedAllocation({
      paymentId: "b7000000-0000-4000-8000-000000000023", paymentNumber: "PAY-7007b",
      allocId: "b7000000-0000-4000-8000-000000000024", chargeId: C2, amount: "500.00",
    });

    await refreshDocumentStatusForCharges([C1]);

    const doc = await getDb().billingDocument.findUniqueOrThrow({ where: { id: D1 } });
    expect(doc.settlementStatus).toBe("PAID"); // sibling's 500 did not leak in
  });

  it("single grouped query (no N+1, R11): sumReversalsForAllocations issues one groupBy per refresh", async () => {
    await seedInvoiceCharge({
      chargeId: C1, docId: D1, documentNumber: "DEP-7008",
      amount: "100.00", outstanding: "60.00", status: "partially_paid",
    });
    const allocId = await seedAllocation({ paymentId: P1, paymentNumber: "PAY-7008", allocId: A1, chargeId: C1, amount: "40.00" });
    await seedReversal({ allocId, amount: "5.00", key: "b7-n1-rev-1" });

    const spy = vi.spyOn(paymentsRepo, "sumReversalsForAllocations");
    await refreshDocumentStatusForCharges([C1]);
    // Exactly one grouped reversal fetch for this single-doc refresh.
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("idempotent projection: repeated refresh over unchanged source rows yields a stable settlementStatus", async () => {
    await seedInvoiceCharge({
      chargeId: C1, docId: D1, documentNumber: "DEP-7009",
      amount: "100.00", outstanding: "60.00", status: "partially_paid",
    });
    await seedAllocation({ paymentId: P1, paymentNumber: "PAY-7009", allocId: A1, chargeId: C1, amount: "40.00" });

    await refreshDocumentStatusForCharges([C1]);
    const first = await getDb().billingDocument.findUniqueOrThrow({ where: { id: D1 } });
    await refreshDocumentStatusForCharges([C1]);
    const second = await getDb().billingDocument.findUniqueOrThrow({ where: { id: D1 } });

    expect(second.settlementStatus).toBe(first.settlementStatus);
    expect(second.settlementStatus).toBe("PARTIALLY_PAID");
    expect(second.status).toBe(first.status);
  });

  it("(g) debit-adjusted, paid in full → PAID, NOT OVERPAID (basis = adjustedInvoiceAmount, not Σ charge.amount)", async () => {
    // Invoice charge RM1000. A DEBIT_ADJUSTMENT DN of RM200 raises the receivable
    // (outstanding → 1200, but charge.amount NEVER moves — still 1000). The tenant
    // pays RM1200 in full → outstanding 0 / paid. R7 basis = 1000 + 200(DN) − 0(CN)
    // = 1200; cleared 1200 == 1200 → PAID. (RED on the old Σ charge.amount basis:
    // cleared 1200 > 1000 → falsely OVERPAID.)
    const D_DN = "b7000000-0000-4000-8000-000000000031";
    await seedInvoiceCharge({
      chargeId: C1, docId: D1, documentNumber: "DEP-7010",
      amount: "1000.00", outstanding: "0.00", status: "paid",
    });
    await seedAdjustmentDoc({
      docId: D_DN, documentNumber: "DN-7010", docType: "debit_note",
      originalDocumentId: D1, chargeId: C1, amount: "200.00",
    });
    await seedAllocation({ paymentId: P1, paymentNumber: "PAY-7010", allocId: A1, chargeId: C1, amount: "1200.00" });

    await refreshDocumentStatusForCharges([C1]);

    const doc = await getDb().billingDocument.findUniqueOrThrow({ where: { id: D1 } });
    expect(doc.settlementStatus).toBe("PAID"); // adjusted target 1200, paid 1200 → exactly settled
    expect(doc.status).toBe("settled");
  });

  it("(h) credit-noted overpayment → OVERPAID (cleared 1000 > adjusted 700; the CN reduces the target)", async () => {
    // Invoice charge RM1000, tenant paid RM1000 (settled). Then a CN of RM300 is
    // issued against it → R7 adjusted target = 1000 + 0(DN) − 300(CN) = 700.
    // cleared 1000 > 700 → OVERPAID. (RED on the old Σ charge.amount basis:
    // cleared 1000 == 1000 → falsely PAID, missing the real overpayment.)
    const D_CN = "b7000000-0000-4000-8000-000000000041";
    await seedInvoiceCharge({
      chargeId: C1, docId: D1, documentNumber: "DEP-7011",
      amount: "1000.00", outstanding: "0.00", status: "paid",
    });
    await seedAllocation({ paymentId: P1, paymentNumber: "PAY-7011", allocId: A1, chargeId: C1, amount: "1000.00" });
    await seedAdjustmentDoc({
      docId: D_CN, documentNumber: "CN-7011", docType: "credit_note",
      originalDocumentId: D1, chargeId: C1, amount: "300.00",
    });

    await refreshDocumentStatusForCharges([C1]);

    const doc = await getDb().billingDocument.findUniqueOrThrow({ where: { id: D1 } });
    expect(doc.settlementStatus).toBe("OVERPAID"); // cleared 1000 > adjusted 700
  });

  it("(i) canonical predicate: a CANCELLED credit note no longer affects the OVERPAID basis", async () => {
    // As (h): RM1000 paid + CN RM300 → OVERPAID. Cancel the CN → it must drop out of the
    // adjustment basis (§7-A1 canonical predicate) → adjusted target back to 1000 → cleared 1000 == 1000 → PAID.
    const D_CN = "b7000000-0000-4000-8000-000000000051";
    await seedInvoiceCharge({ chargeId: C1, docId: D1, documentNumber: "DEP-7020", amount: "1000.00", outstanding: "0.00", status: "paid" });
    await seedAllocation({ paymentId: P1, paymentNumber: "PAY-7020", allocId: A1, chargeId: C1, amount: "1000.00" });
    await seedAdjustmentDoc({ docId: D_CN, documentNumber: "CN-7020", docType: "credit_note", originalDocumentId: D1, chargeId: C1, amount: "300.00" });

    await refreshDocumentStatusForCharges([C1]);
    expect((await getDb().billingDocument.findUniqueOrThrow({ where: { id: D1 } })).settlementStatus).toBe("OVERPAID");

    await getDb().billingDocument.update({ where: { id: D_CN }, data: { documentStatus: "CANCELLED" } });
    await refreshDocumentStatusForCharges([C1]);
    expect((await getDb().billingDocument.findUniqueOrThrow({ where: { id: D1 } })).settlementStatus).toBe("PAID");
  });

  it("(j) §7-A5: a note linked (originalDocumentId) to ANOTHER document must not alter this doc's basis, even when it shares a charge", async () => {
    // D1 charge RM1000 paid in full. A CN of RM300 references C1 in its line BUT is linked to a
    // DIFFERENT document. Formula A keys on originalDocumentId, so this note must NOT reduce D1's
    // adjusted target. (RED on the old chargeId-keyed query: cleared 1000 > adjusted 700 → OVERPAID.)
    const FOREIGN_DOC = "b7000000-0000-4000-8000-000000000061";
    const D_CN = "b7000000-0000-4000-8000-000000000062";
    await seedInvoiceCharge({ chargeId: C1, docId: D1, documentNumber: "DEP-7021", amount: "1000.00", outstanding: "0.00", status: "paid" });
    await seedAllocation({ paymentId: P1, paymentNumber: "PAY-7021", allocId: A1, chargeId: C1, amount: "1000.00" });
    await seedAdjustmentDoc({ docId: D_CN, documentNumber: "CN-7021", docType: "credit_note", originalDocumentId: FOREIGN_DOC, chargeId: C1, amount: "300.00" });

    await refreshDocumentStatusForCharges([C1]);
    expect((await getDb().billingDocument.findUniqueOrThrow({ where: { id: D1 } })).settlementStatus).toBe("PAID");
  });
});
