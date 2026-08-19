/**
 * Integration tests for M3 multi-invoice payment — B1 repository layer.
 * Hits a real LOCAL Postgres. Skipped by default in `npx vitest run`.
 *
 * Run explicitly:
 *   RUN_INTEGRATION=1 DATABASE_URL="postgresql://..." \
 *     npx vitest run src/modules/payments/__tests__/payments.multipay.integration.test.ts
 *
 * Mirrors the M2/M6 integration harness: fixed-UUID seed + org-scoped
 * deleteMany cleanup, localhost-only safety gate, RUN_INTEGRATION skip guard.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import {
  AlreadyAllocatedError,
  PartyMismatchError,
  allocatePaymentBatchTx,
  postPaymentTx,
  voidPaymentTx,
  reverseAllocationTx,
  listPayments,
} from "../payments.repository";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

// Hard safety: never run against a remote DB.
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

// Fixed UUIDs — disjoint from every other integration test's constants (prefix a3).
// NOTE: must be valid hex (0-9a-f); the earlier "m3*" scheme used non-hex letters
// (m/p/v/r/l/u) that Postgres rejected as malformed uuids in cleanup/seed.
const ORG = "a3000000-0000-4000-8000-000000000001";
const USER = "a3000000-0000-4000-8000-000000000002";
const PARTY = "a3000000-0000-4000-8000-000000000003";
const OTHER_PARTY = "a3000000-0000-4000-8000-000000000004";
const PAYMENT = "a3000000-0000-4000-8000-000000000010";
const CHARGE_1 = "a3000000-0000-4000-8000-000000000011";
const CHARGE_2 = "a3000000-0000-4000-8000-000000000012";

async function cleanup() {
  const db = getDb();
  await db.paymentAllocationReversal.deleteMany({ where: { organizationId: ORG } });
  await db.paymentAllocation.deleteMany({ where: { organizationId: ORG } });
  await db.payment.deleteMany({ where: { organizationId: ORG } });
  await db.charge.deleteMany({ where: { organizationId: ORG } });
  await db.auditLog.deleteMany({ where: { organizationId: ORG } });
  await db.user.deleteMany({ where: { organizationId: ORG } });
  await db.party.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function seed() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG,
      name: "M3 Integration Test Org",
      slug: "a3-int-test",
      status: "active",
      defaultCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur",
      locale: "en-MY",
      subscriptionPlan: "free",
    },
  });
  // Party that is the payer.
  await db.party.create({
    data: {
      id: PARTY,
      organizationId: ORG,
      displayName: "M3 Tenant Payer",
      partyType: "individual",
      status: "active",
    },
  });
  // A second party — used to test cross-party rejection.
  await db.party.create({
    data: {
      id: OTHER_PARTY,
      organizationId: ORG,
      displayName: "M3 Other Party",
      partyType: "individual",
      status: "active",
    },
  });
  // AuditLog.actorUserId FK → User (onDelete: Restrict) — the acting user must exist.
  await db.user.create({
    data: {
      id: USER,
      organizationId: ORG,
      email: "m3-int@example.test",
      fullName: "M3 Operator",
      status: "active",
      role: "manager",
      userType: "operator",
    },
  });
}

/** Seed a fresh POSTED payment (idempotencyKey null) with the given amount. */
async function seedPayment(amount: string) {
  const db = getDb();
  await db.payment.upsert({
    where: { id: PAYMENT },
    create: {
      id: PAYMENT,
      organizationId: ORG,
      paymentNumber: "PAY-M3-001",
      partyId: PARTY,
      paymentType: "payment",
      paymentMethod: "bank_transfer",
      status: "posted",
      amount,
      currency: "MYR",
      receivedAt: new Date("2026-06-01T00:00:00.000Z"),
      idempotencyKey: null,
    },
    update: {
      amount,
      status: "posted",
      idempotencyKey: null,
    },
  });
}

/** Seed a Charge row belonging to PARTY (unless overridden) with the given amounts. */
async function seedCharge(id: string, amount: string, outstanding: string, partyId: string = PARTY) {
  const db = getDb();
  await db.charge.upsert({
    where: { id },
    create: {
      id,
      organizationId: ORG,
      chargeNumber: `CHG-${id.slice(-4)}`,
      partyId,
      chargeType: "rent",
      status: "posted",
      dueDate: new Date("2026-06-30T00:00:00.000Z"),
      amount,
      currency: "MYR",
      outstandingAmount: outstanding,
    },
    update: {
      amount,
      outstandingAmount: outstanding,
      status: "posted",
      partyId,
    },
  });
}

dn("allocatePaymentBatchTx (integration)", () => {
  beforeEach(async () => {
    await cleanup();
    await seed();
  });

  // ── case (a): happy path — both charges decremented, statuses updated ────────
  it("(a) applies allocations: both charges decremented; status paid / partially_paid", async () => {
    await seedPayment("1000.00");
    await seedCharge(CHARGE_1, "600.00", "600.00"); // will be fully paid
    await seedCharge(CHARGE_2, "800.00", "800.00"); // will be partially paid (400 remains)

    const result = await allocatePaymentBatchTx({
      organizationId: ORG,
      paymentId: PAYMENT,
      payerPartyId: PARTY,
      paymentAmount: 1000,
      idempotencyKey: "idem-m3-happy-001",
      actorUserId: USER,
      actorRole: "manager",
      allocations: [
        { chargeId: CHARGE_1, allocatedAmount: 600, prorateRatio: null },
        { chargeId: CHARGE_2, allocatedAmount: 400, prorateRatio: null },
      ],
    });

    expect(result.replayed).toBe(false);
    expect(result.allocations).toHaveLength(2);

    const db = getDb();
    const c1 = await db.charge.findUniqueOrThrow({ where: { id: CHARGE_1 } });
    expect(Number(c1.outstandingAmount)).toBe(0);
    expect(c1.status).toBe("paid");

    const c2 = await db.charge.findUniqueOrThrow({ where: { id: CHARGE_2 } });
    expect(Number(c2.outstandingAmount)).toBe(400);
    expect(c2.status).toBe("partially_paid");

    // Audit row written inside the tx.
    const audit = await db.auditLog.findFirst({
      where: { organizationId: ORG, action: "payment.allocation.batch_create", entityId: PAYMENT },
    });
    expect(audit).not.toBeNull();
  });

  // ── case (b): Σ(allocations) > payment.amount → ALLOC_EXCEEDS_PAYMENT ───────
  it("(b) Σ(allocations) > payment.amount → throws ALLOC_EXCEEDS_PAYMENT", async () => {
    await seedPayment("500.00");
    await seedCharge(CHARGE_1, "400.00", "400.00");
    await seedCharge(CHARGE_2, "400.00", "400.00");

    await expect(
      allocatePaymentBatchTx({
        organizationId: ORG,
        paymentId: PAYMENT,
        payerPartyId: PARTY,
        paymentAmount: 500,
        idempotencyKey: "idem-m3-exceed-payment",
        actorUserId: USER,
        actorRole: "manager",
        allocations: [
          { chargeId: CHARGE_1, allocatedAmount: 400, prorateRatio: null },
          { chargeId: CHARGE_2, allocatedAmount: 200, prorateRatio: null }, // 600 > 500
        ],
      }),
    ).rejects.toThrow("ALLOC_EXCEEDS_PAYMENT");

    // Tx rolled back — no allocation rows, no charge changes.
    const db = getDb();
    expect(await db.paymentAllocation.count({ where: { organizationId: ORG } })).toBe(0);
    const c1 = await db.charge.findUniqueOrThrow({ where: { id: CHARGE_1 } });
    expect(Number(c1.outstandingAmount)).toBe(400);
  });

  // ── case (c): charge.partyId ≠ payment.partyId → PartyMismatchError ─────────
  it("(c) charge belongs to a different party → throws PartyMismatchError", async () => {
    await seedPayment("800.00");
    await seedCharge(CHARGE_1, "400.00", "400.00");                    // PARTY (correct)
    await seedCharge(CHARGE_2, "400.00", "400.00", OTHER_PARTY);      // OTHER_PARTY (wrong)

    await expect(
      allocatePaymentBatchTx({
        organizationId: ORG,
        paymentId: PAYMENT,
        payerPartyId: PARTY,
        paymentAmount: 800,
        idempotencyKey: "idem-m3-party-mismatch",
        actorUserId: USER,
        actorRole: "manager",
        allocations: [
          { chargeId: CHARGE_1, allocatedAmount: 400, prorateRatio: null },
          { chargeId: CHARGE_2, allocatedAmount: 400, prorateRatio: null },
        ],
      }),
    ).rejects.toThrow(PartyMismatchError);

    // Tx rolled back — no allocation rows, charges untouched.
    const db = getDb();
    expect(await db.paymentAllocation.count({ where: { organizationId: ORG } })).toBe(0);
    const c1 = await db.charge.findUniqueOrThrow({ where: { id: CHARGE_1 } });
    expect(Number(c1.outstandingAmount)).toBe(400); // not decremented
  });

  // ── case (d): idempotent re-claim → replayed:true, NO double-decrement ───────
  it("(d) same idempotencyKey called twice → second returns replayed:true; charges NOT double-decremented", async () => {
    await seedPayment("600.00");
    await seedCharge(CHARGE_1, "600.00", "600.00");

    const params = {
      organizationId: ORG,
      paymentId: PAYMENT,
      payerPartyId: PARTY,
      paymentAmount: 600,
      idempotencyKey: "idem-m3-replay-001",
      actorUserId: USER,
      actorRole: "manager",
      allocations: [{ chargeId: CHARGE_1, allocatedAmount: 600, prorateRatio: null }],
    };

    const first = await allocatePaymentBatchTx(params);
    expect(first.replayed).toBe(false);

    const second = await allocatePaymentBatchTx(params);
    expect(second.replayed).toBe(true);
    // The second call must return an empty allocations array (nothing new written).
    expect(second.allocations).toHaveLength(0);

    // Charge decremented exactly ONCE.
    const db = getDb();
    const c1 = await db.charge.findUniqueOrThrow({ where: { id: CHARGE_1 } });
    expect(Number(c1.outstandingAmount)).toBe(0);
    expect(c1.status).toBe("paid");

    // Only one PaymentAllocation row created.
    expect(await db.paymentAllocation.count({ where: { organizationId: ORG } })).toBe(1);
  });

  // ── case (e): allocation > charge.outstanding → ALLOC_EXCEEDS_OUTSTANDING ───
  it("(e) allocation exceeds charge outstanding → throws ALLOC_EXCEEDS_OUTSTANDING", async () => {
    await seedPayment("1000.00");
    await seedCharge(CHARGE_1, "600.00", "300.00"); // outstanding only 300

    await expect(
      allocatePaymentBatchTx({
        organizationId: ORG,
        paymentId: PAYMENT,
        payerPartyId: PARTY,
        paymentAmount: 1000,
        idempotencyKey: "idem-m3-exceed-outstanding",
        actorUserId: USER,
        actorRole: "manager",
        allocations: [
          { chargeId: CHARGE_1, allocatedAmount: 400, prorateRatio: null }, // 400 > 300
        ],
      }),
    ).rejects.toThrow(`ALLOC_EXCEEDS_OUTSTANDING:${CHARGE_1}`);

    // Tx rolled back — no allocation rows, charge untouched.
    const db = getDb();
    expect(await db.paymentAllocation.count({ where: { organizationId: ORG } })).toBe(0);
    const c1 = await db.charge.findUniqueOrThrow({ where: { id: CHARGE_1 } });
    expect(Number(c1.outstandingAmount)).toBe(300);
  });

  // ── case (f): already-allocated payment (different key) → AlreadyAllocatedError
  it("(f) payment already claims a different idempotencyKey → throws AlreadyAllocatedError", async () => {
    await seedPayment("600.00");
    await seedCharge(CHARGE_1, "600.00", "600.00");

    // Claim it first with one key.
    await allocatePaymentBatchTx({
      organizationId: ORG,
      paymentId: PAYMENT,
      payerPartyId: PARTY,
      paymentAmount: 600,
      idempotencyKey: "idem-m3-first",
      actorUserId: USER,
      actorRole: "manager",
      allocations: [{ chargeId: CHARGE_1, allocatedAmount: 600, prorateRatio: null }],
    });

    // Attempt to re-allocate with a DIFFERENT key.
    await expect(
      allocatePaymentBatchTx({
        organizationId: ORG,
        paymentId: PAYMENT,
        payerPartyId: PARTY,
        paymentAmount: 600,
        idempotencyKey: "idem-m3-second-different",
        actorUserId: USER,
        actorRole: "manager",
        allocations: [{ chargeId: CHARGE_1, allocatedAmount: 600, prorateRatio: null }],
      }),
    ).rejects.toThrow(AlreadyAllocatedError);
  });
});

// ── postPaymentTx integration cases (B3) — RUN_INTEGRATION-gated ─────────────

// Additional fixed UUIDs for postPaymentTx tests (prefix a3b to avoid collision).
const POST_PAYMENT = "a3b00000-0000-4000-8000-000000000010";
const POST_CHARGE_1 = "a3b00000-0000-4000-8000-000000000011";
const POST_CHARGE_2 = "a3b00000-0000-4000-8000-000000000012";
const POST_PAYMENT_BAD = "a3b00000-0000-4000-8000-000000000020";
const POST_CHARGE_X = "a3b00000-0000-4000-8000-000000000021";
const POST_PAYMENT_EXCEED = "a3b00000-0000-4000-8000-000000000030";
const POST_CHARGE_Y = "a3b00000-0000-4000-8000-000000000031";

/** Seed a payment with status pending_approval (idempotencyKey = given key). */
async function seedPendingPayment(id: string, amount: string, idempotencyKey: string | null = null) {
  const db = getDb();
  await db.payment.upsert({
    where: { id },
    create: {
      id,
      organizationId: ORG,
      paymentNumber: `PAY-POST-${id.slice(-4)}`,
      partyId: PARTY,
      paymentType: "payment",
      paymentMethod: "bank_transfer",
      status: "pending_approval",
      amount,
      currency: "MYR",
      receivedAt: new Date("2026-06-01T00:00:00.000Z"),
      idempotencyKey,
    },
    update: {
      amount,
      status: "pending_approval",
      idempotencyKey,
    },
  });
}

/** Seed a PaymentAllocation row (pre-existing, not yet applied to charge). */
async function seedAllocation(paymentId: string, chargeId: string, amount: string) {
  const db = getDb();
  await db.paymentAllocation.create({
    data: {
      organizationId: ORG,
      paymentId,
      chargeId,
      allocatedAmount: amount,
      allocatedAt: new Date(),
    },
  });
}

dn("postPaymentTx (integration)", () => {
  beforeEach(async () => {
    // Full org-scoped reset (incl. org/party/user) so seed() can recreate them
    // without a duplicate-key collision left behind by the previous describe block.
    await cleanup();
    await seed();
  });

  // ── case (a): pending_approval payment with 2 allocations → charges decremented + payment posted ──
  it("(a) applies 2 allocations, decrements charges, flips payment to posted, writes audit", async () => {
    await seedPendingPayment(POST_PAYMENT, "1020.00");
    await seedCharge(POST_CHARGE_1, "900.00", "900.00"); // will be fully paid
    await seedCharge(POST_CHARGE_2, "120.00", "120.00"); // will be fully paid
    await seedAllocation(POST_PAYMENT, POST_CHARGE_1, "900.00");
    await seedAllocation(POST_PAYMENT, POST_CHARGE_2, "120.00");

    const result = await postPaymentTx({
      organizationId: ORG,
      paymentId: POST_PAYMENT,
      actorUserId: USER,
      actorRole: "manager",
    });

    expect(result).toMatchObject({ ok: true });

    const db = getDb();
    const c1 = await db.charge.findUniqueOrThrow({ where: { id: POST_CHARGE_1 } });
    expect(Number(c1.outstandingAmount)).toBe(0);
    expect(c1.status).toBe("paid");

    const c2 = await db.charge.findUniqueOrThrow({ where: { id: POST_CHARGE_2 } });
    expect(Number(c2.outstandingAmount)).toBe(0);
    expect(c2.status).toBe("paid");

    const payment = await db.payment.findUniqueOrThrow({ where: { id: POST_PAYMENT } });
    expect(payment.status).toBe("posted");

    const audit = await db.auditLog.findFirst({
      where: { organizationId: ORG, action: "payment.posted", entityId: POST_PAYMENT },
    });
    expect(audit).not.toBeNull();
  });

  // ── case (b): non-pending_approval payment → {badStatus} ─────────────────────
  it("(b) payment with status 'posted' → returns badStatus", async () => {
    // Seed as posted (not pending_approval) directly.
    const db = getDb();
    await db.payment.create({
      data: {
        id: POST_PAYMENT_BAD,
        organizationId: ORG,
        paymentNumber: "PAY-POST-BAD",
        partyId: PARTY,
        paymentType: "payment",
        paymentMethod: "bank_transfer",
        status: "posted",
        amount: "500.00",
        currency: "MYR",
        receivedAt: new Date("2026-06-01T00:00:00.000Z"),
      },
    });

    const result = await postPaymentTx({
      organizationId: ORG,
      paymentId: POST_PAYMENT_BAD,
      actorUserId: USER,
      actorRole: "manager",
    });

    expect(result).toMatchObject({ badStatus: true, status: "posted" });

    // Charges untouched (none seeded for this payment).
    expect(await db.paymentAllocation.count({ where: { organizationId: ORG } })).toBe(0);
  });

  // ── case (c): Σ(allocations) > payment.amount → throws ALLOC_EXCEEDS_PAYMENT ─
  it("(c) allocations summing > payment.amount → throws ALLOC_EXCEEDS_PAYMENT; charges untouched", async () => {
    await seedPendingPayment(POST_PAYMENT_EXCEED, "500.00");
    await seedCharge(POST_CHARGE_Y, "800.00", "800.00");
    // Seed one allocation whose amount exceeds the payment amount.
    await seedAllocation(POST_PAYMENT_EXCEED, POST_CHARGE_Y, "600.00"); // 600 > 500

    await expect(
      postPaymentTx({
        organizationId: ORG,
        paymentId: POST_PAYMENT_EXCEED,
        actorUserId: USER,
        actorRole: "manager",
      }),
    ).rejects.toThrow("ALLOC_EXCEEDS_PAYMENT");

    // Tx rolled back — charge not decremented.
    const db = getDb();
    const charge = await db.charge.findUniqueOrThrow({ where: { id: POST_CHARGE_Y } });
    expect(Number(charge.outstandingAmount)).toBe(800);
    expect(charge.status).toBe("posted");

    // Payment status unchanged.
    const payment = await db.payment.findUniqueOrThrow({ where: { id: POST_PAYMENT_EXCEED } });
    expect(payment.status).toBe("pending_approval");
  });
});

// ── voidPaymentTx integration cases (B4) — RUN_INTEGRATION-gated ─────────────

// Additional fixed UUIDs for voidPaymentTx tests (prefix a3c to avoid collision).
const VOID_PAYMENT = "a3c00000-0000-4000-8000-000000000010";
const VOID_CHARGE_1 = "a3c00000-0000-4000-8000-000000000011";
const VOID_CHARGE_2 = "a3c00000-0000-4000-8000-000000000012";
const VOID_PAYMENT_PENDING = "a3c00000-0000-4000-8000-000000000020";
const VOID_CHARGE_PENDING = "a3c00000-0000-4000-8000-000000000021";
const VOID_PAYMENT_REFUND = "a3c00000-0000-4000-8000-000000000030";
const VOID_CHARGE_REFUND = "a3c00000-0000-4000-8000-000000000031";

/** Seed a posted payment with the given amount and no idempotencyKey. */
async function seedPostedPayment(id: string, amount: string) {
  const db = getDb();
  await db.payment.upsert({
    where: { id },
    create: {
      id,
      organizationId: ORG,
      paymentNumber: `PAY-VOID-${id.slice(-4)}`,
      partyId: PARTY,
      paymentType: "payment",
      paymentMethod: "bank_transfer",
      status: "posted",
      amount,
      currency: "MYR",
      receivedAt: new Date("2026-06-01T00:00:00.000Z"),
      idempotencyKey: null,
    },
    update: { amount, status: "posted", idempotencyKey: null },
  });
}

/** Seed a pending_approval payment with the given amount. */
async function seedPendingApprovalPayment(id: string, amount: string) {
  const db = getDb();
  await db.payment.upsert({
    where: { id },
    create: {
      id,
      organizationId: ORG,
      paymentNumber: `PAY-PEND-${id.slice(-4)}`,
      partyId: PARTY,
      paymentType: "payment",
      paymentMethod: "bank_transfer",
      status: "pending_approval",
      amount,
      currency: "MYR",
      receivedAt: new Date("2026-06-01T00:00:00.000Z"),
      idempotencyKey: null,
    },
    update: { amount, status: "pending_approval", idempotencyKey: null },
  });
}

/** Seed a charge with the given amount and outstandingAmount. */
async function seedVoidCharge(id: string, amount: string, outstanding: string) {
  const db = getDb();
  await db.charge.upsert({
    where: { id },
    create: {
      id,
      organizationId: ORG,
      chargeNumber: `CHG-V-${id.slice(-4)}`,
      partyId: PARTY,
      chargeType: "rent",
      status: "posted",
      dueDate: new Date("2026-06-30T00:00:00.000Z"),
      amount,
      currency: "MYR",
      outstandingAmount: outstanding,
    },
    update: { amount, outstandingAmount: outstanding, status: "posted" },
  });
}

/** Seed an allocation row (NOT applied to the charge — just the row). */
async function seedVoidAllocation(paymentId: string, chargeId: string, amount: string) {
  const db = getDb();
  await db.paymentAllocation.create({
    data: {
      organizationId: ORG,
      paymentId,
      chargeId,
      allocatedAmount: amount,
      allocatedAt: new Date(),
    },
  });
}

dn("voidPaymentTx (integration)", () => {
  beforeEach(async () => {
    // Full org-scoped reset (incl. org/party/user) so seed() can recreate them
    // without a duplicate-key collision left behind by the previous describe block.
    await cleanup();
    await seed();
  });

  // ── case (a): posted payment with 2 applied allocations → charges restored ──
  it("(a) posted payment with 2 allocations → voidPaymentTx restores both charges + payment.status=void + audit", async () => {
    await seedPostedPayment(VOID_PAYMENT, "1020.00");
    // Charges already have outstanding=0 (payment was applied — their outstanding was decremented).
    await seedVoidCharge(VOID_CHARGE_1, "900.00", "0.00");
    await seedVoidCharge(VOID_CHARGE_2, "120.00", "0.00");
    await seedVoidAllocation(VOID_PAYMENT, VOID_CHARGE_1, "900.00");
    await seedVoidAllocation(VOID_PAYMENT, VOID_CHARGE_2, "120.00");

    const result = await voidPaymentTx({
      organizationId: ORG,
      paymentId: VOID_PAYMENT,
      status: "void",
      referenceNote: "[status:void at 2026-06-18T00:00:00.000Z] duplicate",
      actorUserId: USER,
      actorRole: "admin",
    });

    expect(result).toMatchObject({ ok: true });

    const db = getDb();
    // Both charges should have outstanding restored to their full amounts.
    const c1 = await db.charge.findUniqueOrThrow({ where: { id: VOID_CHARGE_1 } });
    expect(Number(c1.outstandingAmount)).toBe(900);
    expect(c1.status).toBe("posted");

    const c2 = await db.charge.findUniqueOrThrow({ where: { id: VOID_CHARGE_2 } });
    expect(Number(c2.outstandingAmount)).toBe(120);
    expect(c2.status).toBe("posted");

    // Payment flipped to void.
    const payment = await db.payment.findUniqueOrThrow({ where: { id: VOID_PAYMENT } });
    expect(payment.status).toBe("void");

    // Audit row written inside the tx.
    const audit = await db.auditLog.findFirst({
      where: { organizationId: ORG, action: "payment.voided", entityId: VOID_PAYMENT },
    });
    expect(audit).not.toBeNull();
  });

  // ── case (b): pending_approval payment → void marks payment void, charges UNTOUCHED ─
  it("(b) pending_approval payment with pending allocations → void marks payment void, charges untouched", async () => {
    await seedPendingApprovalPayment(VOID_PAYMENT_PENDING, "900.00");
    // Charge is still at full outstanding (payment was never applied/posted).
    await seedVoidCharge(VOID_CHARGE_PENDING, "900.00", "900.00");
    await seedVoidAllocation(VOID_PAYMENT_PENDING, VOID_CHARGE_PENDING, "900.00");

    const result = await voidPaymentTx({
      organizationId: ORG,
      paymentId: VOID_PAYMENT_PENDING,
      status: "void",
      referenceNote: null,
      actorUserId: USER,
      actorRole: "admin",
    });

    expect(result).toMatchObject({ ok: true });

    const db = getDb();
    // Charge outstanding should remain untouched (payment was never applied).
    const charge = await db.charge.findUniqueOrThrow({ where: { id: VOID_CHARGE_PENDING } });
    expect(Number(charge.outstandingAmount)).toBe(900);
    expect(charge.status).toBe("posted");

    // Payment flipped to void.
    const payment = await db.payment.findUniqueOrThrow({ where: { id: VOID_PAYMENT_PENDING } });
    expect(payment.status).toBe("void");
  });

  // ── case (c): posted payment → "refunded" reverses charges + audit action "payment.refunded" ─
  it("(c) posted payment → 'refunded' reverses allocations + audit action payment.refunded", async () => {
    await seedPostedPayment(VOID_PAYMENT_REFUND, "900.00");
    // Charge already with outstanding=0 (payment applied).
    await seedVoidCharge(VOID_CHARGE_REFUND, "900.00", "0.00");
    await seedVoidAllocation(VOID_PAYMENT_REFUND, VOID_CHARGE_REFUND, "900.00");

    const result = await voidPaymentTx({
      organizationId: ORG,
      paymentId: VOID_PAYMENT_REFUND,
      status: "refunded",
      referenceNote: "[status:refunded at 2026-06-18T00:00:00.000Z] bank reversal",
      actorUserId: USER,
      actorRole: "admin",
    });

    expect(result).toMatchObject({ ok: true });

    const db = getDb();
    // Charge outstanding restored.
    const charge = await db.charge.findUniqueOrThrow({ where: { id: VOID_CHARGE_REFUND } });
    expect(Number(charge.outstandingAmount)).toBe(900);
    expect(charge.status).toBe("posted");

    // Payment flipped to refunded.
    const payment = await db.payment.findUniqueOrThrow({ where: { id: VOID_PAYMENT_REFUND } });
    expect(payment.status).toBe("refunded");

    // Audit row with correct action.
    const audit = await db.auditLog.findFirst({
      where: { organizationId: ORG, action: "payment.refunded", entityId: VOID_PAYMENT_REFUND },
    });
    expect(audit).not.toBeNull();
  });
});

// ── reverseAllocationTx integration cases (B5) — RUN_INTEGRATION-gated ───────

// Fixed UUIDs for reverseAllocationTx tests (prefix a3d to avoid collision).
const REV_PAYMENT = "a3d00000-0000-4000-8000-000000000010";
const REV_CHARGE_1 = "a3d00000-0000-4000-8000-000000000011";
const REV_CHARGE_2 = "a3d00000-0000-4000-8000-000000000012";

dn("reverseAllocationTx (integration)", () => {
  beforeEach(async () => {
    // Full org-scoped reset (incl. org/party/user) so seed() can recreate them
    // without a duplicate-key collision left behind by the previous describe block.
    await cleanup();
    await seed();
  });

  // ── case (a): POSTED payment with 2 applied allocations → reverse ONE → only that charge restored ─
  it("(a) posted payment: reverse one allocation restores only that charge; sibling charge untouched", async () => {
    const db = getDb();
    // Seed posted payment.
    await db.payment.create({
      data: {
        id: REV_PAYMENT,
        organizationId: ORG,
        paymentNumber: "PAY-REV-001",
        partyId: PARTY,
        paymentType: "payment",
        paymentMethod: "bank_transfer",
        status: "posted",
        amount: "1020.00",
        currency: "MYR",
        receivedAt: new Date("2026-06-01T00:00:00.000Z"),
        idempotencyKey: null,
      },
    });
    // Charges already have outstanding=0 (payment was applied).
    await db.charge.create({
      data: {
        id: REV_CHARGE_1,
        organizationId: ORG,
        chargeNumber: "CHG-R-0011",
        partyId: PARTY,
        chargeType: "rent",
        status: "paid",
        dueDate: new Date("2026-06-30T00:00:00.000Z"),
        amount: "900.00",
        currency: "MYR",
        outstandingAmount: "0.00",
      },
    });
    await db.charge.create({
      data: {
        id: REV_CHARGE_2,
        organizationId: ORG,
        chargeNumber: "CHG-R-0012",
        partyId: PARTY,
        chargeType: "carpark",
        status: "paid",
        dueDate: new Date("2026-06-30T00:00:00.000Z"),
        amount: "120.00",
        currency: "MYR",
        outstandingAmount: "0.00",
      },
    });
    // Seed two allocation rows.
    const alloc1 = await db.paymentAllocation.create({
      data: {
        organizationId: ORG,
        paymentId: REV_PAYMENT,
        chargeId: REV_CHARGE_1,
        allocatedAmount: "900.00",
        allocatedAt: new Date("2026-06-01T00:00:00.000Z"),
      },
      select: { id: true },
    });
    await db.paymentAllocation.create({
      data: {
        organizationId: ORG,
        paymentId: REV_PAYMENT,
        chargeId: REV_CHARGE_2,
        allocatedAmount: "120.00",
        allocatedAt: new Date("2026-06-01T00:00:01.000Z"),
      },
    });

    // Reverse only the first allocation (REV_CHARGE_1).
    const result = await reverseAllocationTx({
      organizationId: ORG,
      paymentId: REV_PAYMENT,
      allocationId: alloc1.id,
      reason: "(unspecified)",
      idempotencyKey: "a3000000-0000-4000-8000-0000000000f1",
      amount: null,
      actorUserId: USER,
      actorRole: "editor",
    });

    expect(result).toMatchObject({ ok: true });

    // REV_CHARGE_1 should have outstanding restored to 900.
    const c1 = await db.charge.findUniqueOrThrow({ where: { id: REV_CHARGE_1 } });
    expect(Number(c1.outstandingAmount)).toBe(900);
    expect(c1.status).toBe("posted"); // chargeStatusForOutstanding(900, 900) = "posted"

    // REV_CHARGE_2 must be UNTOUCHED (still 0 outstanding, still "paid").
    const c2 = await db.charge.findUniqueOrThrow({ where: { id: REV_CHARGE_2 } });
    expect(Number(c2.outstandingAmount)).toBe(0);
    expect(c2.status).toBe("paid");

    // Allocation row is RETAINED (not deleted).
    const allocs = await db.paymentAllocation.count({ where: { organizationId: ORG } });
    expect(allocs).toBe(2);

    // Audit row written inside the tx with correct entityType and entityId.
    const audit = await db.auditLog.findFirst({
      where: { organizationId: ORG, action: "payment.allocation.reverse", entityId: alloc1.id },
    });
    expect(audit).not.toBeNull();
    expect(audit?.entityType).toBe("PaymentAllocation");
  });

  // ── case (b): allocationId not belonging to the payment → {notFound} ─────────
  it("(b) allocationId not belonging to the payment → returns {notFound}", async () => {
    const db = getDb();
    // Seed a payment with no allocations.
    await db.payment.create({
      data: {
        id: REV_PAYMENT,
        organizationId: ORG,
        paymentNumber: "PAY-REV-002",
        partyId: PARTY,
        paymentType: "payment",
        paymentMethod: "bank_transfer",
        status: "posted",
        amount: "900.00",
        currency: "MYR",
        receivedAt: new Date("2026-06-01T00:00:00.000Z"),
        idempotencyKey: null,
      },
    });

    const result = await reverseAllocationTx({
      organizationId: ORG,
      paymentId: REV_PAYMENT,
      allocationId: "ffffffff-ffff-4fff-8fff-ffffffffffff", // does not exist
      reason: "(unspecified)",
      idempotencyKey: "a3000000-0000-4000-8000-0000000000f2",
      amount: null,
      actorUserId: USER,
      actorRole: "editor",
    });

    expect(result).toMatchObject({ notFound: true });

    // No audit row written.
    const audit = await db.auditLog.findFirst({
      where: { organizationId: ORG, action: "payment.allocation.reverse" },
    });
    expect(audit).toBeNull();
  });
});

// ── listPayments filters + keyset pagination (B6) — RUN_INTEGRATION-gated ────

// Fixed UUIDs for listPayments pagination tests (prefix a3e to avoid collision).
const LIST_ORG = "a3e00000-0000-4000-8000-000000000001";
const LIST_USER = "a3e00000-0000-4000-8000-000000000002";
const LIST_PARTY = "a3e00000-0000-4000-8000-000000000003";

async function cleanupList() {
  const db = getDb();
  await db.paymentAllocation.deleteMany({ where: { organizationId: LIST_ORG } });
  await db.payment.deleteMany({ where: { organizationId: LIST_ORG } });
  await db.auditLog.deleteMany({ where: { organizationId: LIST_ORG } });
  await db.user.deleteMany({ where: { organizationId: LIST_ORG } });
  await db.party.deleteMany({ where: { organizationId: LIST_ORG } });
  await db.organization.deleteMany({ where: { id: LIST_ORG } });
}

async function seedListOrg() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: LIST_ORG,
      name: "M3 List Integration Org",
      slug: "a3-list-int",
      status: "active",
      defaultCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur",
      locale: "en-MY",
      subscriptionPlan: "free",
    },
  });
  await db.party.create({
    data: {
      id: LIST_PARTY,
      organizationId: LIST_ORG,
      displayName: "M3 List Party",
      partyType: "individual",
      status: "active",
    },
  });
  await db.user.create({
    data: {
      id: LIST_USER,
      organizationId: LIST_ORG,
      email: "m3-list@example.test",
      fullName: "M3 List Op",
      status: "active",
      role: "manager",
      userType: "operator",
    },
  });
}

async function seedListPayment(id: string, paymentNumber: string, status: string, receivedAt: Date) {
  const db = getDb();
  await db.payment.create({
    data: {
      id,
      organizationId: LIST_ORG,
      paymentNumber,
      partyId: LIST_PARTY,
      paymentType: "payment",
      paymentMethod: "bank_transfer",
      status,
      amount: "100.00",
      currency: "MYR",
      receivedAt,
      idempotencyKey: null,
    },
  });
}

// Use "a3e" prefix IDs for these payments.
const L_P1 = "a3e00001-0000-4000-8000-000000000010"; // posted, 2026-06-01
const L_P2 = "a3e00001-0000-4000-8000-000000000011"; // posted, 2026-06-02
const L_P3 = "a3e00001-0000-4000-8000-000000000012"; // posted, 2026-06-03
const L_P4 = "a3e00001-0000-4000-8000-000000000013"; // void,   2026-06-04

dn("listPayments filters + keyset pagination (B6, integration)", () => {
  beforeEach(async () => {
    await cleanupList();
    await seedListOrg();
    // Seed 4 payments: 3 posted (oldest→newest) + 1 void.
    // orderBy: [receivedAt desc, id desc] → L_P3, L_P2, L_P1, L_P4 when no filter.
    await seedListPayment(L_P1, "PAY-LIST-001", "posted", new Date("2026-06-01T00:00:00.000Z"));
    await seedListPayment(L_P2, "PAY-LIST-002", "posted", new Date("2026-06-02T00:00:00.000Z"));
    await seedListPayment(L_P3, "PAY-LIST-003", "posted", new Date("2026-06-03T00:00:00.000Z"));
    await seedListPayment(L_P4, "PAY-LIST-004", "void",   new Date("2026-06-04T00:00:00.000Z"));
  });

  it("status=posted, limit=2 → 2 rows, all posted, nextCursor truthy", async () => {
    const result = await listPayments(LIST_ORG, { status: "posted", limit: 2 });
    expect(result.data).toHaveLength(2);
    expect(result.data.every((r) => r.status === "posted")).toBe(true);
    expect(result.nextCursor).toBeTruthy();
  });

  it("cursor from first page → remaining posted rows (no duplication/missing)", async () => {
    const page1 = await listPayments(LIST_ORG, { status: "posted", limit: 2 });
    expect(page1.data).toHaveLength(2);
    expect(page1.nextCursor).toBeTruthy();

    const page2 = await listPayments(LIST_ORG, { status: "posted", limit: 2, cursor: page1.nextCursor! });
    expect(page2.data).toHaveLength(1); // only 3 posted total; 2 on page1 → 1 on page2
    expect(page2.data[0].status).toBe("posted");
    expect(page2.nextCursor).toBeNull();

    // No IDs duplicated across pages.
    const allIds = [...page1.data.map((r) => r.id), ...page2.data.map((r) => r.id)];
    expect(new Set(allIds).size).toBe(allIds.length);

    // Total of 3 (all posted rows).
    expect(allIds).toHaveLength(3);
  });

  it("no filter → returns all 4 payments, nextCursor null (limit default 50)", async () => {
    const result = await listPayments(LIST_ORG);
    expect(result.data).toHaveLength(4);
    expect(result.nextCursor).toBeNull();
  });

  it("status=void → only the void payment returned", async () => {
    const result = await listPayments(LIST_ORG, { status: "void" });
    expect(result.data).toHaveLength(1);
    expect(result.data[0].status).toBe("void");
  });
});

// ── listPayments hasUnallocated (B6 review-fix) — RUN_INTEGRATION-gated ───────
//
// Verifies that hasUnallocated=true returns ALL matching rows with nextCursor=null
// (keyset pagination is disabled when hasUnallocated is set — see repository comment).

// Fixed UUIDs for hasUnallocated tests (prefix a3f to avoid collision).
const UNALLOC_ORG = "a3f00000-0000-4000-8000-000000000001";
const UNALLOC_PARTY = "a3f00000-0000-4000-8000-000000000002";
const UNALLOC_USER = "a3f00000-0000-4000-8000-000000000003";
const UNALLOC_CHARGE_A = "a3f00000-0000-4000-8000-000000000011";
const UNALLOC_CHARGE_B = "a3f00000-0000-4000-8000-000000000012";

// Three payments: P_UA and P_UB are unallocated (amount > Σ allocations); P_UC is fully allocated.
const UNALLOC_P_UA = "a3f00001-0000-4000-8000-000000000010"; // unallocated: 500, 0 allocations
const UNALLOC_P_UB = "a3f00001-0000-4000-8000-000000000011"; // unallocated: 300, partial allocation 100
const UNALLOC_P_UC = "a3f00001-0000-4000-8000-000000000012"; // fully allocated: 200, allocation 200

async function cleanupUnalloc() {
  const db = getDb();
  await db.paymentAllocation.deleteMany({ where: { organizationId: UNALLOC_ORG } });
  await db.payment.deleteMany({ where: { organizationId: UNALLOC_ORG } });
  await db.charge.deleteMany({ where: { organizationId: UNALLOC_ORG } });
  await db.auditLog.deleteMany({ where: { organizationId: UNALLOC_ORG } });
  await db.user.deleteMany({ where: { organizationId: UNALLOC_ORG } });
  await db.party.deleteMany({ where: { organizationId: UNALLOC_ORG } });
  await db.organization.deleteMany({ where: { id: UNALLOC_ORG } });
}

async function seedUnallocOrg() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: UNALLOC_ORG,
      name: "M3 Unalloc Integration Org",
      slug: "a3-unalloc-int",
      status: "active",
      defaultCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur",
      locale: "en-MY",
      subscriptionPlan: "free",
    },
  });
  await db.party.create({
    data: {
      id: UNALLOC_PARTY,
      organizationId: UNALLOC_ORG,
      displayName: "M3 Unalloc Party",
      partyType: "individual",
      status: "active",
    },
  });
  await db.user.create({
    data: {
      id: UNALLOC_USER,
      organizationId: UNALLOC_ORG,
      email: "m3-unalloc@example.test",
      fullName: "M3 Unalloc Op",
      status: "active",
      role: "manager",
      userType: "operator",
    },
  });
  // Seed a charge for the partial allocation on P_UB and full allocation on P_UC.
  await db.charge.create({
    data: {
      id: UNALLOC_CHARGE_A,
      organizationId: UNALLOC_ORG,
      chargeNumber: "CHG-UA-001",
      partyId: UNALLOC_PARTY,
      chargeType: "rent",
      status: "partially_paid",
      dueDate: new Date("2026-06-30T00:00:00.000Z"),
      amount: "300.00",
      currency: "MYR",
      outstandingAmount: "200.00",
    },
  });
  await db.charge.create({
    data: {
      id: UNALLOC_CHARGE_B,
      organizationId: UNALLOC_ORG,
      chargeNumber: "CHG-UA-002",
      partyId: UNALLOC_PARTY,
      chargeType: "rent",
      status: "paid",
      dueDate: new Date("2026-06-30T00:00:00.000Z"),
      amount: "200.00",
      currency: "MYR",
      outstandingAmount: "0.00",
    },
  });
  // P_UA: amount=500, no allocations → unallocated.
  await db.payment.create({
    data: {
      id: UNALLOC_P_UA,
      organizationId: UNALLOC_ORG,
      paymentNumber: "PAY-UA-001",
      partyId: UNALLOC_PARTY,
      paymentType: "payment",
      paymentMethod: "bank_transfer",
      status: "posted",
      amount: "500.00",
      currency: "MYR",
      receivedAt: new Date("2026-06-01T00:00:00.000Z"),
      idempotencyKey: null,
    },
  });
  // P_UB: amount=300, one allocation of 100 → still unallocated (300 > 100).
  await db.payment.create({
    data: {
      id: UNALLOC_P_UB,
      organizationId: UNALLOC_ORG,
      paymentNumber: "PAY-UA-002",
      partyId: UNALLOC_PARTY,
      paymentType: "payment",
      paymentMethod: "bank_transfer",
      status: "posted",
      amount: "300.00",
      currency: "MYR",
      receivedAt: new Date("2026-06-02T00:00:00.000Z"),
      idempotencyKey: null,
    },
  });
  await db.paymentAllocation.create({
    data: {
      organizationId: UNALLOC_ORG,
      paymentId: UNALLOC_P_UB,
      chargeId: UNALLOC_CHARGE_A,
      allocatedAmount: "100.00",
      allocatedAt: new Date("2026-06-02T01:00:00.000Z"),
    },
  });
  // P_UC: amount=200, one allocation of 200 → fully allocated (200 <= 200).
  await db.payment.create({
    data: {
      id: UNALLOC_P_UC,
      organizationId: UNALLOC_ORG,
      paymentNumber: "PAY-UA-003",
      partyId: UNALLOC_PARTY,
      paymentType: "payment",
      paymentMethod: "bank_transfer",
      status: "posted",
      amount: "200.00",
      currency: "MYR",
      receivedAt: new Date("2026-06-03T00:00:00.000Z"),
      idempotencyKey: null,
    },
  });
  await db.paymentAllocation.create({
    data: {
      organizationId: UNALLOC_ORG,
      paymentId: UNALLOC_P_UC,
      chargeId: UNALLOC_CHARGE_B,
      allocatedAmount: "200.00",
      allocatedAt: new Date("2026-06-03T01:00:00.000Z"),
    },
  });
}

dn("listPayments hasUnallocated=true (B6 review-fix, integration)", () => {
  beforeEach(async () => {
    await cleanupUnalloc();
    await seedUnallocOrg();
  });

  it("hasUnallocated=true → returns exactly the 2 unallocated payments, nextCursor=null", async () => {
    // 3 payments seeded: P_UA (no allocations), P_UB (partial), P_UC (fully allocated).
    // hasUnallocated=true should return only P_UA and P_UB.
    const result = await listPayments(UNALLOC_ORG, { hasUnallocated: true });

    expect(result.nextCursor).toBeNull(); // keyset pagination disabled for hasUnallocated
    expect(result.data).toHaveLength(2);

    const ids = result.data.map((r) => r.id).sort();
    expect(ids).toEqual([UNALLOC_P_UA, UNALLOC_P_UB].sort());

    // Each returned row must genuinely be unallocated (amount > Σ allocations).
    for (const row of result.data) {
      const allocatedSum = row.allocations.reduce((s: number, a: { allocatedAmount: number }) => s + a.allocatedAmount, 0);
      expect(row.amount).toBeGreaterThan(allocatedSum);
    }
  });

  it("hasUnallocated=false → returns only the fully allocated payment, nextCursor=null", async () => {
    const result = await listPayments(UNALLOC_ORG, { hasUnallocated: false });

    expect(result.nextCursor).toBeNull();
    expect(result.data).toHaveLength(1);
    expect(result.data[0].id).toBe(UNALLOC_P_UC);
  });
});
