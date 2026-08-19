/**
 * Formula A (settlement basis, status.service — SST-EXCLUSIVE) and Formula B
 * (adjusted payable, derive-for-docs — SST-INCLUSIVE) must count the SAME active
 * note set (§7-A1/A5/A7). Real LOCAL Postgres (opt-in RUN_INTEGRATION=1).
 *
 *  - zero-SST fixtures: the two bases are numerically EQUAL;
 *  - non-zero-SST fixtures: they differ ONLY by SST but both COUNT the same note
 *    (set-agreement);
 *  - cancelling a note drops it from BOTH.
 *
 * Run:
 *   cd apps/api
 *   RUN_INTEGRATION=1 ENABLE_PHASE2_BILLING_DOCS=1 \
 *     npx vitest run src/modules/billing-documents/__tests__/formula-agreement.integration.test.ts
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getDb } from "@kason/db";
import { refreshDocumentStatusForCharges } from "../status.service";
import { deriveForDocs } from "../derive-for-docs";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
  process.env.ENABLE_PHASE2_BILLING_DOCS = "1";
}

// Fixed disjoint UUIDs (prefix b710; unused by any other suite)
const ORG = "b7100000-0000-4000-8000-000000000001";
const USER = "b7100000-0000-4000-8000-000000000002";
const TENANT = "b7100000-0000-4000-8000-000000000003";
const CAT = "b7100000-0000-4000-8000-000000000004";
const SERIES = "b7100000-0000-4000-8000-000000000005";
const C1 = "b7100000-0000-4000-8000-000000000011";
const D1 = "b7100000-0000-4000-8000-000000000012";
const P1 = "b7100000-0000-4000-8000-000000000013";
const NOTE = "b7100000-0000-4000-8000-000000000014";

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
      id: ORG, name: "Formula Agreement Org", slug: `org-${ORG}`, status: "active",
      defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free",
    },
  });
  await db.user.create({
    data: {
      id: USER, organizationId: ORG, email: "b710@test.local", passwordHash: "x", role: "admin",
      fullName: "B710 Admin", status: "active", userType: "operator",
    },
  });
  await db.party.create({
    data: { id: TENANT, organizationId: ORG, displayName: "Agree Tenant", partyType: "individual", status: "active" },
  });
  await db.documentSeries.create({
    data: { id: SERIES, organizationId: ORG, code: "DEP", prefix: "DEP", padding: 4, includeYear: false, active: true },
  });
  await db.chargeCategory.create({
    data: {
      id: CAT, organizationId: ORG, code: "rental", name: "Monthly rental",
      family: "pay_back_landlord", docType: "debit_note", seriesId: SERIES,
      defaultSstRate: 0, eInvoiceEligible: false, ledgerCategory: "rental_income",
      isSystem: true, active: true, sortOrder: 1,
    },
  });
}

/** Invoice + posted charge. base = SST-exclusive amount; sst = SST amount (0 for zero-SST). */
async function seedInvoice(base: string, sst: string) {
  const db = getDb();
  const total = (Number(base) + Number(sst)).toFixed(2);
  await db.charge.create({
    data: {
      id: C1, organizationId: ORG, chargeNumber: "B710-C1", partyId: TENANT, chargeType: "rental",
      categoryId: CAT, status: "paid", postedAt: new Date(), description: "Rent", dueDate: new Date("2026-06-30"),
      amount: base, currency: "MYR", outstandingAmount: "0.00", billingMonth: new Date("2026-06-01"),
    },
  });
  await db.billingDocument.create({
    data: {
      id: D1, organizationId: ORG, docType: "invoice", documentNumber: "DEP-8001", seriesId: SERIES,
      status: "issued", issuedById: USER, counterpartyType: "tenant", partyId: TENANT,
      billingMonth: new Date("2026-06-01"), subtotal: base, sstAmount: sst, total,
      lines: { create: [{ chargeId: C1, categoryId: CAT, description: "Rent", amount: base, sstRate: sst === "0.00" ? 0 : 8, sstAmount: sst }] },
    },
  });
}

/** A charge-backed CN linked to D1. base = SST-exclusive line amount; sst = SST on the note. */
async function seedCreditNote(base: string, sst: string) {
  const db = getDb();
  const total = (Number(base) + Number(sst)).toFixed(2);
  await db.billingDocument.create({
    data: {
      id: NOTE, organizationId: ORG, docType: "credit_note", documentNumber: "CN-8001", seriesId: SERIES,
      status: "issued", issuedById: USER, counterpartyType: "tenant", partyId: TENANT,
      originalDocumentId: D1, creditAmount: total, subtotal: base, sstAmount: sst, total,
      lines: { create: [{ chargeId: C1, categoryId: CAT, description: "correction", amount: base, sstRate: sst === "0.00" ? 0 : 8, sstAmount: sst }] },
    },
  });
}

async function seedClearedPayment(amount: string) {
  const db = getDb();
  await db.payment.create({
    data: {
      id: P1, organizationId: ORG, paymentNumber: "PAY-8001", partyId: TENANT, paymentType: "incoming",
      paymentMethod: "bank_transfer", status: "posted", amount, currency: "MYR", receivedAt: new Date(),
    },
  });
  await db.paymentAllocation.create({
    data: { organizationId: ORG, paymentId: P1, chargeId: C1, allocatedAmount: amount, allocatedAt: new Date() },
  });
}

/** Formula B adjusted payable (SST-inclusive) for D1. */
async function adjustedPayableB(): Promise<number> {
  const db = getDb();
  const doc = await db.billingDocument.findUniqueOrThrow({
    where: { id: D1 },
    select: { id: true, documentStatus: true, supersededByDocumentId: true, settlementStatus: true, total: true },
  });
  const map = await deriveForDocs(ORG, [doc]);
  return map.get(D1)!.adjustedCents;
}

async function settlementA(): Promise<string> {
  await refreshDocumentStatusForCharges([C1]);
  return (await getDb().billingDocument.findUniqueOrThrow({ where: { id: D1 } })).settlementStatus;
}

dn("Formula A / B agreement on the active-note set (integration)", () => {
  beforeEach(async () => {
    await cleanup();
    await seedBase();
  });
  afterAll(cleanup);

  it("zero-SST: an ISSUED CN → A basis == B adjusted payable == 700 (numerically equal)", async () => {
    await seedInvoice("1000.00", "0.00");
    await seedCreditNote("300.00", "0.00");
    await seedClearedPayment("1000.00"); // cleared 1000 vs adjusted 700

    expect(await adjustedPayableB()).toBe(70000); // B: 1000 − 300
    expect(await settlementA()).toBe("OVERPAID"); // A: cleared 1000 > 700 → confirms A's basis is also 700
  });

  it("zero-SST: cancelling the CN drops it from BOTH (basis back to 1000 → PAID)", async () => {
    await seedInvoice("1000.00", "0.00");
    await seedCreditNote("300.00", "0.00");
    await seedClearedPayment("1000.00");
    expect(await settlementA()).toBe("OVERPAID");

    await getDb().billingDocument.update({ where: { id: NOTE }, data: { documentStatus: "CANCELLED" } });
    expect(await adjustedPayableB()).toBe(100000); // B: back to 1000 (CN dropped)
    expect(await settlementA()).toBe("PAID"); // A: cleared 1000 == 1000 → PAID (CN dropped)
  });

  it("non-zero-SST: bases differ ONLY by SST but BOTH count the CN (set-agreement)", async () => {
    // Invoice base 1000 + 8% SST 80 → total 1080. CN base 300 + SST 24 → total 324.
    await seedInvoice("1000.00", "80.00");
    await seedCreditNote("300.00", "24.00");
    await seedClearedPayment("1000.00"); // cleared 1000 (SST-exclusive base) vs A basis 700

    // B is SST-inclusive: 1080 − 324 = 756.
    expect(await adjustedPayableB()).toBe(75600);
    // A is SST-exclusive: 1000 − 300 = 700; cleared 1000 > 700 → OVERPAID (the CN moved A too).
    expect(await settlementA()).toBe("OVERPAID");

    // Cancel → BOTH revert: B back to 1080, A basis back to 1000 (cleared 1000 == 1000 → PAID).
    await getDb().billingDocument.update({ where: { id: NOTE }, data: { documentStatus: "CANCELLED" } });
    expect(await adjustedPayableB()).toBe(108000);
    expect(await settlementA()).toBe("PAID");
  });
});
