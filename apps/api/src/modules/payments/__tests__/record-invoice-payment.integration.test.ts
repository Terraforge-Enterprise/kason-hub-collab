/**
 * recordInvoicePaymentService — invoice-scoped "Record payment" (manual bank
 * transfer). Real local Postgres. Run:
 *   RUN_INTEGRATION=1 ENABLE_PHASE2_BILLING_DOCS=1 ENABLE_PHASE2_MULTI_PAY=1 \
 *     npx vitest run src/modules/payments/__tests__/record-invoice-payment.integration.test.ts
 *
 * Covers the NEW invoice-scoped guarantees (the delegated record path is already
 * covered by record-and-allocate.test.ts / transfer-from-invoice.integration.test.ts):
 * total derived from allocations, per-line balances + invoice status update, receipt
 * issuance, allocations-must-belong-to-this-invoice, 404, and idempotent replay.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDb } from "@kason/db";
import { recordInvoicePaymentService } from "../payments.service";
import { ensureChargeCategorySeeds } from "../../charge-categories/seed";
import type { PaymentsSession } from "../payments.types";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  process.env.ENABLE_PHASE2_BILLING_DOCS = "1";
  process.env.ENABLE_PHASE2_MULTI_PAY = "1";
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`Refusing non-local DB host: ${host}`);
}

const ORG = "a9600000-0000-4000-8000-000000000001";
const USER = "a9600000-0000-4000-8000-000000000002";
const PARTY = "a9600000-0000-4000-8000-000000000003";
const DOC = "a9600000-0000-4000-8000-000000000010";
const CLEAN = "a9600000-0000-4000-8000-000000000011";
const WIFI = "a9600000-0000-4000-8000-000000000012";
const OFF_INVOICE = "a9600000-0000-4000-8000-000000000013";

const session: PaymentsSession = { orgId: ORG, userId: USER, role: "accountant" };

async function cleanup() {
  const db = getDb();
  await db.paymentAllocationReversal.deleteMany({ where: { organizationId: ORG } });
  await db.billingDocumentLine.deleteMany({ where: { document: { organizationId: ORG } } });
  await db.billingDocument.deleteMany({ where: { organizationId: ORG } });
  await db.paymentAllocation.deleteMany({ where: { organizationId: ORG } });
  await db.payment.deleteMany({ where: { organizationId: ORG } });
  await db.chargeEvent.deleteMany({ where: { organizationId: ORG } });
  await db.charge.deleteMany({ where: { organizationId: ORG } });
  await db.chargeCategory.deleteMany({ where: { organizationId: ORG } });
  await db.documentSeries.deleteMany({ where: { organizationId: ORG } });
  await db.referenceSequence.deleteMany({ where: { organizationId: ORG } });
  await db.auditLog.deleteMany({ where: { organizationId: ORG } });
  await db.user.deleteMany({ where: { organizationId: ORG } });
  await db.party.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function seed() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG, name: "Record-Invoice-Payment Org", slug: `org-${ORG}`, status: "active",
      defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free",
    },
  });
  await db.user.create({
    data: { id: USER, organizationId: ORG, email: "a960@test.local", fullName: "A960 Accountant", status: "active", role: "accountant", userType: "operator" },
  });
  await db.party.create({
    data: { id: PARTY, organizationId: ORG, displayName: "Puan Tan Mei Ling", partyType: "individual", status: "active" },
  });
  await ensureChargeCategorySeeds(ORG); // full registry incl. IVTEN + RCPT series
  const cat = await db.chargeCategory.findFirstOrThrow({ where: { organizationId: ORG, code: "cleaning_tenant" } });

  const mkCharge = (id: string, num: string, amount: string) =>
    db.charge.create({
      data: {
        id, organizationId: ORG, chargeNumber: num, partyId: PARTY, chargeType: "utility", categoryId: cat.id,
        status: "posted", postedAt: new Date(), dueDate: new Date("2026-07-31"),
        amount, currency: "MYR", outstandingAmount: amount, billingMonth: new Date("2026-07-01"),
      },
    });
  await mkCharge(CLEAN, "A960-CLEAN", "100.00");
  await mkCharge(WIFI, "A960-WIFI", "150.00");
  await mkCharge(OFF_INVOICE, "A960-OFF", "99.00"); // exists for the payer but NOT on this invoice

  await db.billingDocument.create({
    data: {
      id: DOC, organizationId: ORG, docType: "invoice", documentNumber: "IVTEN-A960", seriesId: cat.seriesId,
      status: "issued", issuedById: USER, counterpartyType: "tenant", partyId: PARTY,
      billingMonth: new Date("2026-07-01"), subtotal: "250.00", sstAmount: 0, total: "250.00",
      lines: {
        create: [
          { chargeId: CLEAN, categoryId: cat.id, description: "Cleaning 202607", amount: "100.00", sstRate: 0, sstAmount: 0 },
          { chargeId: WIFI, categoryId: cat.id, description: "WiFi 202607", amount: "150.00", sstRate: 0, sstAmount: 0 },
        ],
      },
    },
  });
}

function baseInput(over: Partial<Parameters<typeof recordInvoicePaymentService>[1]> = {}) {
  return {
    documentId: DOC,
    paymentNumber: `RCV-${DOC.slice(-6)}-${Math.floor(Number(DOC.slice(-3)))}`,
    receivedAt: "2026-07-20",
    idempotencyKey: "a9600000-0000-4000-8000-0000000000f1",
    attachmentKeys: ["orgs/o/refund-proofs/slip.jpg"],
    allocations: [{ chargeId: CLEAN, allocatedAmount: "40.00" }],
    ...over,
  };
}

dn("recordInvoicePaymentService (integration)", () => {
  beforeEach(async () => {
    await cleanup();
    await seed();
  });
  afterEach(cleanup);

  it("partial: derives amount from allocations, decrements the line, sets Partially paid", async () => {
    const db = getDb();
    const res = await recordInvoicePaymentService(session, baseInput({ paymentNumber: "RCV-A960-1" }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const payment = await db.payment.findUniqueOrThrow({
      where: { id: res.data.id },
      select: { amount: true, attachmentKeys: true, allocations: { select: { chargeId: true } } },
    });
    expect(Number(payment.amount)).toBe(40); // = Σ allocations, not a client total
    expect(payment.allocations).toHaveLength(1);
    expect(payment.attachmentKeys).toEqual(["orgs/o/refund-proofs/slip.jpg"]);
    // Cleaning charge decremented 100 → 60; invoice not fully settled.
    const clean = await db.charge.findUniqueOrThrow({ where: { id: CLEAN }, select: { outstandingAmount: true, status: true } });
    expect(Number(clean.outstandingAmount)).toBe(60);
    expect(clean.status).toBe("partially_paid");
    const doc = await db.billingDocument.findUniqueOrThrow({ where: { id: DOC }, select: { settlementStatus: true } });
    expect(doc.settlementStatus).toBe("PARTIALLY_PAID");
  });

  it("full: paying every line settles the charges and marks the invoice Paid; one receipt is issued", async () => {
    const db = getDb();
    const res = await recordInvoicePaymentService(session, baseInput({
      paymentNumber: "RCV-A960-2",
      idempotencyKey: "a9600000-0000-4000-8000-0000000000f2",
      allocations: [
        { chargeId: CLEAN, allocatedAmount: "100.00" },
        { chargeId: WIFI, allocatedAmount: "150.00" },
      ],
    }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const charges = await db.charge.findMany({ where: { id: { in: [CLEAN, WIFI] } }, select: { outstandingAmount: true, status: true } });
    for (const c of charges) {
      expect(Number(c.outstandingAmount)).toBe(0);
      expect(c.status).toBe("paid");
    }
    const doc = await db.billingDocument.findUniqueOrThrow({ where: { id: DOC }, select: { settlementStatus: true } });
    expect(doc.settlementStatus).toBe("PAID");
    const receipts = await db.billingDocument.findMany({ where: { organizationId: ORG, docType: "receipt", paymentId: res.data.id } });
    expect(receipts).toHaveLength(1);
  });

  it("rejects an allocation whose charge is NOT a line on this invoice (400, no payment)", async () => {
    const db = getDb();
    const before = await db.payment.count({ where: { organizationId: ORG } });
    const res = await recordInvoicePaymentService(session, baseInput({
      paymentNumber: "RCV-A960-3",
      idempotencyKey: "a9600000-0000-4000-8000-0000000000f3",
      allocations: [{ chargeId: OFF_INVOICE, allocatedAmount: "10.00" }],
    }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/does not belong to this invoice/i);
    expect(await db.payment.count({ where: { organizationId: ORG } })).toBe(before);
  });

  it("rejects an unknown document (404)", async () => {
    const res = await recordInvoicePaymentService(session, baseInput({
      documentId: "a9600000-0000-4000-8000-0000000000ee",
      paymentNumber: "RCV-A960-4",
      idempotencyKey: "a9600000-0000-4000-8000-0000000000f4",
    }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(404);
  });

  it("replaying the same idempotencyKey does not create a second receipt/payment", async () => {
    const db = getDb();
    const input = baseInput({ paymentNumber: "RCV-A960-5", idempotencyKey: "a9600000-0000-4000-8000-0000000000f5" });
    const first = await recordInvoicePaymentService(session, input);
    expect(first.ok).toBe(true);
    const second = await recordInvoicePaymentService(session, input);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) expect(second.data.id).toBe(first.data.id);
    expect(await db.payment.count({ where: { organizationId: ORG } })).toBe(1);
  });
});
