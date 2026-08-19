import { describe, it, expect, afterAll } from "vitest";
import { getDb } from "@kason/db";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

// Fixed disjoint UUIDs (prefix 9c34; unused by any other suite).
const ORG = "9c340000-0000-4000-8000-000000000001";
const USER = "9c340000-0000-4000-8000-000000000002";
const PARTY = "9c340000-0000-4000-8000-000000000003";
const SERIES = "9c340000-0000-4000-8000-000000000004";
const DOC_NULL = "9c340000-0000-4000-8000-000000000005";
const DOC_FULL = "9c340000-0000-4000-8000-000000000006";
const CHARGE = "9c340000-0000-4000-8000-000000000007";
const CAT = "9c340000-0000-4000-8000-000000000008";

async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  await db.billingDocumentLine.deleteMany({ where: { document: org } });
  await db.billingDocument.deleteMany({ where: org });
  await db.charge.deleteMany({ where: org });
  await db.chargeCategory.deleteMany({ where: org });
  await db.documentSeries.deleteMany({ where: org });
  await db.user.deleteMany({ where: { id: USER } });
  await db.party.deleteMany({ where: org });
  await db.organization.deleteMany({ where: { id: ORG } });
}

dn("BillingDocumentLine nullable chargeId/categoryId (integration)", () => {
  afterAll(cleanup);

  it("accepts a line with null chargeId AND null categoryId, and a fully-populated line", async () => {
    const db = getDb();
    await cleanup();
    await db.organization.create({
      data: {
        id: ORG, name: "P4 Nullable Org", slug: `org-${ORG}`, status: "active",
        defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free",
      },
    });
    await db.user.create({
      data: { id: USER, organizationId: ORG, email: "p4null@test.local", passwordHash: "x", role: "accountant", fullName: "P4 Acc", status: "active", userType: "operator" },
    });
    await db.party.create({
      data: { id: PARTY, organizationId: ORG, displayName: "Nullable Tenant", partyType: "individual", status: "active" },
    });
    await db.documentSeries.create({
      data: { id: SERIES, organizationId: ORG, code: "CN", prefix: "CN", padding: 4, includeYear: false, active: true },
    });

    // charge-less + category-less line
    await db.billingDocument.create({
      data: {
        id: DOC_NULL, organizationId: ORG, docType: "credit_note", documentNumber: "CN-9401",
        seriesId: SERIES, status: "issued", issuedById: USER, counterpartyType: "tenant", partyId: PARTY,
        subtotal: "50.00", sstAmount: "0", total: "50.00", creditAmount: "50.00",
        lines: { create: [{ chargeId: null, categoryId: null, description: "Overpayment", amount: "50.00", sstRate: "0", sstAmount: "0" }] },
      },
    });
    const nullLine = await db.billingDocumentLine.findFirstOrThrow({ where: { documentId: DOC_NULL } });
    expect(nullLine.chargeId).toBeNull();
    expect(nullLine.categoryId).toBeNull();

    // fully-populated line still inserts (regression guard)
    await db.chargeCategory.create({
      data: { id: CAT, organizationId: ORG, code: "rental", name: "Rent", family: "pay_back_landlord", docType: "debit_note", seriesId: SERIES, defaultSstRate: 0, eInvoiceEligible: false, ledgerCategory: "rental_income", isSystem: true, active: true, sortOrder: 1 },
    });
    await db.charge.create({
      data: { id: CHARGE, organizationId: ORG, chargeNumber: "P4-NULL-1", partyId: PARTY, chargeType: "rental", categoryId: CAT, status: "posted", postedAt: new Date(), amount: "100.00", currency: "MYR", outstandingAmount: "100.00", dueDate: new Date("2026-06-30") },
    });
    await db.billingDocument.create({
      data: {
        id: DOC_FULL, organizationId: ORG, docType: "debit_note", documentNumber: "DEP-9401",
        seriesId: SERIES, status: "issued", issuedById: USER, counterpartyType: "tenant", partyId: PARTY,
        subtotal: "100.00", sstAmount: "0", total: "100.00",
        lines: { create: [{ chargeId: CHARGE, categoryId: CAT, description: "Rent", amount: "100.00", sstRate: "0", sstAmount: "0" }] },
      },
    });
    const fullLine = await db.billingDocumentLine.findFirstOrThrow({ where: { documentId: DOC_FULL } });
    expect(fullLine.chargeId).toBe(CHARGE);
    expect(fullLine.categoryId).toBe(CAT);
  });
});
