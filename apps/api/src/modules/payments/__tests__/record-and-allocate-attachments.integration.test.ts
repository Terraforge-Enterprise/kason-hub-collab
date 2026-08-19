/**
 * Integration test: record-and-allocate persists attachmentKeys on the created
 * Payment (P3 T1, R9/R10). Hits a real LOCAL Postgres. Skipped by default.
 *
 * Run explicitly:
 *   RUN_INTEGRATION=1 ENABLE_PHASE2_BILLING_DOCS=1 \
 *     npx vitest run src/modules/payments/__tests__/record-and-allocate-attachments.integration.test.ts
 *
 * Mirrors the payments.multipay.integration.test.ts seed harness (fixed-UUID
 * seed + org-scoped cleanup, localhost-only safety gate).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { recordAndAllocatePaymentService } from "../payments.service";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

// Fixed UUIDs — disjoint prefix (a9) from every other integration test's constants.
const ORG = "a9000000-0000-4000-8000-000000000001";
const USER = "a9000000-0000-4000-8000-000000000002";
const PARTY = "a9000000-0000-4000-8000-000000000003";
const CHARGE = "a9000000-0000-4000-8000-000000000011";

async function cleanup() {
  const db = getDb();
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
      name: "P3 T1 Integration Test Org",
      slug: "a9-int-test",
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
      displayName: "P3 T1 Tenant Payer",
      partyType: "individual",
      status: "active",
    },
  });
  await db.user.create({
    data: {
      id: USER,
      organizationId: ORG,
      email: "p3-t1-int@example.test",
      fullName: "P3 T1 Operator",
      status: "active",
      role: "accountant",
      userType: "operator",
    },
  });
  await db.charge.create({
    data: {
      id: CHARGE,
      organizationId: ORG,
      chargeNumber: "CHG-A9-0011",
      partyId: PARTY,
      chargeType: "rent",
      status: "posted",
      dueDate: new Date("2026-07-30T00:00:00.000Z"),
      amount: "100.00",
      currency: "MYR",
      outstandingAmount: "100.00",
    },
  });
}

dn("record-and-allocate persists attachmentKeys", () => {
  beforeEach(async () => {
    await cleanup();
    await seed();
  });
  afterEach(async () => {
    await cleanup();
  });

  it("writes attachmentKeys on the created Payment", async () => {
    const db = getDb();
    const session = { orgId: ORG, userId: USER, role: "accountant" } as never;
    const res = await recordAndAllocatePaymentService(session, {
      paymentNumber: `PAY-${Date.now()}`,
      partyId: PARTY,
      paymentType: "rental_payment",
      paymentMethod: "bank_transfer",
      currency: "MYR",
      receivedAt: "2026-07-13",
      idempotencyKey: crypto.randomUUID(),
      attachmentKeys: ["orgs/o/slips/a.jpg", "orgs/o/slips/b.jpg"],
      allocations: [{ chargeId: CHARGE, allocatedAmount: "100.00" }],
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const row = await db.payment.findUnique({ where: { id: res.data.id }, select: { attachmentKeys: true } });
      expect(row?.attachmentKeys).toEqual(["orgs/o/slips/a.jpg", "orgs/o/slips/b.jpg"]);
    }
  });
});
