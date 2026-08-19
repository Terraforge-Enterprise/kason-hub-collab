/**
 * Transfer-from-Invoice (P3 T9, R9/R10/R8-consume) — end-to-end regression
 * guard for the money-recording path + receipt issuance wiring. Real local
 * Postgres. Run:
 *   RUN_INTEGRATION=1 ENABLE_PHASE2_BILLING_DOCS=1 \
 *     npx vitest run src/modules/payments/__tests__/transfer-from-invoice.integration.test.ts
 *
 * Seed pattern mirrors payments.multipay.integration.test.ts + Task 5's
 * ChargeCategory seed (issue-for-charges.integration.test.ts style).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDb } from "@kason/db";
import { recordAndAllocatePaymentService } from "../payments.service";
import { getPaymentProofUrlsService } from "../payments.proof-urls";
import type { PaymentsSession } from "../payments.types";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

const ORG = "a9500000-0000-4000-8000-000000000001";
const USER = "a9500000-0000-4000-8000-000000000002";
const PARTY = "a9500000-0000-4000-8000-000000000003";
const RENT_CHARGE = "a9500000-0000-4000-8000-000000000011";
const CLEANING_CHARGE = "a9500000-0000-4000-8000-000000000012";

async function cleanup() {
  const db = getDb();
  await db.billingDocumentLine.deleteMany({ where: { document: { organizationId: ORG } } });
  await db.billingDocument.deleteMany({ where: { organizationId: ORG } });
  await db.paymentAllocation.deleteMany({ where: { organizationId: ORG } });
  await db.payment.deleteMany({ where: { organizationId: ORG } });
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
      id: ORG, name: "P3 T9 Integration Test Org", slug: "a95-int-test", status: "active",
      defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free",
    },
  });
  await db.party.create({
    data: { id: PARTY, organizationId: ORG, displayName: "P3 T9 Tenant", partyType: "individual", status: "active" },
  });
  await db.user.create({
    data: {
      id: USER, organizationId: ORG, email: "p3-t9-int@example.test", fullName: "P3 T9 Operator",
      status: "active", role: "accountant", userType: "operator",
    },
  });
  const dep = await db.documentSeries.create({
    data: { organizationId: ORG, code: "DEP", prefix: "DEP", padding: 4, includeYear: false, active: true },
  });
  await db.chargeCategory.create({
    data: {
      organizationId: ORG, code: "rental", name: "Monthly rental", family: "pay_back_landlord",
      docType: "debit_note", seriesId: dep.id, defaultSstRate: "0", eInvoiceEligible: false,
      ledgerCategory: "rental_income", isSystem: true, active: true, sortOrder: 1,
    },
  });
  await db.chargeCategory.create({
    data: {
      organizationId: ORG, code: "cleaning_tenant", name: "Cleaning", family: "tenant_income",
      docType: "invoice", seriesId: dep.id, defaultSstRate: "0", eInvoiceEligible: false,
      ledgerCategory: "cleaning_income", isSystem: true, active: true, sortOrder: 2,
    },
  });
  await db.charge.create({
    data: {
      id: RENT_CHARGE, organizationId: ORG, chargeNumber: "CHG-A95-RENT", partyId: PARTY,
      chargeType: "rental", status: "posted", dueDate: new Date("2026-07-30T00:00:00.000Z"),
      amount: "100.00", currency: "MYR", outstandingAmount: "100.00",
    },
  });
  await db.charge.create({
    data: {
      id: CLEANING_CHARGE, organizationId: ORG, chargeNumber: "CHG-A95-CLEAN", partyId: PARTY,
      chargeType: "cleaning_tenant", status: "posted", dueDate: new Date("2026-07-30T00:00:00.000Z"),
      amount: "50.00", currency: "MYR", outstandingAmount: "50.00",
    },
  });
}

dn("Transfer-from-Invoice (R9/R10)", () => {
  beforeEach(async () => {
    await cleanup();
    await seed();
  });
  afterEach(async () => {
    await cleanup();
  });

  it("records two allocations, persists the slip, issues one receipt", async () => {
    const db = getDb();
    const session: PaymentsSession = { orgId: ORG, userId: USER, role: "accountant" };
    const res = await recordAndAllocatePaymentService(session, {
      paymentNumber: `RCV-${Date.now()}`,
      partyId: PARTY,
      paymentType: "rental_payment",
      paymentMethod: "bank_transfer",
      currency: "MYR",
      receivedAt: "2026-07-13",
      idempotencyKey: crypto.randomUUID(),
      attachmentKeys: ["orgs/o/refund-proofs/slip.jpg"],
      allocations: [
        { chargeId: RENT_CHARGE, allocatedAmount: "100.00" },
        { chargeId: CLEANING_CHARGE, allocatedAmount: "50.00" },
      ],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const payment = await db.payment.findUnique({
      where: { id: res.data.id },
      select: { status: true, attachmentKeys: true, allocations: { select: { id: true } } },
    });
    expect(payment?.status).toBe("posted");
    expect(payment?.allocations).toHaveLength(2);
    expect(payment?.attachmentKeys).toEqual(["orgs/o/refund-proofs/slip.jpg"]);

    // R10: proof-urls returns one signed URL for the slip.
    const proofs = await getPaymentProofUrlsService(session.orgId, res.data.id);
    expect(proofs.ok && proofs.urls.length).toBe(1);

    // R8 (P2 hook): exactly one receipt document linked by paymentId.
    const receipts = await db.billingDocument.findMany({
      where: { organizationId: session.orgId, docType: "receipt", paymentId: res.data.id },
      select: { id: true },
    });
    expect(receipts).toHaveLength(1);
  });

  it("rejects an over-cap allocation without creating a payment", async () => {
    const db = getDb();
    const session: PaymentsSession = { orgId: ORG, userId: USER, role: "accountant" };
    const before = await db.payment.count({ where: { organizationId: session.orgId } });
    const res = await recordAndAllocatePaymentService(session, {
      paymentNumber: `RCV-${Date.now()}`,
      partyId: PARTY,
      paymentType: "rental_payment",
      paymentMethod: "bank_transfer",
      currency: "MYR",
      receivedAt: "2026-07-13",
      idempotencyKey: crypto.randomUUID(),
      allocations: [{ chargeId: RENT_CHARGE, allocatedAmount: "120.00" }],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/exceeds the charge's outstanding/i);
    const after = await db.payment.count({ where: { organizationId: session.orgId } });
    expect(after).toBe(before);
  });
});
