/**
 * Task 10 (R6): the read DTOs expose the three status axes added in Task 1
 * (`documentStatus`, `taxStatus`, `settlementStatus`) alongside the retained
 * legacy `status` field (transition, R10) — real LOCAL Postgres (opt-in
 * RUN_INTEGRATION=1).
 *
 * Proves: list item[0] carries all three axes + legacy status; detail carries
 * them (inherited); a legacy offset/receipt doc has every axis field DEFINED
 * (never undefined) + a resolvable legacy status.
 *
 * Run:
 *   cd apps/api
 *   RUN_INTEGRATION=1 ENABLE_PHASE2_BILLING_DOCS=1 \
 *     npx vitest run src/modules/billing-documents/__tests__/dto-axes.integration.test.ts
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getDb } from "@kason/db";
import { listBillingDocuments, getBillingDocumentDetail } from "../repository";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
  process.env.ENABLE_PHASE2_BILLING_DOCS = "1";
}

// Fixed disjoint UUIDs (prefix b8; unused by any other suite)
const ORG = "b8000000-0000-4000-8000-000000000001";
const USER = "b8000000-0000-4000-8000-000000000002";
const TENANT = "b8000000-0000-4000-8000-000000000003";
const CAT = "b8000000-0000-4000-8000-000000000004";
const SERIES_IV = "b8000000-0000-4000-8000-000000000005";
const SERIES_RC = "b8000000-0000-4000-8000-000000000006";
const SERIES_RP = "b8000000-0000-4000-8000-000000000007";
const DOC_INVOICE = "b8000000-0000-4000-8000-000000000011";
const DOC_LEGACY = "b8000000-0000-4000-8000-000000000012";
// Task 12 (R9): a receipt whose paymentId links back to its Payment, so the
// Receipts row can offer "Void payment" ({ paymentId }).
const DOC_RECEIPT_PID = "b8000000-0000-4000-8000-000000000013";
const PAYMENT = "b8000000-0000-4000-8000-000000000014";

async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  await db.billingDocumentLine.deleteMany({ where: { document: org } });
  await db.billingDocument.deleteMany({ where: org });
  await db.payment.deleteMany({ where: org });
  await db.referenceSequence.deleteMany({ where: org });
  await db.chargeCategory.deleteMany({ where: org });
  await db.documentSeries.deleteMany({ where: org });
  await db.auditLog.deleteMany({ where: org });
  await db.user.deleteMany({ where: { id: USER } });
  await db.party.deleteMany({ where: org });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function seed() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG, name: "T10 DTO Org", slug: `org-${ORG}`, status: "active",
      defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free",
    },
  });
  await db.user.create({
    data: {
      id: USER, organizationId: ORG, email: "t10dto@test.local", passwordHash: "x", role: "admin",
      fullName: "T10 Admin", status: "active", userType: "operator",
    },
  });
  await db.party.create({
    data: { id: TENANT, organizationId: ORG, displayName: "DTO Tenant", partyType: "individual", status: "active" },
  });
  await db.documentSeries.create({
    data: { id: SERIES_IV, organizationId: ORG, code: "IV", prefix: "IV", padding: 4, includeYear: false, active: true },
  });
  await db.documentSeries.create({
    data: { id: SERIES_RC, organizationId: ORG, code: "RC", prefix: "RC", padding: 4, includeYear: false, active: true },
  });
  await db.documentSeries.create({
    data: { id: SERIES_RP, organizationId: ORG, code: "RP", prefix: "RP", padding: 4, includeYear: false, active: true },
  });
  await db.chargeCategory.create({
    data: {
      id: CAT, organizationId: ORG, code: "rental", name: "Monthly rental",
      family: "pay_back_landlord", docType: "debit_note", seriesId: SERIES_IV,
      defaultSstRate: 0, eInvoiceEligible: false, ledgerCategory: "rental_income",
      isSystem: true, active: true, sortOrder: 1,
    },
  });

  // A normal ISSUED invoice — axes carry the Task-1 DEFAULTs (documentStatus
  // ISSUED, taxStatus NOT_REQUIRED, settlementStatus UNPAID).
  await db.billingDocument.create({
    data: {
      id: DOC_INVOICE, organizationId: ORG, docType: "invoice",
      documentNumber: "IV-0001", seriesId: SERIES_IV, status: "issued",
      issuedById: USER, counterpartyType: "tenant", partyId: TENANT,
      billingMonth: new Date("2026-06-01"),
      subtotal: "100.00", sstAmount: "0", total: "100.00",
      issuedAt: new Date("2026-06-02T00:00:00.000Z"),
      lines: {
        create: [{ chargeId: null, categoryId: CAT, description: "Rent June", amount: "100.00", sstRate: 0, sstAmount: 0 }],
      },
    },
  });

  // Task 12 (R9): a Payment + a receipt document that links to it via paymentId.
  // The Receipts row's "Void payment" needs paymentId exposed in the list DTO.
  await db.payment.create({
    data: {
      id: PAYMENT, organizationId: ORG, paymentNumber: "PAY-0001", partyId: TENANT,
      paymentType: "transfer", paymentMethod: "bank_transfer", status: "posted",
      amount: "50.00", currency: "MYR", receivedAt: new Date("2026-06-03T00:00:00.000Z"),
    },
  });
  await db.billingDocument.create({
    data: {
      id: DOC_RECEIPT_PID, organizationId: ORG, docType: "receipt",
      documentNumber: "RP-0001", seriesId: SERIES_RP, status: "issued",
      issuedById: USER, counterpartyType: "tenant", partyId: TENANT, paymentId: PAYMENT,
      subtotal: "50.00", sstAmount: "0", total: "50.00",
      issuedAt: new Date("2026-06-04T00:00:00.000Z"),
    },
  });

  // A legacy receipt document seeded via raw SQL WITHOUT the axis columns — the
  // DB DEFAULTs must supply them, and the enrich map must surface them (never
  // undefined). Legacy `status` ('offset') must still resolve.
  await db.$executeRawUnsafe(
    `INSERT INTO "BillingDocument"
       ("id","organizationId","docType","documentNumber","seriesId","status","issuedById","counterpartyType","partyId","subtotal","sstAmount","total","issuedAt","updatedAt")
     VALUES ($1,$2,'receipt','RC-0001',$3,'offset',$4,'tenant',$5,'50.00','0','50.00',$6,NOW())`,
    DOC_LEGACY, ORG, SERIES_RC, USER, TENANT, new Date("2026-06-01T00:00:00.000Z"),
  );
}

const AXES = ["documentStatus", "taxStatus", "settlementStatus"] as const;

dn("billing-document read DTOs expose the three status axes (R6)", () => {
  beforeEach(async () => {
    await cleanup();
    await seed();
  });
  afterAll(cleanup);

  it("list exposes axes", async () => {
    const { items } = await listBillingDocuments(ORG, {
      seriesId: SERIES_IV, page: 1, pageSize: 25,
    });
    expect(items).toHaveLength(1);
    const item = items[0];
    // Legacy status retained (transition, R10).
    expect(item.status).toBe("issued");
    // All three axes present with the Task-1 DEFAULTs.
    expect(item.documentStatus).toBe("ISSUED");
    expect(item.taxStatus).toBe("NOT_REQUIRED");
    expect(item.settlementStatus).toBe("UNPAID");
    for (const axis of AXES) expect(item[axis]).not.toBeUndefined();
  });

  it("detail exposes axes", async () => {
    const detail = await getBillingDocumentDetail(ORG, DOC_INVOICE);
    expect(detail).not.toBeNull();
    expect(detail!.status).toBe("issued");
    expect(detail!.documentStatus).toBe("ISSUED");
    expect(detail!.taxStatus).toBe("NOT_REQUIRED");
    expect(detail!.settlementStatus).toBe("UNPAID");
    for (const axis of AXES) expect(detail![axis]).not.toBeUndefined();
  });

  it("list exposes paymentId on a receipt (R9 — powers Void payment)", async () => {
    const { items } = await listBillingDocuments(ORG, {
      seriesId: SERIES_RP, page: 1, pageSize: 25,
    });
    const receipt = items.find((i) => i.documentNumber === "RP-0001");
    expect(receipt).toBeDefined();
    // The receipt links back to its Payment so the row can offer "Void payment".
    expect(receipt!.paymentId).toBe(PAYMENT);
    // A non-linked doc (the invoice) exposes paymentId as null, never undefined.
    const { items: invItems } = await listBillingDocuments(ORG, {
      seriesId: SERIES_IV, page: 1, pageSize: 25,
    });
    expect(invItems[0].paymentId).toBeNull();
  });

  it("legacy doc carries axes + status", async () => {
    const { items } = await listBillingDocuments(ORG, {
      seriesId: SERIES_RC, page: 1, pageSize: 25,
    });
    expect(items).toHaveLength(1);
    const legacy = items[0];
    expect(legacy.docType).toBe("receipt");
    // Legacy status still resolves.
    expect(legacy.status).toBe("offset");
    // Every axis field is DEFINED (never undefined) — the DB DEFAULTs applied.
    for (const axis of AXES) expect(legacy[axis]).not.toBeUndefined();
    expect(legacy.documentStatus).toBe("ISSUED");
    expect(legacy.taxStatus).toBe("NOT_REQUIRED");
    expect(legacy.settlementStatus).toBe("UNPAID");

    // Detail path carries them too.
    const detail = await getBillingDocumentDetail(ORG, DOC_LEGACY);
    expect(detail!.status).toBe("offset");
    for (const axis of AXES) expect(detail![axis]).not.toBeUndefined();
  });
});
