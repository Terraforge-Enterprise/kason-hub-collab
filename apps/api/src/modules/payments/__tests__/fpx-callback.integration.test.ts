/**
 * Task 3 (sub-project A / FPX) — integration tests for the callback settle.
 *
 * Real LOCAL postgres. Exercises the REAL two-step flow: Task 2
 * initiateFpxPaymentService creates the pending payment, then a signed gateway
 * callback (built with the mock's buildSignedCallback) drives
 * handleFpxCallbackService, which settles via postPaymentService.
 *
 * Run:
 *   RUN_INTEGRATION=1 ENABLE_PHASE2_FPX=1 ENABLE_PHASE2_MULTI_PAY=1 \
 *     DATABASE_URL="postgresql://yonghongtan@localhost:5432/kason_hub_dev" \
 *     npx vitest run src/modules/payments/__tests__/fpx-callback.integration
 *
 * Money invariants asserted:
 *   (a) success → charge outstanding→0 + status "paid"; payment "posted" +
 *       gatewayStatus "success"; an OwnerLedgerEntry reflects the collected rent.
 *   (b) double-fire success → settles EXACTLY once (outstanding stays 0, ONE
 *       owner-ledger rent row, payment still posted).
 *   (c) failed → charges UNTOUCHED; payment status+gatewayStatus "failed".
 *   (d) invalid signature → 400, NO state change.
 */
import { beforeEach, afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { getFpxGateway, resetFpxGateway } from "../../../lib/fpx";
import { initiateFpxPaymentService } from "../../portal/payments/fpx-initiate.service";
import { handleFpxCallbackService } from "../fpx-callback.service";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

// Stable UUIDs for this suite (fc = FPX callback).
const ORG = "fc000000-0000-4000-8000-000000000001";
const TENANT_PARTY = "fc000000-0000-4000-8000-000000000002";
const OWNER_PARTY = "fc000000-0000-4000-8000-000000000003";
const ADMIN_USER = "fc000000-0000-4000-8000-000000000004";
const OWNER_USER = "fc000000-0000-4000-8000-000000000005";
const TENANT_USER = "fc000000-0000-4000-8000-000000000006";
const PROP = "fc000000-0000-4000-8000-000000000050";
const APT = "fc000000-0000-4000-8000-000000000051";
const UNIT = "fc000000-0000-4000-8000-000000000052";
const CHARGE = "fc000000-0000-4000-8000-000000000020";

// Rent due + billing month in the SAME period so the sync-hook (keys off
// billingMonth) and syncMonthService (queries by dueDate window) agree.
const DUE_DATE = new Date("2026-06-30T00:00:00.000Z");
const BILLING_MONTH = new Date("2026-06-01T00:00:00.000Z");

// The tenant initiates against their own User id (matches the portal session).
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
    data: { id: ORG, name: "FC-Org", slug: "fc-org", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" },
  });
  await db.party.createMany({
    data: [
      { id: TENANT_PARTY, organizationId: ORG, partyType: "individual", displayName: "FC Tenant", status: "active" },
      { id: OWNER_PARTY, organizationId: ORG, partyType: "individual", displayName: "FC Owner", status: "active" },
    ],
  });
  // The org's primary admin — resolveSystemActorUserId attributes the gateway
  // settle to this real User (AuditLog.actorUserId FK → User).
  await db.user.create({ data: { id: ADMIN_USER, organizationId: ORG, email: "fc-admin@example.test", fullName: "FC Admin", status: "active", role: "admin", userType: "operator" } });
  // The owner's portal user (so owner notification has a recipient).
  await db.user.create({ data: { id: OWNER_USER, organizationId: ORG, email: "fc-owner@example.test", fullName: "FC Owner", status: "active", role: "owner", userType: "owner", partyId: OWNER_PARTY } });
  // The tenant's portal user (initiate stamps its audit with this id).
  await db.user.create({ data: { id: TENANT_USER, organizationId: ORG, email: "fc-tenant@example.test", fullName: "FC Tenant", status: "active", role: "tenant", userType: "tenant", partyId: TENANT_PARTY } });
  await db.property.create({ data: { id: PROP, organizationId: ORG, name: "FC-P1", propertyCode: "FC-P1", propertyType: "residential", addressLine1: "1", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
  await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "FC-A1", listingMode: "PARTITIONED" } });
  // Owned room — owner is per-unit via Listing.ownerPartyId.
  await db.listing.create({ data: { id: UNIT, organizationId: ORG, apartmentId: APT, listingType: "room", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER_PARTY } });
  // Rent charge on the owned unit, payable, due in the billing month.
  await db.charge.create({
    data: { id: CHARGE, organizationId: ORG, partyId: TENANT_PARTY, unitId: UNIT, chargeNumber: "CHG-FC-0001", chargeType: "rent", status: "posted", amount: 900, outstandingAmount: 900, currency: "MYR", dueDate: DUE_DATE, billingMonth: BILLING_MONTH },
  });
}

/** Initiate an FPX payment for the rent charge → returns its providerTxnId + id. */
async function initiate(idempotencyKey: string): Promise<{ providerTxnId: string; paymentId: string }> {
  const r = await initiateFpxPaymentService(session, {
    idempotencyKey,
    allocations: [{ chargeId: CHARGE, allocatedAmount: "900.00" }],
  });
  if (!r.ok) throw new Error(`initiate failed: ${r.status} ${("error" in r && r.error) || ""}`);
  return { providerTxnId: r.data!.providerTxnId, paymentId: r.data!.paymentId };
}

dn("handleFpxCallbackService integration", () => {
  beforeAll(() => {
    // Deterministic gateway (buildSignedCallback + verifyCallback share a secret).
    process.env.FPX_PROVIDER = "mock";
    // The owner-ledger sync hook is gated on this flag; the assertion (a)/(b)
    // OwnerLedgerEntry only materialises with it on.
    process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
    resetFpxGateway();
  });
  afterAll(() => {
    delete process.env.FPX_PROVIDER;
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

  it("(a) success callback settles: charge paid, payment posted+success, owner-ledger reflects collected rent", async () => {
    const db = getDb();
    const { providerTxnId, paymentId } = await initiate("fc111111-1111-4111-8111-111111111111");

    // Pre-condition: initiate left the charge untouched.
    expect(Number((await db.charge.findUniqueOrThrow({ where: { id: CHARGE } })).outstandingAmount)).toBe(900);

    const { rawBody, signature } = getFpxGateway().buildSignedCallback!(providerTxnId, "success");
    const res = await handleFpxCallbackService(rawBody, signature);
    // `applied` reports what the handler DID, so the browser-return route can
    // tell the payer "received" only when something actually was.
    expect(res).toEqual({ ok: true, status: 200, applied: "settled" });

    // Charge fully settled.
    const charge = await db.charge.findUniqueOrThrow({ where: { id: CHARGE } });
    expect(Number(charge.outstandingAmount)).toBe(0);
    expect(charge.status).toBe("paid");

    // Payment posted + gatewayStatus success.
    const payment = await db.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(payment.status).toBe("posted");
    expect(payment.gatewayStatus).toBe("success");

    // Owner-ledger: a rent income row for the owner reflects the collected charge.
    const entries = await db.ownerLedgerEntry.findMany({ where: { organizationId: ORG, ownerPartyId: OWNER_PARTY, sourceType: "rent", sourceChargeId: CHARGE } });
    expect(entries).toHaveLength(1);
    expect(entries[0].direction).toBe("income");
    expect(entries[0].category).toBe("rental_income");
    expect(Number(entries[0].amount)).toBe(900);
  });

  it("(b) double-fire success settles EXACTLY once: outstanding stays 0, ONE owner-ledger row, payment still posted", async () => {
    const db = getDb();
    const { providerTxnId, paymentId } = await initiate("fc222222-2222-4222-8222-222222222222");
    const { rawBody, signature } = getFpxGateway().buildSignedCallback!(providerTxnId, "success");

    const first = await handleFpxCallbackService(rawBody, signature);
    const second = await handleFpxCallbackService(rawBody, signature); // exact duplicate

    expect(first).toEqual({ ok: true, status: 200, applied: "settled" });
    // Idempotent no-op — and it reports `already_settled`, which is neither
    // "settled" nor nothing. The money IS applied, so the payer must not be told
    // "pending" on a redelivery (Fiuu's notify usually beats their browser back);
    // but this delivery did not apply it, so the requery sweep must not count it
    // as money that sweep recovered.
    expect(second).toEqual({ ok: true, status: 200, applied: "already_settled" });

    // Charge settled once (not driven negative or re-applied).
    const charge = await db.charge.findUniqueOrThrow({ where: { id: CHARGE } });
    expect(Number(charge.outstandingAmount)).toBe(0);
    expect(charge.status).toBe("paid");

    // Exactly ONE allocation applied, payment posted once.
    const payment = await db.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(payment.status).toBe("posted");
    const allocs = await db.paymentAllocation.findMany({ where: { paymentId } });
    expect(allocs).toHaveLength(1);

    // Exactly ONE owner-ledger rent row for the charge (idempotent sync, no double effect).
    const entries = await db.ownerLedgerEntry.findMany({ where: { organizationId: ORG, sourceType: "rent", sourceChargeId: CHARGE } });
    expect(entries).toHaveLength(1);
    expect(Number(entries[0].amount)).toBe(900);

    // Exactly ONE posted-audit row (the settle ran once).
    const posted = await db.auditLog.findMany({ where: { organizationId: ORG, action: "payment.posted", entityId: paymentId } });
    expect(posted).toHaveLength(1);
  });

  it("(c) failed callback: charges UNTOUCHED, payment status+gatewayStatus failed", async () => {
    const db = getDb();
    const { providerTxnId, paymentId } = await initiate("fc333333-3333-4333-8333-333333333333");
    const { rawBody, signature } = getFpxGateway().buildSignedCallback!(providerTxnId, "failed");

    const res = await handleFpxCallbackService(rawBody, signature);
    expect(res).toEqual({ ok: true, status: 200, applied: "failed" });

    // Charge untouched.
    const charge = await db.charge.findUniqueOrThrow({ where: { id: CHARGE } });
    expect(Number(charge.outstandingAmount)).toBe(900);
    expect(charge.status).toBe("posted");

    // Payment marked failed.
    const payment = await db.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(payment.status).toBe("failed");
    expect(payment.gatewayStatus).toBe("failed");

    // No owner-ledger row (nothing collected).
    expect(await db.ownerLedgerEntry.count({ where: { organizationId: ORG, sourceChargeId: CHARGE } })).toBe(0);
  });

  it("(d) invalid signature → 400, NO state change", async () => {
    const db = getDb();
    const { providerTxnId, paymentId } = await initiate("fc444444-4444-4444-8444-444444444444");
    const { rawBody } = getFpxGateway().buildSignedCallback!(providerTxnId, "success");

    // Tamper: a wrong signature must never move money.
    const res = await handleFpxCallbackService(rawBody, "deadbeef");
    expect(res).toEqual({ ok: false, status: 400 });

    // Everything unchanged: charge still owed, payment still pending.
    const charge = await db.charge.findUniqueOrThrow({ where: { id: CHARGE } });
    expect(Number(charge.outstandingAmount)).toBe(900);
    expect(charge.status).toBe("posted");
    const payment = await db.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(payment.status).toBe("pending_approval");
    expect(payment.gatewayStatus).toBe("pending");
    expect(await db.ownerLedgerEntry.count({ where: { organizationId: ORG } })).toBe(0);
  });
});
