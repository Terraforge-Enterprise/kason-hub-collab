/**
 * getBillingDocumentDetail — amountPaid + balance (drawer totals) — real LOCAL
 * Postgres (opt-in RUN_INTEGRATION=1).
 *
 * The detail drawer's "Amount Paid" / "Balance Due" rows must be derived from the
 * SAME source the settlement pill reads, so they can never contradict it:
 *   - balance = Σ(charge.outstandingAmount) over the doc's charges → "0.00" ⟺ PAID;
 *   - amountPaid = Σ(posted PaymentAllocation) − Σ(reversals) → cash only;
 *   - non-posted payments and sibling-doc allocations are excluded from amountPaid.
 *
 * Run (localhost DB):
 *   cd apps/api
 *   RUN_INTEGRATION=1 ENABLE_PHASE2_BILLING_DOCS=1 \
 *     npx vitest run src/modules/billing-documents/__tests__/detail-paid-balance.integration.test.ts
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getDb } from "@kason/db";
import { getBillingDocumentDetail } from "../repository";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
  process.env.ENABLE_PHASE2_BILLING_DOCS = "1";
}

// Fixed disjoint UUIDs (prefix b7d0; unused by any other suite)
const ORG = "b7d00000-0000-4000-8000-000000000001";
const USER = "b7d00000-0000-4000-8000-000000000002";
const TENANT = "b7d00000-0000-4000-8000-000000000003";
const CAT = "b7d00000-0000-4000-8000-000000000004";
const SERIES = "b7d00000-0000-4000-8000-000000000005";

async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
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
      id: ORG, name: "P2 Detail Paid/Balance Org", slug: `org-${ORG}`, status: "active",
      defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free",
    },
  });
  await db.user.create({
    data: {
      id: USER, organizationId: ORG, email: "b7d0detail@test.local", passwordHash: "x", role: "admin",
      fullName: "B7D0 Admin", status: "active", userType: "operator",
    },
  });
  await db.party.create({
    data: { id: TENANT, organizationId: ORG, displayName: "Detail Tenant", partyType: "individual", status: "active" },
  });
  await db.documentSeries.create({
    data: { id: SERIES, organizationId: ORG, code: "DEP", prefix: "DEP", padding: 4, includeYear: false, active: true },
  });
  await db.chargeCategory.create({
    data: {
      id: CAT, organizationId: ORG, code: "rental", name: "Monthly rental",
      family: "pay_back_landlord", docType: "invoice", seriesId: SERIES,
      defaultSstRate: 0, eInvoiceEligible: false, ledgerCategory: "rental_income",
      isSystem: true, active: true, sortOrder: 1,
    },
  });
}

/** Seed a posted charge + an issued invoice document (1 line) for it. */
async function seedInvoiceCharge(opts: {
  chargeId: string; docId: string; documentNumber: string;
  amount: string; outstanding: string; status: string;
}) {
  const db = getDb();
  await db.charge.create({
    data: {
      id: opts.chargeId, organizationId: ORG, chargeNumber: `B7D0-${opts.chargeId.slice(-6)}`,
      partyId: TENANT, chargeType: "rental", categoryId: CAT, status: opts.status,
      postedAt: new Date(), description: "Rent July", dueDate: new Date("2026-07-31"),
      amount: opts.amount, currency: "MYR", outstandingAmount: opts.outstanding,
      billingMonth: new Date("2026-07-01"),
    },
  });
  await db.billingDocument.create({
    data: {
      id: opts.docId, organizationId: ORG, docType: "invoice",
      documentNumber: opts.documentNumber, seriesId: SERIES, status: "issued",
      issuedById: USER, counterpartyType: "tenant", partyId: TENANT,
      billingMonth: new Date("2026-07-01"),
      subtotal: opts.amount, sstAmount: 0, total: opts.amount,
      lines: {
        create: [{
          chargeId: opts.chargeId, categoryId: CAT, description: "Rent July",
          amount: opts.amount, sstRate: 0, sstAmount: 0,
        }],
      },
    },
  });
}

async function seedAllocation(opts: {
  paymentId: string; paymentNumber: string; allocId: string; chargeId: string;
  amount: string; paymentStatus?: string;
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

const C1 = "b7d00000-0000-4000-8000-000000000011";
const D1 = "b7d00000-0000-4000-8000-000000000012";
const P1 = "b7d00000-0000-4000-8000-000000000013";
const A1 = "b7d00000-0000-4000-8000-000000000014";

dn("getBillingDocumentDetail amountPaid + balance (integration)", () => {
  beforeEach(async () => {
    await cleanup();
    await seedBase();
  });
  afterAll(cleanup);

  it("unpaid invoice → amountPaid 0.00, balance == total", async () => {
    await seedInvoiceCharge({
      chargeId: C1, docId: D1, documentNumber: "DEP-9001",
      amount: "100.00", outstanding: "100.00", status: "posted",
    });
    const detail = await getBillingDocumentDetail(ORG, D1);
    expect(detail?.amountPaid).toBe("0.00");
    expect(detail?.balance).toBe("100.00");
  });

  it("part-paid invoice → amountPaid == Σ allocations, balance == Σ outstanding", async () => {
    // RM100 invoice, RM40 collected → outstanding 60.
    await seedInvoiceCharge({
      chargeId: C1, docId: D1, documentNumber: "DEP-9002",
      amount: "100.00", outstanding: "60.00", status: "partially_paid",
    });
    await seedAllocation({ paymentId: P1, paymentNumber: "PAY-9002", allocId: A1, chargeId: C1, amount: "40.00" });
    const detail = await getBillingDocumentDetail(ORG, D1);
    expect(detail?.amountPaid).toBe("40.00");
    expect(detail?.balance).toBe("60.00");
    // Per-line (charge-level) figures drive the Record-Payment allocation cap.
    expect(detail?.lines[0].paid).toBe("40.00");
    expect(detail?.lines[0].outstanding).toBe("60.00");
  });

  it("itemised lines sharing ONE charge each expose the charge-level outstanding; balance counts it once", async () => {
    // One RM620 utility charge, RM120 already collected → outstanding 500. TWO
    // document lines (Electricity 500 + Water 120) SHARE that one charge (the meter
    // itemisation path). The Record-Payment form groups by chargeId, so both lines
    // must report the SAME charge-level outstanding and the balance must NOT double.
    const db = getDb();
    await db.charge.create({
      data: {
        id: C1, organizationId: ORG, chargeNumber: "B7D0-UTIL", partyId: TENANT, chargeType: "utility",
        categoryId: CAT, status: "partially_paid", postedAt: new Date(), description: "Shared utilities",
        dueDate: new Date("2026-07-31"), amount: "620.00", currency: "MYR", outstandingAmount: "500.00",
        billingMonth: new Date("2026-07-01"),
      },
    });
    await db.billingDocument.create({
      data: {
        id: D1, organizationId: ORG, docType: "invoice", documentNumber: "DEP-9006", seriesId: SERIES,
        status: "partially_settled", issuedById: USER, counterpartyType: "tenant", partyId: TENANT,
        billingMonth: new Date("2026-07-01"), subtotal: "620.00", sstAmount: 0, total: "620.00",
        lines: {
          create: [
            { chargeId: C1, categoryId: CAT, description: "Electricity (TNB) 202607", amount: "500.00", sstRate: 0, sstAmount: 0 },
            { chargeId: C1, categoryId: CAT, description: "Water (Air Selangor) 202607", amount: "120.00", sstRate: 0, sstAmount: 0 },
          ],
        },
      },
    });
    await seedAllocation({ paymentId: P1, paymentNumber: "PAY-9006", allocId: A1, chargeId: C1, amount: "120.00" });
    const detail = await getBillingDocumentDetail(ORG, D1);
    expect(detail?.lines).toHaveLength(2);
    // Per-line figures are PRORATED across the shared charge by line amount (500 vs 120),
    // and foot EXACTLY to the charge totals (residual → largest line).
    expect(detail?.lines.map((l) => l.outstanding)).toEqual(["403.23", "96.77"]); // Σ = 500.00
    expect(detail?.lines.map((l) => l.paid)).toEqual(["96.78", "23.22"]); // Σ = 120.00
    const sum = (xs: string[]) => xs.reduce((s, x) => s + Number(x), 0);
    expect(sum(detail!.lines.map((l) => l.outstanding))).toBeCloseTo(500, 2);
    expect(sum(detail!.lines.map((l) => l.paid))).toBeCloseTo(120, 2);
    // Balance/amountPaid count the shared charge ONCE (not 2×).
    expect(detail?.balance).toBe("500.00");
    expect(detail?.amountPaid).toBe("120.00");
  });

  it("fully paid invoice → balance 0.00 (⟺ settlement PAID)", async () => {
    await seedInvoiceCharge({
      chargeId: C1, docId: D1, documentNumber: "DEP-9003",
      amount: "100.00", outstanding: "0.00", status: "paid",
    });
    await seedAllocation({ paymentId: P1, paymentNumber: "PAY-9003", allocId: A1, chargeId: C1, amount: "100.00" });
    const detail = await getBillingDocumentDetail(ORG, D1);
    expect(detail?.amountPaid).toBe("100.00");
    expect(detail?.balance).toBe("0.00");
  });

  it("amountPaid is NET of reversals: alloc 40 − reverse 15 → 25.00", async () => {
    await seedInvoiceCharge({
      chargeId: C1, docId: D1, documentNumber: "DEP-9004",
      amount: "100.00", outstanding: "75.00", status: "partially_paid",
    });
    const allocId = await seedAllocation({ paymentId: P1, paymentNumber: "PAY-9004", allocId: A1, chargeId: C1, amount: "40.00" });
    await seedReversal({ allocId, amount: "15.00", key: "b7d0-rev-1" });
    const detail = await getBillingDocumentDetail(ORG, D1);
    expect(detail?.amountPaid).toBe("25.00");
    expect(detail?.balance).toBe("75.00");
  });

  it("non-posted payment allocations are excluded from amountPaid", async () => {
    await seedInvoiceCharge({
      chargeId: C1, docId: D1, documentNumber: "DEP-9005",
      amount: "100.00", outstanding: "60.00", status: "partially_paid",
    });
    await seedAllocation({ paymentId: P1, paymentNumber: "PAY-9005-posted", allocId: A1, chargeId: C1, amount: "40.00" });
    await seedAllocation({
      paymentId: "b7d00000-0000-4000-8000-0000000000c1", paymentNumber: "PAY-9005-pending",
      allocId: "b7d00000-0000-4000-8000-0000000000c2", chargeId: C1, amount: "50.00", paymentStatus: "pending",
    });
    const detail = await getBillingDocumentDetail(ORG, D1);
    expect(detail?.amountPaid).toBe("40.00"); // pending 50 excluded
  });
});
