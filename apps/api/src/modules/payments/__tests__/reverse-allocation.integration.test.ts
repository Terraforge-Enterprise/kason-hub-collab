/**
 * Integration tests for Task 4 — append-only PaymentAllocationReversal (R4).
 * Hits a real LOCAL Postgres. Skipped by default in `npx vitest run`.
 *
 * Run explicitly:
 *   RUN_INTEGRATION=1 ENABLE_PHASE2_MULTI_PAY=1 \
 *     npx vitest run src/modules/payments/__tests__/reverse-allocation.integration.test.ts
 *
 * Mirrors payments.multipay.integration.test.ts: fixed-UUID seed + org-scoped
 * deleteMany cleanup, localhost-only safety gate, RUN_INTEGRATION skip guard.
 * Constants use the `b3` prefix, disjoint from the multipay `a3` set.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { reverseAllocationService } from "../payments.service";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

// Hard safety: never run against a remote DB.
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

// Fixed UUIDs — valid hex, disjoint from every other integration test (prefix b3).
const B3_ORG = "b3000000-0000-4000-8000-000000000001";
const B3_USER = "b3000000-0000-4000-8000-000000000002";
const B3_PARTY = "b3000000-0000-4000-8000-000000000003";
const B3_PAYMENT = "b3000000-0000-4000-8000-000000000010";
const B3_CHARGE = "b3000000-0000-4000-8000-000000000011";
const B3_ALLOC = "b3000000-0000-4000-8000-000000000020";

// A second org — used for the cross-org IDOR case.
const B3_ORG_B = "b3000000-0000-4000-8000-000000000101";
const B3_USER_B = "b3000000-0000-4000-8000-000000000102";
const B3_PARTY_B = "b3000000-0000-4000-8000-000000000103";
const B3_PAYMENT_B = "b3000000-0000-4000-8000-000000000110";
const B3_CHARGE_B = "b3000000-0000-4000-8000-000000000111";
const B3_ALLOC_B = "b3000000-0000-4000-8000-000000000120";

const SESSION = { orgId: B3_ORG, userId: B3_USER, role: "accountant" as const, userType: "operator" as const };

async function cleanupOrg(orgId: string) {
  const db = getDb();
  await db.paymentAllocationReversal.deleteMany({ where: { organizationId: orgId } });
  await db.paymentAllocation.deleteMany({ where: { organizationId: orgId } });
  await db.payment.deleteMany({ where: { organizationId: orgId } });
  await db.charge.deleteMany({ where: { organizationId: orgId } });
  await db.auditLog.deleteMany({ where: { organizationId: orgId } });
  await db.user.deleteMany({ where: { organizationId: orgId } });
  await db.party.deleteMany({ where: { organizationId: orgId } });
  await db.organization.deleteMany({ where: { id: orgId } });
}

/** Seed an org + user + party + posted payment + posted charge + RM400 allocation. */
async function seedScope(opts: {
  orgId: string; userId: string; partyId: string; paymentId: string; chargeId: string; allocId: string; slug: string;
}) {
  const db = getDb();
  await db.organization.create({
    data: {
      id: opts.orgId,
      name: `B3 Reversal Org ${opts.slug}`,
      slug: `b3-rev-${opts.slug}`,
      status: "active",
      defaultCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur",
      locale: "en-MY",
      subscriptionPlan: "free",
    },
  });
  await db.party.create({
    data: { id: opts.partyId, organizationId: opts.orgId, displayName: "B3 Payer", partyType: "individual", status: "active" },
  });
  await db.user.create({
    data: {
      id: opts.userId, organizationId: opts.orgId, email: `b3-${opts.slug}@example.test`,
      fullName: "B3 Operator", status: "active", role: "accountant", userType: "operator",
    },
  });
  // Posted payment (so restoreChargeTx runs) with RM400 already applied to the charge.
  await db.payment.create({
    data: {
      id: opts.paymentId, organizationId: opts.orgId, paymentNumber: `PAY-B3-${opts.slug}`,
      partyId: opts.partyId, paymentType: "payment", paymentMethod: "bank_transfer",
      status: "posted", amount: "400.00", currency: "MYR",
      receivedAt: new Date("2026-07-01T00:00:00.000Z"), idempotencyKey: null,
    },
  });
  // Charge RM400 with 0 outstanding (fully paid by the allocation below).
  await db.charge.create({
    data: {
      id: opts.chargeId, organizationId: opts.orgId, chargeNumber: `CHG-B3-${opts.slug}`,
      partyId: opts.partyId, chargeType: "rent", status: "paid",
      dueDate: new Date("2026-07-30T00:00:00.000Z"), amount: "400.00", currency: "MYR", outstandingAmount: "0.00",
    },
  });
  await db.paymentAllocation.create({
    data: {
      id: opts.allocId, organizationId: opts.orgId, paymentId: opts.paymentId,
      chargeId: opts.chargeId, allocatedAmount: "400.00", allocatedAt: new Date("2026-07-01T00:00:00.000Z"),
    },
  });
}

async function effectiveAllocated(orgId: string, allocId: string): Promise<number> {
  const db = getDb();
  const alloc = await db.paymentAllocation.findUnique({ where: { id: allocId }, select: { allocatedAmount: true } });
  const agg = await db.paymentAllocationReversal.aggregate({
    where: { organizationId: orgId, originalAllocationId: allocId }, _sum: { amount: true },
  });
  const allocated = Number((alloc?.allocatedAmount ?? 0).toString());
  const reversed = Number((agg._sum.amount ?? 0).toString());
  return Math.round((allocated - reversed) * 100) / 100;
}

dn("reverseAllocationService — append-only reversal (integration)", () => {
  beforeEach(async () => {
    await cleanupOrg(B3_ORG);
    await cleanupOrg(B3_ORG_B);
    await seedScope({ orgId: B3_ORG, userId: B3_USER, partyId: B3_PARTY, paymentId: B3_PAYMENT, chargeId: B3_CHARGE, allocId: B3_ALLOC, slug: "a" });
  });

  it("append-only full: writes a reversal row, leaves the allocation unchanged, effectiveAllocated=0", async () => {
    const db = getDb();
    const res = await reverseAllocationService(SESSION, {
      paymentId: B3_PAYMENT, allocationId: B3_ALLOC, reason: "customer refund", idempotencyKey: "b3aa0001-0000-4000-8000-000000000001",
    });
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);

    const reversals = await db.paymentAllocationReversal.findMany({ where: { organizationId: B3_ORG, originalAllocationId: B3_ALLOC } });
    expect(reversals).toHaveLength(1);
    expect(Number(reversals[0].amount.toString())).toBe(400);

    // Original allocation row is NEVER mutated or deleted.
    const alloc = await db.paymentAllocation.findUnique({ where: { id: B3_ALLOC } });
    expect(alloc).not.toBeNull();
    expect(Number(alloc!.allocatedAmount.toString())).toBe(400);

    expect(await effectiveAllocated(B3_ORG, B3_ALLOC)).toBe(0);
  });

  it("idempotent replay: same idempotencyKey returns the same reversal, count stays 1", async () => {
    const db = getDb();
    const key = "b3aa0002-0000-4000-8000-000000000002";
    const first = await reverseAllocationService(SESSION, { paymentId: B3_PAYMENT, allocationId: B3_ALLOC, reason: "dupe test", idempotencyKey: key });
    expect(first.ok).toBe(true);
    const firstId = (first as { data: { reversalId: string } }).data.reversalId;

    const second = await reverseAllocationService(SESSION, { paymentId: B3_PAYMENT, allocationId: B3_ALLOC, reason: "dupe test", idempotencyKey: key });
    expect(second.ok).toBe(true);
    const secondId = (second as { data: { reversalId: string } }).data.reversalId;

    expect(secondId).toBe(firstId);
    const count = await db.paymentAllocationReversal.count({ where: { organizationId: B3_ORG, originalAllocationId: B3_ALLOC } });
    expect(count).toBe(1);
  });

  it("over-cap 400: amount > effectiveAllocated returns REVERSAL_EXCEEDS_ALLOCATED and writes no row", async () => {
    const db = getDb();
    const res = await reverseAllocationService(SESSION, {
      paymentId: B3_PAYMENT, allocationId: B3_ALLOC, reason: "too much", amount: "500", idempotencyKey: "b3aa0003-0000-4000-8000-000000000003",
    });
    expect(res.ok).toBe(false);
    expect((res as { status: number }).status).toBe(400);
    expect((res as { error: string }).error).toBe("REVERSAL_EXCEEDS_ALLOCATED");

    const count = await db.paymentAllocationReversal.count({ where: { organizationId: B3_ORG, originalAllocationId: B3_ALLOC } });
    expect(count).toBe(0);
  });

  it("cross-org 404: an org-A session cannot reverse an org-B allocation (IDOR); no row in org B", async () => {
    const db = getDb();
    await seedScope({ orgId: B3_ORG_B, userId: B3_USER_B, partyId: B3_PARTY_B, paymentId: B3_PAYMENT_B, chargeId: B3_CHARGE_B, allocId: B3_ALLOC_B, slug: "b" });

    const res = await reverseAllocationService(SESSION, {
      paymentId: B3_PAYMENT_B, allocationId: B3_ALLOC_B, reason: "idor", idempotencyKey: "b3aa0004-0000-4000-8000-000000000004",
    });
    expect(res.ok).toBe(false);
    expect((res as { status: number }).status).toBe(404);

    const count = await db.paymentAllocationReversal.count({ where: { organizationId: B3_ORG_B } });
    expect(count).toBe(0);
  });

  it("audit row: a successful reversal records action payment.allocation.reverse", async () => {
    const db = getDb();
    await reverseAllocationService(SESSION, {
      paymentId: B3_PAYMENT, allocationId: B3_ALLOC, reason: "audited", idempotencyKey: "b3aa0005-0000-4000-8000-000000000005",
    });
    const audit = await db.auditLog.findFirst({
      where: { organizationId: B3_ORG, action: "payment.allocation.reverse", entityId: B3_ALLOC },
    });
    expect(audit).not.toBeNull();
  });

  it("back-compat defaults: omitting reason/idempotencyKey still succeeds and writes a reversal", async () => {
    const db = getDb();
    // Mirror the route: parse through the schema so server defaults apply.
    const { reverseAllocationSchema } = await import("../payments.validation");
    const parsed = reverseAllocationSchema.parse({ paymentId: B3_PAYMENT, allocationId: B3_ALLOC });
    const res = await reverseAllocationService(SESSION, parsed);
    expect(res.ok).toBe(true);
    expect((res as { status: number }).status).toBe(200);

    const reversals = await db.paymentAllocationReversal.findMany({ where: { organizationId: B3_ORG, originalAllocationId: B3_ALLOC } });
    expect(reversals).toHaveLength(1);
    expect(reversals[0].reason).toBe("(unspecified)");
  });
});
