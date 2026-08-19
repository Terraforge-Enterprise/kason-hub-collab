/**
 * Route→service correction wiring (R9, Task 11) — real LOCAL Postgres
 * (opt-in RUN_INTEGRATION=1).
 *
 * Proves the HTTP boundary no longer drops the correction fields: a POST to the
 * REAL /billing/charges/:id/void route (billingRoutes mounted, voidChargeService
 * UNMOCKED) reaches voidPostedChargeWithCreditNote with the supplied strategy and
 * issues the right document.
 *
 *  - { strategy: "CREDIT_ADJUSTMENT", reason } on a paid charge → 200 + a Credit
 *    Note number in the response body (NO 400 STRATEGY_REQUIRED).
 *  - { strategy: "DEBIT_ADJUSTMENT", adjustmentAmount, reason } → 200 + a Debit
 *    Note number, and the charge's outstanding rises by the adjustment.
 *
 * Run:
 *   cd apps/api
 *   export DATABASE_URL="…local…"
 *   RUN_INTEGRATION=1 ENABLE_PHASE2_BILLING_DOCS=1 \
 *     npx vitest run src/modules/billing/__tests__/void-route-correction.integration.test.ts
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { Hono } from "hono";
import { getDb } from "@kason/db";
import type { BillingSession } from "../billing.types";
import { billingRoutes } from "../billing.routes";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
  process.env.ENABLE_PHASE2_BILLING_DOCS = "1";
}

// Fixed disjoint UUIDs (prefix b9; unused by any other suite).
const ORG = "b9000000-0000-4000-8000-000000000001";
const USER = "b9000000-0000-4000-8000-000000000002";
const TENANT = "b9000000-0000-4000-8000-000000000003";
const CAT = "b9000000-0000-4000-8000-000000000004";
const SERIES_DEP = "b9000000-0000-4000-8000-000000000005";
const SERIES_CN = "b9000000-0000-4000-8000-000000000006";
const SERIES_DN = "b9000000-0000-4000-8000-000000000007";

const C_CREDIT = "b9000000-0000-4000-8000-000000000011";
const D_CREDIT = "b9000000-0000-4000-8000-000000000012";
const PAY_CREDIT = "b9000000-0000-4000-8000-000000000013";
const ALLOC_CREDIT = "b9000000-0000-4000-8000-000000000014";

const C_DEBIT = "b9000000-0000-4000-8000-000000000021";
const D_DEBIT = "b9000000-0000-4000-8000-000000000022";
const PAY_DEBIT = "b9000000-0000-4000-8000-000000000023";
const ALLOC_DEBIT = "b9000000-0000-4000-8000-000000000024";

const session: BillingSession = { userId: USER, orgId: ORG, role: "manager" };

// The real route is guarded by requireWorkspaceOrRank("accounting","manager") and
// reads c.get("session"); mount it behind a middleware that injects our session.
function makeApp() {
  const app = new Hono<{ Variables: { session: BillingSession } }>();
  app.use("*", async (c, next) => {
    c.set("session", session);
    await next();
  });
  app.route("/", billingRoutes);
  return app;
}

function postVoid(chargeId: string, body: unknown) {
  return makeApp().request(`/charges/${chargeId}/void`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
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
  await db.user.deleteMany({ where: { id: USER } });
  await db.party.deleteMany({ where: org });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function seed() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG, name: "Void Route Org", slug: `org-${ORG}`, status: "active",
      defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free",
    },
  });
  await db.user.create({
    data: {
      id: USER, organizationId: ORG, email: "void-route@test.local", passwordHash: "x",
      role: "manager", fullName: "Void Route Mgr", status: "active", userType: "operator",
    },
  });
  await db.party.create({
    data: { id: TENANT, organizationId: ORG, displayName: "Route Tenant", partyType: "individual", status: "active" },
  });
  await db.documentSeries.create({
    data: { id: SERIES_DEP, organizationId: ORG, code: "DEP", prefix: "DEP", padding: 4, includeYear: false, active: true },
  });
  await db.documentSeries.create({
    data: { id: SERIES_CN, organizationId: ORG, code: "CN", prefix: "CN", padding: 4, includeYear: false, active: true },
  });
  await db.documentSeries.create({
    data: { id: SERIES_DN, organizationId: ORG, code: "DN", prefix: "DN", padding: 4, includeYear: false, active: true },
  });
  await db.chargeCategory.create({
    data: {
      id: CAT, organizationId: ORG, code: "rental", name: "Monthly rental", family: "pay_back_landlord",
      docType: "debit_note", seriesId: SERIES_DEP, defaultSstRate: 0, eInvoiceEligible: false,
      ledgerCategory: "rental_income", isSystem: true, active: true, sortOrder: 1,
    },
  });
}

async function seedChargeWithPayment(opts: {
  chargeId: string; docId: string; documentNumber: string;
  paymentId: string; paymentNumber: string; allocId: string;
}) {
  const db = getDb();
  await db.charge.create({
    data: {
      id: opts.chargeId, organizationId: ORG, chargeNumber: `RT-${opts.chargeId.slice(-6)}`,
      partyId: TENANT, chargeType: "rental", categoryId: CAT, status: "partially_paid",
      postedAt: new Date(), description: "Rent June", dueDate: new Date("2026-06-30"),
      amount: "1000.00", currency: "MYR", outstandingAmount: "600.00", billingMonth: new Date("2026-06-01"),
    },
  });
  await db.billingDocument.create({
    data: {
      id: opts.docId, organizationId: ORG, docType: "debit_note", documentNumber: opts.documentNumber,
      seriesId: SERIES_DEP, status: "issued", issuedById: USER, counterpartyType: "tenant", partyId: TENANT,
      billingMonth: new Date("2026-06-01"), subtotal: "1000.00", sstAmount: 0, total: "1000.00",
      lines: { create: [{ chargeId: opts.chargeId, categoryId: CAT, description: "Rent June", amount: "1000.00", sstRate: 0, sstAmount: 0 }] },
    },
  });
  await db.payment.create({
    data: {
      id: opts.paymentId, organizationId: ORG, paymentNumber: opts.paymentNumber, partyId: TENANT,
      paymentType: "incoming", paymentMethod: "bank_transfer", status: "posted", amount: "400.00",
      currency: "MYR", receivedAt: new Date("2026-06-15T00:00:00.000Z"),
    },
  });
  await db.paymentAllocation.create({
    data: {
      id: opts.allocId, organizationId: ORG, paymentId: opts.paymentId, chargeId: opts.chargeId,
      allocatedAmount: "400.00", allocatedAt: new Date("2026-06-15T00:00:00.000Z"),
    },
  });
}

dn("POST /charges/:id/void — route forwards the correction strategy (integration)", () => {
  beforeEach(async () => {
    await cleanup();
    await seed();
  });
  afterAll(cleanup);

  it("CREDIT_ADJUSTMENT via the route → 200 + Credit Note issued (no STRATEGY_REQUIRED)", async () => {
    await seedChargeWithPayment({
      chargeId: C_CREDIT, docId: D_CREDIT, documentNumber: "DEP-9101",
      paymentId: PAY_CREDIT, paymentNumber: "PAY-RT-CR", allocId: ALLOC_CREDIT,
    });

    const res = await postVoid(C_CREDIT, { strategy: "CREDIT_ADJUSTMENT", reason: "correction via drawer" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { creditNoteNumber?: string | null; error?: string };
    // The route reached the service (no 400 STRATEGY_REQUIRED) and a CN was minted.
    expect(body.error).toBeUndefined();
    expect(body.creditNoteNumber).toMatch(/^CN-\d{4}$/);

    // A credit_note document referencing the original invoice exists in the DB.
    const db = getDb();
    const cn = await db.billingDocument.findFirstOrThrow({
      where: { organizationId: ORG, docType: "credit_note", originalDocumentId: D_CREDIT },
    });
    expect(cn.documentNumber).toBe(body.creditNoteNumber);
  });

  it("DEBIT_ADJUSTMENT via the route → 200 + Debit Note issued, outstanding rises by the adjustment", async () => {
    await seedChargeWithPayment({
      chargeId: C_DEBIT, docId: D_DEBIT, documentNumber: "DEP-9201",
      paymentId: PAY_DEBIT, paymentNumber: "PAY-RT-DR", allocId: ALLOC_DEBIT,
    });

    const res = await postVoid(C_DEBIT, {
      strategy: "DEBIT_ADJUSTMENT", adjustmentAmount: "50.00", reason: "under-billed, add RM50",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { debitNoteNumber?: string | null; error?: string };
    expect(body.error).toBeUndefined();
    expect(body.debitNoteNumber).toMatch(/^DN-\d{4}$/);

    const db = getDb();
    // The DN references the original invoice and totals RM50.
    const dnDoc = await db.billingDocument.findFirstOrThrow({
      where: { organizationId: ORG, docType: "debit_note", documentNumber: body.debitNoteNumber! },
    });
    expect(dnDoc.originalDocumentId).toBe(D_DEBIT);
    expect(Number(dnDoc.total.toString())).toBe(50);

    // Charge outstanding rose 600 → 650 (the adjustmentAmount survived the route).
    const charge = await db.charge.findUniqueOrThrow({ where: { id: C_DEBIT } });
    expect(Number(charge.outstandingAmount.toString())).toBe(650);
  });
});
