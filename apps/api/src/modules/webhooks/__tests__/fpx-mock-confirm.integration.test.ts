/**
 * Task 4 (sub-project A / FPX) — integration tests for the MOCK-ONLY confirm
 * endpoint. Real LOCAL postgres. Drives the actual mounted route end-to-end:
 * POST /webhooks/fpx/mock-confirm {providerTxnId, outcome} → the route signs
 * server-side via the mock gateway's buildSignedCallback → handleFpxCallbackService
 * settles, exactly as a real signed bank callback would. This is what the mock
 * FPX SPA page (Task 6) POSTs to.
 *
 * Run:
 *   RUN_INTEGRATION=1 ENABLE_PHASE2_FPX=1 ENABLE_PHASE2_MULTI_PAY=1 \
 *     DATABASE_URL="postgresql://yonghongtan@localhost:5432/kason_hub_dev" \
 *     npx vitest run src/modules/webhooks/__tests__/fpx-mock-confirm.integration
 */
import { beforeEach, afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { getDb } from "@kason/db";
import { resetFpxGateway } from "../../../lib/fpx";
import { initiateFpxPaymentService } from "../../portal/payments/fpx-initiate.service";
import { mountFpxWebhook } from "../fpx.routes";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

// Stable UUIDs for this suite (fd = FPX mock-confirm; disjoint from fc/fa).
const ORG = "fd000000-0000-4000-8000-000000000001";
const TENANT_PARTY = "fd000000-0000-4000-8000-000000000002";
const OWNER_PARTY = "fd000000-0000-4000-8000-000000000003";
const ADMIN_USER = "fd000000-0000-4000-8000-000000000004";
const OWNER_USER = "fd000000-0000-4000-8000-000000000005";
const TENANT_USER = "fd000000-0000-4000-8000-000000000006";
const PROP = "fd000000-0000-4000-8000-000000000050";
const APT = "fd000000-0000-4000-8000-000000000051";
const UNIT = "fd000000-0000-4000-8000-000000000052";
const CHARGE = "fd000000-0000-4000-8000-000000000020";

const DUE_DATE = new Date("2026-06-30T00:00:00.000Z");
const BILLING_MONTH = new Date("2026-06-01T00:00:00.000Z");

const session = { partyId: TENANT_PARTY, orgId: ORG, userId: TENANT_USER };

async function cleanup() {
  const db = getDb();
  await db.ownerLedgerEntry.deleteMany({ where: { organizationId: ORG } });
  await db.paymentAllocation.deleteMany({ where: { organizationId: ORG } });
  await db.payment.deleteMany({ where: { organizationId: ORG } });
  await db.notification.deleteMany({ where: { organizationId: ORG } });
  await db.auditLog.deleteMany({ where: { organizationId: ORG } });
  await db.charge.deleteMany({ where: { organizationId: ORG } });
  await db.listing.deleteMany({ where: { organizationId: ORG } });
  await db.apartment.deleteMany({ where: { organizationId: ORG } });
  await db.property.deleteMany({ where: { organizationId: ORG } });
  await db.user.deleteMany({ where: { organizationId: ORG } });
  await db.party.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function seed() {
  const db = getDb();
  await db.organization.create({
    data: { id: ORG, name: "FD-Org", slug: "fd-org", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" },
  });
  await db.party.createMany({
    data: [
      { id: TENANT_PARTY, organizationId: ORG, partyType: "individual", displayName: "FD Tenant", status: "active" },
      { id: OWNER_PARTY, organizationId: ORG, partyType: "individual", displayName: "FD Owner", status: "active" },
    ],
  });
  await db.user.create({ data: { id: ADMIN_USER, organizationId: ORG, email: "fd-admin@example.test", fullName: "FD Admin", status: "active", role: "admin", userType: "operator" } });
  await db.user.create({ data: { id: OWNER_USER, organizationId: ORG, email: "fd-owner@example.test", fullName: "FD Owner", status: "active", role: "owner", userType: "owner", partyId: OWNER_PARTY } });
  await db.user.create({ data: { id: TENANT_USER, organizationId: ORG, email: "fd-tenant@example.test", fullName: "FD Tenant", status: "active", role: "tenant", userType: "tenant", partyId: TENANT_PARTY } });
  await db.property.create({ data: { id: PROP, organizationId: ORG, name: "FD-P1", propertyCode: "FD-P1", propertyType: "residential", addressLine1: "1", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
  await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "FD-A1", listingMode: "PARTITIONED" } });
  await db.listing.create({ data: { id: UNIT, organizationId: ORG, apartmentId: APT, listingType: "room", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER_PARTY } });
  await db.charge.create({
    data: { id: CHARGE, organizationId: ORG, partyId: TENANT_PARTY, unitId: UNIT, chargeNumber: "CHG-FD-0001", chargeType: "rent", status: "posted", amount: 900, outstandingAmount: 900, currency: "MYR", dueDate: DUE_DATE, billingMonth: BILLING_MONTH },
  });
}

/** Initiate the FPX payment for the rent charge → returns its providerTxnId + id. */
async function initiate(idempotencyKey: string): Promise<{ providerTxnId: string; paymentId: string }> {
  const r = await initiateFpxPaymentService(session, {
    idempotencyKey,
    allocations: [{ chargeId: CHARGE, allocatedAmount: "900.00" }],
  });
  if (!r.ok) throw new Error(`initiate failed: ${r.status}`);
  return { providerTxnId: r.data!.providerTxnId, paymentId: r.data!.paymentId };
}

/** POST to the real mounted mock-confirm route. */
async function mockConfirm(providerTxnId: string, outcome: "success" | "failure"): Promise<Response> {
  const app = new Hono();
  mountFpxWebhook(app, { prisma: getDb() });
  return app.request("/webhooks/fpx/mock-confirm", {
    method: "POST",
    body: JSON.stringify({ providerTxnId, outcome }),
    headers: { "content-type": "application/json" },
  });
}

dn("POST /webhooks/fpx/mock-confirm (integration)", () => {
  beforeAll(() => {
    process.env.FPX_PROVIDER = "mock";
    process.env.ENABLE_PHASE2_FPX = "1";
    process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
    resetFpxGateway();
  });
  afterAll(() => {
    delete process.env.FPX_PROVIDER;
    delete process.env.ENABLE_PHASE2_FPX;
    delete process.env.ENABLE_PHASE2_OWNER_BILLING;
    resetFpxGateway();
  });
  beforeEach(async () => {
    await cleanup();
    await seed();
  });
  afterEach(async () => {
    await cleanup();
  });

  it("(a) outcome=success → settles exactly like a signed callback: charge paid, payment posted+success, owner-ledger collected", async () => {
    const db = getDb();
    const { providerTxnId, paymentId } = await initiate("fd111111-1111-4111-8111-111111111111");

    const res = await mockConfirm(providerTxnId, "success");
    expect(res.status).toBe(200);

    const charge = await db.charge.findUniqueOrThrow({ where: { id: CHARGE } });
    expect(Number(charge.outstandingAmount)).toBe(0);
    expect(charge.status).toBe("paid");

    const payment = await db.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(payment.status).toBe("posted");
    expect(payment.gatewayStatus).toBe("success");

    const entries = await db.ownerLedgerEntry.findMany({ where: { organizationId: ORG, ownerPartyId: OWNER_PARTY, sourceType: "rent", sourceChargeId: CHARGE } });
    expect(entries).toHaveLength(1);
    expect(Number(entries[0].amount)).toBe(900);
  });

  it("(b) outcome=failure → marks payment failed; charges UNTOUCHED", async () => {
    const db = getDb();
    const { providerTxnId, paymentId } = await initiate("fd222222-2222-4222-8222-222222222222");

    const res = await mockConfirm(providerTxnId, "failure");
    expect(res.status).toBe(200);

    const charge = await db.charge.findUniqueOrThrow({ where: { id: CHARGE } });
    expect(Number(charge.outstandingAmount)).toBe(900);
    expect(charge.status).toBe("posted");

    const payment = await db.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(payment.status).toBe("failed");
    expect(payment.gatewayStatus).toBe("failed");
  });
});
