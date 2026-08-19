/**
 * Integration tests for Task 5 — exclude in-flight FPX payments from the admin
 * approval surface.
 *
 * A tenant FPX payment is created as a Payment with status "pending_approval",
 * provider "fpx-mock", gatewayStatus "pending" and settles ONLY when the signed
 * gateway callback arrives. Until then an admin must NOT be able to prematurely
 * post it. The admin payments listing (`listPayments`) feeds the "Post (approve)
 * payment" affordance, so it must EXCLUDE gatewayStatus="pending" rows while
 * keeping manual bank_transfer/cash pending_approval payments (gatewayStatus=null)
 * and all settled rows.
 *
 * Hits a real LOCAL Postgres. Skipped by default in `npx vitest run`. Run:
 *   RUN_INTEGRATION=1 ENABLE_PHASE2_MULTI_PAY=1 \
 *   DATABASE_URL="postgresql://yonghongtan@localhost:5432/kason_hub_dev" \
 *   npx vitest run src/modules/payments/__tests__/payments.fpx-approval-queue.integration.test.ts
 */
import { beforeEach, afterAll, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { listPayments } from "../payments.repository";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

// Hard safety: never run against a remote DB.
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

// Fixed UUIDs — all-hex, disjoint from every other integration test (prefix e5).
const ORG = "e5000000-0000-4000-8000-000000000001";
const PARTY = "e5000000-0000-4000-8000-000000000002";
const MANUAL_PENDING = "e5000000-0000-4000-8000-000000000010"; // pending_approval, gatewayStatus null
const FPX_PENDING = "e5000000-0000-4000-8000-000000000011"; // pending_approval, gatewayStatus "pending"
const POSTED = "e5000000-0000-4000-8000-000000000012"; // posted, gatewayStatus null
const FPX_SETTLED = "e5000000-0000-4000-8000-000000000013"; // posted, gatewayStatus "success"
const POSTED_STAMP_CRASHED = "e5000000-0000-4000-8000-000000000014"; // posted, gatewayStatus "pending" (settle committed, success-stamp died)

async function cleanup() {
  const db = getDb();
  await db.paymentAllocation.deleteMany({ where: { organizationId: ORG } });
  await db.payment.deleteMany({ where: { organizationId: ORG } });
  await db.party.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function seed() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG,
      name: "T5 FPX Approval Queue Org",
      slug: "t5-fpx-approval",
      status: "active",
      defaultCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur",
      locale: "en-MY",
      subscriptionPlan: "free",
    },
  });
  await db.party.create({
    data: { id: PARTY, organizationId: ORG, displayName: "T5 Payer", partyType: "individual", status: "active" },
  });

  // A MANUAL pending_approval payment (e.g. tenant bank-transfer submission) —
  // gatewayStatus is left null and MUST still surface for manual approval.
  await db.payment.create({
    data: {
      id: MANUAL_PENDING,
      organizationId: ORG,
      paymentNumber: "PAY-T5-MANUAL",
      partyId: PARTY,
      paymentType: "incoming",
      paymentMethod: "bank_transfer",
      status: "pending_approval",
      amount: "300.00",
      currency: "MYR",
      receivedAt: new Date("2026-06-01T00:00:00.000Z"),
    },
  });

  // An in-flight FPX payment — gatewayStatus "pending"; MUST be excluded so the
  // admin can never post it before the gateway callback settles it.
  await db.payment.create({
    data: {
      id: FPX_PENDING,
      organizationId: ORG,
      paymentNumber: "PAY-T5-FPX",
      partyId: PARTY,
      paymentType: "incoming",
      paymentMethod: "fpx",
      provider: "fpx-mock",
      providerTxnId: "e5-fpx-txn-0001",
      gatewayStatus: "pending",
      status: "pending_approval",
      amount: "400.00",
      currency: "MYR",
      receivedAt: new Date("2026-06-02T00:00:00.000Z"),
    },
  });

  // A regular posted payment — gatewayStatus null; MUST be unaffected.
  await db.payment.create({
    data: {
      id: POSTED,
      organizationId: ORG,
      paymentNumber: "PAY-T5-POSTED",
      partyId: PARTY,
      paymentType: "incoming",
      paymentMethod: "bank_transfer",
      status: "posted",
      amount: "500.00",
      currency: "MYR",
      receivedAt: new Date("2026-06-03T00:00:00.000Z"),
    },
  });

  // A SETTLED FPX payment — once the callback succeeds gatewayStatus moves to
  // "success" and status to "posted". It is NOT in-flight and MUST still appear.
  await db.payment.create({
    data: {
      id: FPX_SETTLED,
      organizationId: ORG,
      paymentNumber: "PAY-T5-FPX-DONE",
      partyId: PARTY,
      paymentType: "incoming",
      paymentMethod: "fpx",
      provider: "fpx-mock",
      providerTxnId: "e5-fpx-txn-0002",
      gatewayStatus: "success",
      status: "posted",
      amount: "600.00",
      currency: "MYR",
      receivedAt: new Date("2026-06-04T00:00:00.000Z"),
    },
  });

  // FIX 2: a settle that COMMITTED (status "posted", charges paid) but whose
  // separate setFpxGatewaySuccess stamp died before running — so gatewayStatus is
  // still "pending". The money is fully collected; the row must NOT vanish from
  // every admin view. The `status:"posted"` OR-branch keeps it visible.
  await db.payment.create({
    data: {
      id: POSTED_STAMP_CRASHED,
      organizationId: ORG,
      paymentNumber: "PAY-T5-FPX-STAMPCRASH",
      partyId: PARTY,
      paymentType: "incoming",
      paymentMethod: "fpx",
      provider: "fpx-mock",
      providerTxnId: "e5-fpx-txn-0003",
      gatewayStatus: "pending",
      status: "posted",
      amount: "700.00",
      currency: "MYR",
      receivedAt: new Date("2026-06-05T00:00:00.000Z"),
    },
  });
}

dn("listPayments excludes in-flight FPX payments from the admin approval surface", () => {
  beforeEach(async () => {
    await cleanup();
    await seed();
  });
  afterAll(async () => {
    await cleanup();
  });

  it("default (unfiltered) admin listing hides the in-flight FPX payment but keeps manual + posted + settled-FPX", async () => {
    // The admin "Post (approve) payment" affordance filters pending_approval
    // client-side from this DEFAULT unfiltered listing, so the in-flight FPX row
    // must already be gone here.
    const result = await listPayments(ORG);
    const ids = result.data.map((r) => r.id);

    expect(ids).not.toContain(FPX_PENDING); // in-flight FPX excluded
    expect(ids).toContain(MANUAL_PENDING); // manual pending_approval (null gatewayStatus) kept
    expect(ids).toContain(POSTED); // regular posted unaffected
    expect(ids).toContain(FPX_SETTLED); // settled FPX (gatewayStatus="success") kept
    expect(ids).toContain(POSTED_STAMP_CRASHED); // FIX 2: posted-but-stamp-crashed stays VISIBLE
    expect(ids).toHaveLength(4);
  });

  it("FIX 2: a settled-but-stamp-crashed payment (status posted + gatewayStatus 'pending') is visible, while an in-flight one (pending_approval + gatewayStatus 'pending') is hidden", async () => {
    const result = await listPayments(ORG);
    const ids = result.data.map((r) => r.id);

    // status:"posted" rescues the fully-collected row whose success-stamp died...
    expect(ids).toContain(POSTED_STAMP_CRASHED);
    // ...without resurfacing a genuinely in-flight FPX payment (not yet posted).
    expect(ids).not.toContain(FPX_PENDING);
  });

  it("status=pending_approval approval queue returns ONLY the manual payment, never the in-flight FPX one", async () => {
    const result = await listPayments(ORG, { status: "pending_approval" });
    const ids = result.data.map((r) => r.id);

    expect(ids).toEqual([MANUAL_PENDING]);
    expect(ids).not.toContain(FPX_PENDING);
  });
});
