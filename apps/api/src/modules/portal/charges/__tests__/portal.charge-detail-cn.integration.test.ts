/**
 * Portal charge detail — CN visibility (integration, RUN_INTEGRATION=1).
 * Proves: a credited charge's detail lists its original document + the CN
 * (documents[]), and a credit-note payment shows as a creditApplications line
 * with the CN number. Flag-dark: both arrays empty.
 *
 * Run:
 *   cd apps/api
 *   RUN_INTEGRATION=1 ENABLE_PHASE2_BILLING_DOCS=1 \
 *     npx vitest run src/modules/portal/charges/__tests__/portal.charge-detail-cn.integration.test.ts
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getDb } from "@kason/db";
import { getChargeDetail } from "../portal.charges.repository";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
  process.env.ENABLE_PHASE2_BILLING_DOCS = "1";
}

// Fixed disjoint UUIDs (prefix 9c35)
const ORG = "9c350000-0000-4000-8000-000000000001";
const USER = "9c350000-0000-4000-8000-000000000002";
const TENANT = "9c350000-0000-4000-8000-000000000003";
const CAT = "9c350000-0000-4000-8000-000000000004";
const SERIES = "9c350000-0000-4000-8000-000000000005";
const CHARGE = "9c350000-0000-4000-8000-000000000006";
const DOC = "9c350000-0000-4000-8000-000000000007";
const CN = "9c350000-0000-4000-8000-000000000008";
const PAY = "9c350000-0000-4000-8000-000000000009";

async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  await db.creditApplication.deleteMany({ where: org });
  await db.paymentAllocation.deleteMany({ where: org });
  await db.payment.deleteMany({ where: org });
  await db.billingDocumentLine.deleteMany({ where: { document: org } });
  await db.billingDocument.deleteMany({ where: org });
  await db.charge.deleteMany({ where: org });
  await db.chargeCategory.deleteMany({ where: org });
  await db.documentSeries.deleteMany({ where: org });
  await db.user.deleteMany({ where: { id: USER } });
  await db.party.deleteMany({ where: org });
  await db.organization.deleteMany({ where: { id: ORG } });
}

dn("portal getChargeDetail CN visibility (integration)", () => {
  beforeEach(async () => {
    await cleanup();
    const db = getDb();
    await db.organization.create({
      data: {
        id: ORG, name: "P3 Portal Org", slug: `org-${ORG}`, status: "active",
        defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free",
      },
    });
    await db.user.create({
      data: {
        id: USER, organizationId: ORG, email: "p3portal@test.local", passwordHash: "x", role: "admin",
        fullName: "P3 Admin", status: "active", userType: "operator",
      },
    });
    await db.party.create({
      data: { id: TENANT, organizationId: ORG, displayName: "Portal Tenant", partyType: "individual", status: "active" },
    });
    await db.documentSeries.create({
      data: { id: SERIES, organizationId: ORG, code: "DEP", prefix: "DEP", padding: 4, includeYear: false, active: true },
    });
    await db.chargeCategory.create({
      data: {
        id: CAT, organizationId: ORG, code: "rental", name: "Monthly rental",
        family: "pay_back_landlord", docType: "debit_note", seriesId: SERIES,
        defaultSstRate: 0, eInvoiceEligible: false, isSystem: true, active: true, sortOrder: 1,
      },
    });
    await db.charge.create({
      data: {
        id: CHARGE, organizationId: ORG, chargeNumber: "PORTAL-1", partyId: TENANT,
        chargeType: "rental", categoryId: CAT, status: "paid", postedAt: new Date(),
        dueDate: new Date(Date.UTC(2026, 6, 31)), amount: "70.00", currency: "MYR",
        outstandingAmount: "0.00",
      },
    });
    await db.billingDocument.create({
      data: {
        id: DOC, organizationId: ORG, docType: "debit_note", documentNumber: "DEP-5001",
        seriesId: SERIES, status: "settled", issuedById: USER, counterpartyType: "tenant",
        partyId: TENANT, subtotal: "70.00", sstAmount: 0, total: "70.00",
        lines: { create: [{ chargeId: CHARGE, categoryId: CAT, description: "Rent July", amount: "70.00", sstRate: 0, sstAmount: 0 }] },
      },
    });
    await db.billingDocument.create({
      data: {
        id: CN, organizationId: ORG, docType: "credit_note", documentNumber: "CN-5001",
        seriesId: SERIES, status: "issued", issuedById: USER, counterpartyType: "tenant",
        partyId: TENANT, creditAmount: "30.00", subtotal: "30.00", sstAmount: 0, total: "30.00",
      },
    });
    await db.payment.create({
      data: {
        id: PAY, organizationId: ORG, paymentNumber: "CNA-CN-5001-PORTAL-1", partyId: TENANT,
        paymentType: "credit_application", paymentMethod: "credit_note", status: "posted",
        amount: "30.00", currency: "MYR", receivedAt: new Date(),
        idempotencyKey: `cnapply:${CN}:${CHARGE}`,
      },
    });
    await db.paymentAllocation.create({
      data: { organizationId: ORG, paymentId: PAY, chargeId: CHARGE, allocatedAmount: "30.00", allocatedAt: new Date() },
    });
    await db.creditApplication.create({
      data: { organizationId: ORG, creditDocumentId: CN, paymentId: PAY, appliedById: USER },
    });
  });
  afterAll(cleanup);

  it("lists the charge's documents and the credit-applied CN line", async () => {
    const detail = await getChargeDetail({ partyId: TENANT, orgId: ORG }, CHARGE);
    expect(detail).not.toBeNull();
    expect(detail!.documents).toEqual([
      { id: DOC, docType: "debit_note", documentNumber: "DEP-5001" },
    ]);
    expect(detail!.creditApplications).toEqual([{ amount: 30, creditNoteNumber: "CN-5001" }]);
  });
});
