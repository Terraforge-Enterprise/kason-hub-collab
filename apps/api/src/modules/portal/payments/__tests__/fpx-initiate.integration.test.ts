/**
 * Task 2 (sub-project A / FPX) — integration tests for initiateFpxPaymentService.
 *
 * Skipped by default — run against a LOCAL postgres only:
 *   RUN_INTEGRATION=1 ENABLE_PHASE2_FPX=1 ENABLE_PHASE2_MULTI_PAY=1 \
 *     npx vitest run src/modules/portal/payments/__tests__/fpx-initiate.integration
 *
 * Verifies, against a real DB, that initiating an FPX payment:
 *   - creates ONE pending_approval Payment (provider "fpx-mock", gatewayStatus
 *     "pending", paymentMethod "fpx", externalReference == providerTxnId) + N
 *     PaymentAllocations, and leaves every charge's outstandingAmount UNTOUCHED
 *     (the callback in Task 3 settles — never the initiate);
 *   - writes a `payment.fpx_initiated` audit row and NO admin notification;
 *   - rejects a cross-tenant charge (404) and an over-outstanding amount (400)
 *     without creating any Payment;
 *   - is idempotent: replaying the same idempotencyKey returns the SAME
 *     providerTxnId and never creates a 2nd Payment.
 */
import { beforeEach, afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { resetFpxGateway } from "../../../../lib/fpx";
import { initiateFpxPaymentService } from "../fpx-initiate.service";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing non-local DB host: ${host}`);
  }
}

// Stable UUIDs for this suite (fa = FPX sub-project A).
const ORG = "fa000000-0000-4000-8000-000000000001";
const PARTY_TENANT = "fa000000-0000-4000-8000-000000000002";
const PARTY_OTHER = "fa000000-0000-4000-8000-000000000003";
const USER_ID = "fa000000-0000-4000-8000-000000000099";
const PROP = "fa000000-0000-4000-8000-000000000050";
const APT = "fa000000-0000-4000-8000-000000000051";
const LISTING = "fa000000-0000-4000-8000-000000000052";
const CHARGE_ROOM = "fa000000-0000-4000-8000-000000000020"; // outstanding 900
const CHARGE_CARPARK = "fa000000-0000-4000-8000-000000000021"; // outstanding 120
const CHARGE_OTHER = "fa000000-0000-4000-8000-000000000022"; // other party

const session = { partyId: PARTY_TENANT, orgId: ORG, userId: USER_ID };

async function cleanup() {
  const db = getDb();
  // FK-safe order: allocations → payments → audit/notifications → charges →
  // (defensive) utility bills → listings → apartments → property → users → parties → org.
  await db.paymentAllocation.deleteMany({ where: { organizationId: ORG } });
  await db.payment.deleteMany({ where: { organizationId: ORG } });
  await db.auditLog.deleteMany({ where: { organizationId: ORG } });
  await db.notification.deleteMany({ where: { organizationId: ORG } });
  await db.charge.deleteMany({ where: { organizationId: ORG } });
  await db.unitUtilityBill.deleteMany({ where: { organizationId: ORG } });
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
    data: {
      id: ORG, name: "FA-Org", slug: "fa-org", status: "active",
      defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free",
    },
  });
  await db.user.create({
    data: {
      id: USER_ID, organizationId: ORG, email: "fa@example.test",
      fullName: "FA Operator", status: "active", role: "manager", userType: "operator",
    },
  });
  await db.party.createMany({
    data: [
      { id: PARTY_TENANT, organizationId: ORG, partyType: "individual", displayName: "FA Tenant", status: "active" },
      { id: PARTY_OTHER, organizationId: ORG, partyType: "individual", displayName: "FA Other", status: "active" },
    ],
  });
  await db.property.create({
    data: {
      id: PROP, organizationId: ORG, name: "FA-P1", propertyCode: "FA-P1",
      propertyType: "residential", addressLine1: "1", city: "KL", country: "MY",
      status: "active", publishStatus: "draft",
    },
  });
  await db.apartment.create({
    data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "FA-A1", listingMode: "PARTITIONED" },
  });
  await db.listing.create({
    data: {
      id: LISTING, organizationId: ORG, apartmentId: APT, listingType: "room",
      occupancyStatus: "occupied", listingStatus: "active", currency: "MYR",
    },
  });
  await db.charge.createMany({
    data: [
      { id: CHARGE_ROOM, organizationId: ORG, partyId: PARTY_TENANT, chargeNumber: "CHG-FA-0001", chargeType: "rent", amount: 900, outstandingAmount: 900, status: "posted", currency: "MYR", dueDate: new Date("2026-07-01") },
      { id: CHARGE_CARPARK, organizationId: ORG, partyId: PARTY_TENANT, chargeNumber: "CHG-FA-0002", chargeType: "carpark", amount: 120, outstandingAmount: 120, status: "posted", currency: "MYR", dueDate: new Date("2026-07-01") },
      { id: CHARGE_OTHER, organizationId: ORG, partyId: PARTY_OTHER, chargeNumber: "CHG-FA-0003", chargeType: "rent", amount: 900, outstandingAmount: 900, status: "posted", currency: "MYR", dueDate: new Date("2026-07-01") },
    ],
  });
}

dn("initiateFpxPaymentService integration", () => {
  beforeAll(() => {
    // Deterministic gateway: force the in-process mock regardless of ambient env.
    process.env.FPX_PROVIDER = "mock";
    resetFpxGateway();
  });
  afterAll(() => {
    delete process.env.FPX_PROVIDER;
    resetFpxGateway();
  });
  beforeEach(async () => {
    await cleanup();
    await seed();
  });
  afterEach(async () => {
    await cleanup();
  });

  it("(a) valid 2-charge basket → ONE pending_approval fpx Payment + 2 allocations; charges' outstanding UNCHANGED; audit written, NO notification", async () => {
    const db = getDb();
    const r = await initiateFpxPaymentService(session, {
      idempotencyKey: "fa111111-1111-4111-8111-111111111111",
      allocations: [
        { chargeId: CHARGE_ROOM, allocatedAmount: "900.00" },
        { chargeId: CHARGE_CARPARK, allocatedAmount: "120.00" },
      ],
    });

    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    expect(r.data).toBeDefined();
    const data = r.data!;
    expect(data.redirectUrl).toContain("/portal/fpx/mock");
    expect(data.redirectUrl).toContain(data.providerTxnId);
    expect(data.providerTxnId).toBeTruthy();
    expect(data.paymentId).toBeTruthy();

    // Exactly one Payment, in the FPX shape.
    const payments = await db.payment.findMany({ where: { organizationId: ORG } });
    expect(payments).toHaveLength(1);
    const p = payments[0];
    expect(p.id).toBe(data.paymentId);
    expect(p.status).toBe("pending_approval");
    expect(p.paymentMethod).toBe("fpx");
    expect(p.provider).toBe("fpx-mock");
    expect(p.gatewayStatus).toBe("pending");
    expect(p.paymentType).toBe("incoming");
    expect(p.providerTxnId).toBe(data.providerTxnId);
    expect(p.externalReference).toBe(data.providerTxnId);
    expect(p.idempotencyKey).toBe("fa111111-1111-4111-8111-111111111111");
    expect(Number(p.amount)).toBe(1020);

    // Two allocations.
    const allocs = await db.paymentAllocation.findMany({ where: { paymentId: data.paymentId } });
    expect(allocs).toHaveLength(2);

    // Charges UNTOUCHED — settlement happens in the Task 3 callback, not here.
    const room = await db.charge.findUnique({ where: { id: CHARGE_ROOM } });
    const carpark = await db.charge.findUnique({ where: { id: CHARGE_CARPARK } });
    expect(Number(room!.outstandingAmount)).toBe(900);
    expect(Number(carpark!.outstandingAmount)).toBe(120);
    expect(room!.status).toBe("posted");
    expect(carpark!.status).toBe("posted");

    // Audit row written; NO admin notification (the gateway settles, not an admin).
    const audits = await db.auditLog.findMany({ where: { organizationId: ORG, action: "payment.fpx_initiated" } });
    expect(audits).toHaveLength(1);
    expect(audits[0].entityId).toBe(data.paymentId);
    const notes = await db.notification.findMany({ where: { organizationId: ORG } });
    expect(notes).toHaveLength(0);
  });

  it("(b) cross-tenant chargeId → 404, no Payment created", async () => {
    const db = getDb();
    const r = await initiateFpxPaymentService(session, {
      idempotencyKey: "fa222222-2222-4222-8222-222222222222",
      allocations: [{ chargeId: CHARGE_OTHER, allocatedAmount: "900.00" }],
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(404);
    const payments = await db.payment.findMany({ where: { organizationId: ORG } });
    expect(payments).toHaveLength(0);
  });

  it("(c) amount > outstanding → 400, no Payment created", async () => {
    const db = getDb();
    const r = await initiateFpxPaymentService(session, {
      idempotencyKey: "fa333333-3333-4333-8333-333333333333",
      allocations: [{ chargeId: CHARGE_ROOM, allocatedAmount: "999.00" }],
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    const payments = await db.payment.findMany({ where: { organizationId: ORG } });
    expect(payments).toHaveLength(0);
  });

  it("(d) replay same idempotencyKey → same providerTxnId, still exactly ONE Payment; outstanding still unchanged", async () => {
    const db = getDb();
    const key = "fa444444-4444-4444-8444-444444444444";
    const input = {
      idempotencyKey: key,
      allocations: [{ chargeId: CHARGE_ROOM, allocatedAmount: "900.00" }],
    };

    const first = await initiateFpxPaymentService(session, input);
    const second = await initiateFpxPaymentService(session, input);

    expect(first.ok && second.ok).toBe(true);
    expect(second.data!.providerTxnId).toBe(first.data!.providerTxnId);
    expect(second.data!.paymentId).toBe(first.data!.paymentId);

    const payments = await db.payment.findMany({ where: { organizationId: ORG, idempotencyKey: key } });
    expect(payments).toHaveLength(1);

    const room = await db.charge.findUnique({ where: { id: CHARGE_ROOM } });
    expect(Number(room!.outstandingAmount)).toBe(900);
  });

  // ── Item 2: lazy expiry of abandoned in-flight FPX on re-initiate ────────────

  // Seed a bare in-flight FPX payment (no allocations needed for the GC) with an
  // explicit createdAt so we can age it deterministically.
  async function seedStaleFpx(id: string, ageMinutes: number, idempotencyKey: string) {
    const db = getDb();
    await db.payment.create({
      data: {
        id,
        organizationId: ORG,
        paymentNumber: `PAY-STALE-${id.slice(-4)}`,
        partyId: PARTY_TENANT,
        paymentType: "incoming",
        paymentMethod: "fpx",
        provider: "fpx-mock",
        providerTxnId: `txn-${id.slice(-8)}`,
        gatewayStatus: "pending",
        status: "pending_approval",
        amount: "900.00",
        currency: "MYR",
        receivedAt: new Date(),
        idempotencyKey,
        createdAt: new Date(Date.now() - ageMinutes * 60_000),
      },
    });
  }

  it("(e) a 31-min-old in-flight FPX payment is NOT written off on the tenant's next initiate", async () => {
    // This used to blind-expire any in-flight row older than 30 minutes, which is
    // the one thing an FPX integration must never do: on FPX-B2B a transaction
    // answers "pending" first and is resolved later by a human approver at the
    // bank — hours later is normal, and there is no published maximum. Marking it
    // expired writes off money the payer may well have already been debited for,
    // and it then can't be settled by the real callback when it lands.
    //
    // Initiate now fires an opportunistic REQUERY instead (18dfa1a1): ask the
    // gateway what actually happened, and only a checksum-verified terminal
    // answer moves the row. The mock gateway reports nothing terminal here, so
    // the correct outcome is that the stale row is left exactly as it was.
    const db = getDb();
    const STALE = "fa000000-0000-4000-8000-000000000031";
    await seedStaleFpx(STALE, 31, "fa999999-9999-4999-8999-999999999931");

    const r = await initiateFpxPaymentService(session, {
      idempotencyKey: "fa555555-5555-4555-8555-555555555555",
      allocations: [{ chargeId: CHARGE_ROOM, allocatedAmount: "900.00" }],
    });
    expect(r.ok).toBe(true);

    const stale = await db.payment.findUnique({ where: { id: STALE } });
    expect(stale!.status).toBe("pending_approval");
    expect(stale!.gatewayStatus).toBe("pending");

    // The freshly-created payment is untouched (pending).
    const fresh = await db.payment.findUnique({ where: { id: r.data!.paymentId } });
    expect(fresh!.status).toBe("pending_approval");
    expect(fresh!.gatewayStatus).toBe("pending");

    // Charges never touched by the GC.
    const room = await db.charge.findUnique({ where: { id: CHARGE_ROOM } });
    expect(Number(room!.outstandingAmount)).toBe(900);
  });

  it("(f) a 5-min-old in-flight FPX payment is LEFT ALONE on the next initiate", async () => {
    const db = getDb();
    const FRESH = "fa000000-0000-4000-8000-000000000032";
    await seedStaleFpx(FRESH, 5, "fa999999-9999-4999-8999-999999999932");

    await initiateFpxPaymentService(session, {
      idempotencyKey: "fa666666-6666-4666-8666-666666666666",
      allocations: [{ chargeId: CHARGE_ROOM, allocatedAmount: "900.00" }],
    });

    const stillPending = await db.payment.findUnique({ where: { id: FRESH } });
    expect(stillPending!.status).toBe("pending_approval");
    expect(stillPending!.gatewayStatus).toBe("pending");
  });

  it("(g) replaying the SAME idempotencyKey returns the existing payment and never expires it", async () => {
    const db = getDb();
    const key = "fa777777-7777-4777-8777-777777777777";
    const input = { idempotencyKey: key, allocations: [{ chargeId: CHARGE_ROOM, allocatedAmount: "900.00" }] };

    const first = await initiateFpxPaymentService(session, input);
    expect(first.ok).toBe(true);

    // Age the just-created payment past the 30-min threshold, then replay the SAME key.
    await db.payment.update({
      where: { id: first.data!.paymentId },
      data: { createdAt: new Date(Date.now() - 45 * 60_000) },
    });

    const replay = await initiateFpxPaymentService(session, input);
    expect(replay.ok).toBe(true);
    expect(replay.data!.paymentId).toBe(first.data!.paymentId);

    // Same-key replay takes the fast-path BEFORE the GC, AND the GC excludes this
    // key — so the row stays pending, never expired.
    const same = await db.payment.findUnique({ where: { id: first.data!.paymentId } });
    expect(same!.status).toBe("pending_approval");
    expect(same!.gatewayStatus).toBe("pending");
  });
});
