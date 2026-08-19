/**
 * Integration tests for Task 5 (R5) — the payment-void path writes append-only
 * PaymentAllocationReversal rows, one per reversed allocation, keyed by a
 * deterministic `voidpay:<paymentId>:<allocationId>` idempotency key so a
 * re-void never double-writes.
 *
 * Hits a real LOCAL Postgres. Skipped by default in `npx vitest run`.
 *
 * Run explicitly:
 *   RUN_INTEGRATION=1 ENABLE_PHASE2_MULTI_PAY=1 \
 *     npx vitest run src/modules/payments/__tests__/void-payment-appendonly.integration.test.ts
 *
 * Mirrors the M3 multipay integration harness: fixed-UUID seed + org-scoped
 * deleteMany cleanup, localhost-only safety gate, RUN_INTEGRATION skip guard.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { voidPaymentTx } from "../payments.repository";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

// Hard safety: never run against a remote DB.
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

// Fixed UUIDs — disjoint from every other integration test's constants (prefix b4).
const ORG = "b4000000-0000-4000-8000-000000000001";
const USER = "b4000000-0000-4000-8000-000000000002";
const PARTY = "b4000000-0000-4000-8000-000000000003";

// case (a)/(b): posted payment with two allocations.
const VOID_PAYMENT = "b4000000-0000-4000-8000-000000000010";
const VOID_CHARGE_1 = "b4000000-0000-4000-8000-000000000011";
const VOID_CHARGE_2 = "b4000000-0000-4000-8000-000000000012";
// case (c): pending (unposted) payment.
const PENDING_PAYMENT = "b4000000-0000-4000-8000-000000000020";
const PENDING_CHARGE = "b4000000-0000-4000-8000-000000000021";
// case (d): posted payment, one allocation partially reversed BEFORE the void.
const PARTIAL_PAYMENT = "b4000000-0000-4000-8000-000000000030";
const PARTIAL_CHARGE = "b4000000-0000-4000-8000-000000000031";

async function cleanup() {
  const db = getDb();
  // FK-safe order: reversal rows reference PaymentAllocation.id by value, delete first.
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
      name: "R5 Void-Reversal Integration Org",
      slug: "b4-int-test",
      status: "active",
      defaultCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur",
      locale: "en-MY",
      subscriptionPlan: "free",
    },
  });
  await db.party.create({
    data: {
      id: PARTY,
      organizationId: ORG,
      displayName: "R5 Tenant Payer",
      partyType: "individual",
      status: "active",
    },
  });
  // AuditLog.actorUserId FK → User (onDelete: Restrict) — the acting user must exist.
  await db.user.create({
    data: {
      id: USER,
      organizationId: ORG,
      email: "b4-int@example.test",
      fullName: "R5 Operator",
      status: "active",
      role: "manager",
      userType: "operator",
    },
  });
}

/** Seed a payment with the given status/amount and no idempotencyKey. */
async function seedPayment(id: string, amount: string, status: "posted" | "pending_approval") {
  const db = getDb();
  await db.payment.upsert({
    where: { id },
    create: {
      id,
      organizationId: ORG,
      paymentNumber: `PAY-B4-${id.slice(-4)}`,
      partyId: PARTY,
      paymentType: "payment",
      paymentMethod: "bank_transfer",
      status,
      amount,
      currency: "MYR",
      receivedAt: new Date("2026-06-01T00:00:00.000Z"),
      idempotencyKey: null,
    },
    update: { amount, status, idempotencyKey: null },
  });
}

/** Seed a charge with the given amount and outstandingAmount. */
async function seedCharge(id: string, amount: string, outstanding: string) {
  const db = getDb();
  await db.charge.upsert({
    where: { id },
    create: {
      id,
      organizationId: ORG,
      chargeNumber: `CHG-B4-${id.slice(-4)}`,
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

/** Seed an allocation row (just the row) and return its id. */
async function seedAllocation(paymentId: string, chargeId: string, amount: string): Promise<string> {
  const db = getDb();
  const row = await db.paymentAllocation.create({
    data: {
      organizationId: ORG,
      paymentId,
      chargeId,
      allocatedAmount: amount,
      allocatedAt: new Date("2026-06-01T00:00:00.000Z"),
    },
    select: { id: true },
  });
  return row.id;
}

dn("voidPaymentTx append-only reversal rows (R5, integration)", () => {
  beforeEach(async () => {
    await cleanup();
    await seed();
  });

  // ── case (a): posted payment + 2 allocations → 2 reversal rows + status void ──
  it("writes reversal rows: posted payment with 2 allocations → 2 PaymentAllocationReversal rows + Payment.status void", async () => {
    await seedPayment(VOID_PAYMENT, "1020.00", "posted");
    // Charges already applied (outstanding decremented to 0).
    await seedCharge(VOID_CHARGE_1, "900.00", "0.00");
    await seedCharge(VOID_CHARGE_2, "120.00", "0.00");
    const alloc1 = await seedAllocation(VOID_PAYMENT, VOID_CHARGE_1, "900.00");
    const alloc2 = await seedAllocation(VOID_PAYMENT, VOID_CHARGE_2, "120.00");

    const result = await voidPaymentTx({
      organizationId: ORG,
      paymentId: VOID_PAYMENT,
      status: "void",
      referenceNote: "[status:void] duplicate",
      actorUserId: USER,
      actorRole: "admin",
    });

    expect(result).toMatchObject({ ok: true });

    const db = getDb();

    // Payment flipped to void.
    const payment = await db.payment.findUniqueOrThrow({ where: { id: VOID_PAYMENT } });
    expect(payment.status).toBe("void");

    // Exactly two reversal rows — one per allocation (append-only).
    const reversals = await db.paymentAllocationReversal.findMany({
      where: { organizationId: ORG },
      orderBy: { originalAllocationId: "asc" },
    });
    expect(reversals).toHaveLength(2);

    const byAlloc = new Map(reversals.map((r) => [r.originalAllocationId, r]));
    const r1 = byAlloc.get(alloc1);
    const r2 = byAlloc.get(alloc2);
    expect(r1).toBeDefined();
    expect(r2).toBeDefined();
    // Amount equals the allocated magnitude, Decimal(12,2).
    expect(Number(r1!.amount)).toBe(900);
    expect(Number(r2!.amount)).toBe(120);
    // Deterministic idempotency key + provenance.
    expect(r1!.idempotencyKey).toBe(`voidpay:${VOID_PAYMENT}:${alloc1}`);
    expect(r2!.idempotencyKey).toBe(`voidpay:${VOID_PAYMENT}:${alloc2}`);
    expect(r1!.reason).toBe("payment void");
    expect(r1!.reversedById).toBe(USER);
  });

  // ── case (b): re-void replay → alreadyVoid, still exactly 2 rows (no dup) ─────
  it("void replay no dup: re-voiding an already-void payment returns alreadyVoid and writes no duplicate reversal rows", async () => {
    await seedPayment(VOID_PAYMENT, "1020.00", "posted");
    await seedCharge(VOID_CHARGE_1, "900.00", "0.00");
    await seedCharge(VOID_CHARGE_2, "120.00", "0.00");
    await seedAllocation(VOID_PAYMENT, VOID_CHARGE_1, "900.00");
    await seedAllocation(VOID_PAYMENT, VOID_CHARGE_2, "120.00");

    const first = await voidPaymentTx({
      organizationId: ORG,
      paymentId: VOID_PAYMENT,
      status: "void",
      referenceNote: null,
      actorUserId: USER,
      actorRole: "admin",
    });
    expect(first).toMatchObject({ ok: true });

    const db = getDb();
    expect(await db.paymentAllocationReversal.count({ where: { organizationId: ORG } })).toBe(2);

    // Replay: the payment is already void → alreadyVoid, no new rows.
    const second = await voidPaymentTx({
      organizationId: ORG,
      paymentId: VOID_PAYMENT,
      status: "void",
      referenceNote: null,
      actorUserId: USER,
      actorRole: "admin",
    });
    expect(second).toMatchObject({ alreadyVoid: true });

    // Still exactly two reversal rows — the deterministic key prevents any dup.
    expect(await db.paymentAllocationReversal.count({ where: { organizationId: ORG } })).toBe(2);
  });

  // ── case (c): unposted (pending_approval) payment → 0 reversal rows ───────────
  it("unposted no reversal: voiding a pending_approval payment writes 0 reversal rows", async () => {
    await seedPayment(PENDING_PAYMENT, "900.00", "pending_approval");
    await seedCharge(PENDING_CHARGE, "900.00", "900.00");
    await seedAllocation(PENDING_PAYMENT, PENDING_CHARGE, "900.00");

    const result = await voidPaymentTx({
      organizationId: ORG,
      paymentId: PENDING_PAYMENT,
      status: "void",
      referenceNote: null,
      actorUserId: USER,
      actorRole: "admin",
    });

    expect(result).toMatchObject({ ok: true });

    const db = getDb();
    // Payment is void, but nothing was applied → no reversal rows.
    const payment = await db.payment.findUniqueOrThrow({ where: { id: PENDING_PAYMENT } });
    expect(payment.status).toBe("void");
    expect(await db.paymentAllocationReversal.count({ where: { organizationId: ORG } })).toBe(0);
  });

  // ── case (d): partial-reverse-then-void nets the prior reversal (R5 defect) ────
  // An allocation of RM400 partially reversed by RM100 via the reverse route, THEN
  // the payment is voided. The void must reverse only the RM300 REMAINDER (netting
  // the prior RM100), so Σreversals = 400 (== allocated), NOT 100 + 400 = 500 which
  // would push effectiveAllocated negative and wedge the allocation.
  it("nets prior partial reversal: RM400 alloc partially reversed RM100 then voided → Σreversals=400, exactly 2 rows", async () => {
    await seedPayment(PARTIAL_PAYMENT, "400.00", "posted");
    // The RM100 partial reversal already restored RM100 of outstanding: applied
    // charge (outstanding 0) after a RM100 reversal has outstanding 100.
    await seedCharge(PARTIAL_CHARGE, "400.00", "100.00");
    const alloc = await seedAllocation(PARTIAL_PAYMENT, PARTIAL_CHARGE, "400.00");

    const db = getDb();
    // Prior partial reversal of RM100 (as the Task-4 reverse route would have written).
    await db.paymentAllocationReversal.create({
      data: {
        organizationId: ORG,
        originalAllocationId: alloc,
        amount: "100.00",
        reason: "partial reverse",
        reversedById: USER,
        idempotencyKey: `revpartial:${PARTIAL_PAYMENT}:${alloc}`,
      },
    });

    const result = await voidPaymentTx({
      organizationId: ORG,
      paymentId: PARTIAL_PAYMENT,
      status: "void",
      referenceNote: null,
      actorUserId: USER,
      actorRole: "admin",
    });
    expect(result).toMatchObject({ ok: true });

    // Payment flipped to void.
    const payment = await db.payment.findUniqueOrThrow({ where: { id: PARTIAL_PAYMENT } });
    expect(payment.status).toBe("void");

    const reversals = await db.paymentAllocationReversal.findMany({
      where: { organizationId: ORG, originalAllocationId: alloc },
    });
    // Exactly two rows: the RM100 partial + the RM300 void-remainder.
    expect(reversals).toHaveLength(2);
    const total = reversals.reduce((s, r) => s + Number(r.amount), 0);
    // Σ must equal the allocated magnitude (400), NOT 100 + 400 = 500.
    expect(total).toBe(400);
    // The void wrote the remainder (300) under the deterministic voidpay: key.
    const voidRow = reversals.find((r) => r.idempotencyKey === `voidpay:${PARTIAL_PAYMENT}:${alloc}`);
    expect(voidRow).toBeDefined();
    expect(Number(voidRow!.amount)).toBe(300);

    // Charge fully restored (outstanding back to 400 == charge amount).
    const charge = await db.charge.findUniqueOrThrow({ where: { id: PARTIAL_CHARGE } });
    expect(Number(charge.outstandingAmount)).toBe(400);
  });
});
