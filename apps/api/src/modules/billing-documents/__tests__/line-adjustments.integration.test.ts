/**
 * getBillingDocumentDetail — Phase 2.1 line-level, SERVER-DERIVED adjustment
 * fields (BillingDocumentLineDto) — real LOCAL Postgres (opt-in RUN_INTEGRATION=1).
 *
 * The frontend must never compute money: each line carries originalAmount /
 * debitAdjustmentAmount / creditAdjustmentAmount / netAdjustmentAmount /
 * adjustedAmount / allocationBasis / adjustments[], all attributed at CHARGE
 * granularity (money moves per charge, not per display line) and prorated
 * across a charge's display lines EXACTLY like the existing paid/outstanding
 * (reuses prorateAcrossLines), so the parts always foot to the charge-level
 * note totals. Only ACTIVE (documentStatus ISSUED, note-lifecycle.ts) charge-
 * backed CN/DN count — a CANCELLED note contributes nothing.
 *
 * Run (localhost DB):
 *   cd apps/api
 *   RUN_INTEGRATION=1 ENABLE_PHASE2_BILLING_DOCS=1 \
 *     npx vitest run src/modules/billing-documents/__tests__/line-adjustments.integration.test.ts
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

// Fixed disjoint UUIDs (prefix b740; unused by any other suite)
const ORG = "b7400000-0000-4000-8000-000000000001";
const USER = "b7400000-0000-4000-8000-000000000002";
const TENANT = "b7400000-0000-4000-8000-000000000003";
const CAT = "b7400000-0000-4000-8000-000000000004";
const SERIES_DEP = "b7400000-0000-4000-8000-000000000005";
const SERIES_CN = "b7400000-0000-4000-8000-000000000006";

async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  // FK-safe order: lines ref documents+charges; documents/charges ref party/series/category/org.
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
      id: ORG, name: "P2.1 Line Adjustments Test Org", slug: `org-${ORG}`, status: "active",
      defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free",
    },
  });
  await db.user.create({
    data: {
      id: USER, organizationId: ORG, email: "b740lineadj@test.local", passwordHash: "x", role: "admin",
      fullName: "B740 Admin", status: "active", userType: "operator",
    },
  });
  await db.party.create({
    data: { id: TENANT, organizationId: ORG, displayName: "Line Adjustments Tenant", partyType: "individual", status: "active" },
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

/** Seed a single posted charge (status "posted", fully outstanding). */
async function seedCharge(opts: { chargeId: string; amount: string; description: string }) {
  const db = getDb();
  await db.charge.create({
    data: {
      id: opts.chargeId, organizationId: ORG, chargeNumber: `B740-${opts.chargeId.slice(-6)}`,
      partyId: TENANT, chargeType: "utility", categoryId: CAT, status: "posted",
      postedAt: new Date(), description: opts.description, dueDate: new Date("2026-06-30"),
      amount: opts.amount, currency: "MYR", outstandingAmount: opts.amount,
      billingMonth: new Date("2026-06-01"),
    },
  });
}

/** Seed an issued invoice document with the given (already-seeded) charge-backed lines. */
async function seedInvoiceDoc(opts: {
  docId: string;
  documentNumber: string;
  total: string;
  lines: { chargeId: string; amount: string; description: string }[];
}) {
  const db = getDb();
  await db.billingDocument.create({
    data: {
      id: opts.docId, organizationId: ORG, docType: "invoice",
      documentNumber: opts.documentNumber, seriesId: SERIES_DEP, status: "issued",
      issuedById: USER, counterpartyType: "tenant", partyId: TENANT,
      billingMonth: new Date("2026-06-01"),
      subtotal: opts.total, sstAmount: 0, total: opts.total,
      lines: {
        create: opts.lines.map((l) => ({
          chargeId: l.chargeId, categoryId: CAT, description: l.description,
          amount: l.amount, sstRate: 0, sstAmount: 0,
        })),
      },
    },
  });
}

/**
 * Seed a debit_note / credit_note document against `originalDocumentId`, carrying
 * ONE line whose `chargeId` = the invoice charge and `amount` = the adjustment
 * magnitude. `documentStatus` defaults to ISSUED (active); pass "CANCELLED" to
 * prove a cancelled note is excluded from the line-adjustment basis.
 */
async function seedAdjustmentDoc(opts: {
  docId: string;
  documentNumber: string;
  docType: "debit_note" | "credit_note";
  originalDocumentId: string;
  chargeId: string;
  amount: string;
  documentStatus?: string;
}) {
  const db = getDb();
  await db.billingDocument.create({
    data: {
      id: opts.docId, organizationId: ORG, docType: opts.docType,
      documentNumber: opts.documentNumber, seriesId: SERIES_CN, status: "issued",
      issuedById: USER, counterpartyType: "tenant", partyId: TENANT,
      originalDocumentId: opts.originalDocumentId,
      documentStatus: opts.documentStatus ?? "ISSUED",
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

// Scenario A: two 1:1 line↔charge lines (Water/Electricity) on one invoice.
const D1 = "b7400000-0000-4000-8000-000000000011";
const CW = "b7400000-0000-4000-8000-000000000012";
const CE = "b7400000-0000-4000-8000-000000000013";
const CN1 = "b7400000-0000-4000-8000-000000000014";
const DN1 = "b7400000-0000-4000-8000-000000000015";

// Scenario B: one pooled charge itemised across 2 lines (60/40).
const D2 = "b7400000-0000-4000-8000-000000000021";
const C3 = "b7400000-0000-4000-8000-000000000022";
const CN2 = "b7400000-0000-4000-8000-000000000023";

// Scenario C: a CANCELLED note must not move any adjustment field.
const D4 = "b7400000-0000-4000-8000-000000000031";
const C4 = "b7400000-0000-4000-8000-000000000032";
const DN2 = "b7400000-0000-4000-8000-000000000033";

dn("getBillingDocumentDetail — line-level adjustment fields (integration)", () => {
  beforeEach(async () => {
    await cleanup();
    await seedBase();
  });
  afterAll(cleanup);

  it("credit note reduces its own line (1:1 → exact); a sibling line on a different charge stays unaffected until its own debit note lands", async () => {
    // Water RM123 (charge CW) + Electricity RM400 (charge CE) on one invoice.
    await seedCharge({ chargeId: CW, amount: "123.00", description: "Water" });
    await seedCharge({ chargeId: CE, amount: "400.00", description: "Electricity" });
    await seedInvoiceDoc({
      docId: D1, documentNumber: "DEP-8001", total: "523.00",
      lines: [
        { chargeId: CW, amount: "123.00", description: "Water" },
        { chargeId: CE, amount: "400.00", description: "Electricity" },
      ],
    });

    // 1. A RM23 credit note against the Water charge.
    await seedAdjustmentDoc({
      docId: CN1, documentNumber: "CN-8001", docType: "credit_note",
      originalDocumentId: D1, chargeId: CW, amount: "23.00",
    });
    let detail = await getBillingDocumentDetail(ORG, D1);
    const water1 = detail!.lines.find((l) => l.chargeId === CW)!;
    const electricity1 = detail!.lines.find((l) => l.chargeId === CE)!;
    expect(water1.originalAmount).toBe("123.00");
    expect(water1.creditAdjustmentAmount).toBe("23.00");
    expect(water1.debitAdjustmentAmount).toBe("0.00");
    expect(water1.netAdjustmentAmount).toBe("-23.00");
    expect(water1.adjustedAmount).toBe("100.00");
    expect(water1.allocationBasis).toBe("exact"); // 1 charge : 1 line
    expect(electricity1.adjustedAmount).toBe("400.00"); // unchanged — no note on CE yet
    expect(electricity1.allocationBasis).toBe("exact");

    // 2. A RM50 debit note against the Electricity charge — independent of Water's CN.
    await seedAdjustmentDoc({
      docId: DN1, documentNumber: "DN-8001", docType: "debit_note",
      originalDocumentId: D1, chargeId: CE, amount: "50.00",
    });
    detail = await getBillingDocumentDetail(ORG, D1);
    const water2 = detail!.lines.find((l) => l.chargeId === CW)!;
    const electricity2 = detail!.lines.find((l) => l.chargeId === CE)!;
    expect(electricity2.debitAdjustmentAmount).toBe("50.00");
    expect(electricity2.creditAdjustmentAmount).toBe("0.00");
    expect(electricity2.netAdjustmentAmount).toBe("50.00");
    expect(electricity2.adjustedAmount).toBe("450.00");
    expect(electricity2.adjustments).toEqual([
      { noteId: DN1, docType: "debit_note", documentNumber: "DN-8001", amountCents: 5000 },
    ]);
    // Water's earlier CN is still intact (unaffected by the new DN on a different charge).
    expect(water2.creditAdjustmentAmount).toBe("23.00");
    expect(water2.adjustedAmount).toBe("100.00");
  });

  it("pooled charge itemised across 2 lines (60/40): a credit note on the shared charge prorates by line amount and each line is 'prorated'", async () => {
    await seedCharge({ chargeId: C3, amount: "100.00", description: "Shared utilities" });
    await seedInvoiceDoc({
      docId: D2, documentNumber: "DEP-8002", total: "100.00",
      lines: [
        { chargeId: C3, amount: "60.00", description: "Electricity (TNB) 202606" },
        { chargeId: C3, amount: "40.00", description: "Water (Air Selangor) 202606" },
      ],
    });
    await seedAdjustmentDoc({
      docId: CN2, documentNumber: "CN-8002", docType: "credit_note",
      originalDocumentId: D2, chargeId: C3, amount: "10.00",
    });

    const detail = await getBillingDocumentDetail(ORG, D2);
    expect(detail?.lines).toHaveLength(2);
    const credits = detail!.lines.map((l) => l.creditAdjustmentAmount);
    expect(credits).toEqual(["6.00", "4.00"]); // 60/40 weighted split of the RM10 CN
    const sumCents = credits.reduce((s, x) => s + Math.round(Number(x) * 100), 0);
    expect(sumCents).toBe(1000); // parts foot exactly to the charge-level CN total
    expect(detail!.lines.every((l) => l.allocationBasis === "prorated")).toBe(true); // 1 charge : 2 lines
  });

  it("a CANCELLED note contributes nothing — all adjustment fields stay 0.00 and adjustedAmount == originalAmount", async () => {
    await seedCharge({ chargeId: C4, amount: "300.00", description: "Rent" });
    await seedInvoiceDoc({
      docId: D4, documentNumber: "DEP-8003", total: "300.00",
      lines: [{ chargeId: C4, amount: "300.00", description: "Rent" }],
    });
    await seedAdjustmentDoc({
      docId: DN2, documentNumber: "DN-8003", docType: "debit_note",
      originalDocumentId: D4, chargeId: C4, amount: "75.00", documentStatus: "CANCELLED",
    });

    const detail = await getBillingDocumentDetail(ORG, D4);
    const line = detail!.lines[0];
    expect(line.debitAdjustmentAmount).toBe("0.00");
    expect(line.creditAdjustmentAmount).toBe("0.00");
    expect(line.netAdjustmentAmount).toBe("0.00");
    expect(line.adjustments).toEqual([]);
    expect(line.originalAmount).toBe("300.00");
    expect(line.adjustedAmount).toBe("300.00");
  });
});
