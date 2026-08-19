/**
 * payment-dedup.integration.test.ts
 * Integration proof for the Spec2 R9 adversarial-review fix in
 * findRecentDuplicatePayment (payments.repository.ts): the guard's query
 * amount is now rounded via Prisma.Decimal (matching how Payment.amount
 * numeric(12,2) is ACTUALLY stored by Postgres — half-up on the exact
 * decimal string), instead of a plain float Math.round(amount*100)/100
 * which silently disagreed with Postgres for 3dp inputs (e.g. 1.005 ->
 * Math.round gives 1.00, but the stored row is 1.01).
 *
 * This is the FAITHFUL end-to-end proof the mocked unit tests
 * (payments.repository.test.ts) cannot provide: the mock never exercises
 * Postgres's own numeric(12,2) rounding on write, so a mock-only suite could
 * stay green while the real guard still missed a real duplicate. Here we
 * persist a Payment the same way production does (a raw JS number handed to
 * Prisma for a Decimal column) and assert against the row Postgres ACTUALLY
 * stored.
 *
 * Hits a real LOCAL Postgres. Skipped by default in `vitest run`. Run explicitly:
 *   RUN_INTEGRATION=1 <repo>/node_modules/.bin/vitest run \
 *     src/modules/payments/__tests__/payment-dedup.integration.test.ts
 *
 * Mirrors charge-dedup.integration.test.ts's harness: fixed-UUID seed + a
 * hard-guard that refuses to run against anything but a local DB host, and
 * org-scoped deleteMany cleanup in FK-safe order (children before parents).
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getDb, Prisma } from "@kason/db";
import { findRecentDuplicatePayment } from "../payments.repository";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

// Hard safety: integration runs must only ever hit a local postgres.
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

// Fixed UUIDs — disjoint prefix ("d4") from every other integration test's constants.
const ORG = "d4000000-0000-4000-8000-0000000000a1";
const PARTY = "d4000000-0000-4000-8000-0000000000a2";
const PROPERTY = "d4000000-0000-4000-8000-0000000000a3";
const APARTMENT = "d4000000-0000-4000-8000-0000000000a4";
const UNIT = "d4000000-0000-4000-8000-0000000000a5";
const SERIES = "d4000000-0000-4000-8000-0000000000a6";
const CATEGORY = "d4000000-0000-4000-8000-0000000000a7";
const CHARGE = "d4000000-0000-4000-8000-0000000000a8";
const PAYMENT = "d4000000-0000-4000-8000-0000000000a9";
const ALLOCATION = "d4000000-0000-4000-8000-0000000000aa";

const BILLING_MONTH = new Date("2026-07-01T00:00:00.000Z");

async function seed() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG,
      name: "Payment Dedup Int Org",
      slug: "payment-dedup-int-org",
      status: "active",
      defaultCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur",
      locale: "en-MY",
      subscriptionPlan: "free",
    },
  });
  await db.party.create({
    data: { id: PARTY, organizationId: ORG, displayName: "Dedup Payer", partyType: "individual", status: "active" },
  });
  await db.property.create({
    data: {
      id: PROPERTY,
      organizationId: ORG,
      name: "Payment Dedup Property",
      propertyCode: "PAYDEDUP-P1",
      propertyType: "apartment",
      addressLine1: "1 Test St",
      city: "KL",
      country: "MY",
      status: "active",
      publishStatus: "draft",
    },
  });
  await db.apartment.create({
    data: { id: APARTMENT, organizationId: ORG, propertyId: PROPERTY, unitCode: "PD-1", listingMode: "PARTITIONED" },
  });
  await db.listing.create({
    data: {
      id: UNIT,
      organizationId: ORG,
      apartmentId: APARTMENT,
      listingType: "room",
      occupancyStatus: "occupied",
      listingStatus: "active",
      currency: "MYR",
    },
  });
  await db.documentSeries.create({
    data: { id: SERIES, organizationId: ORG, code: "PAYDEDUP", prefix: "PD", padding: 4, includeYear: false, active: true },
  });
  await db.chargeCategory.create({
    data: {
      id: CATEGORY,
      organizationId: ORG,
      code: "payment_dedup_test",
      name: "Payment Dedup Test Category",
      family: "tenant_income",
      docType: "invoice",
      seriesId: SERIES,
      defaultSstRate: "0",
      eInvoiceEligible: false,
      isSystem: false,
      active: true,
      sortOrder: 1,
    },
  });
  await db.charge.create({
    data: {
      id: CHARGE,
      organizationId: ORG,
      chargeNumber: "PAYDEDUP-INT-1",
      unitId: UNIT,
      categoryId: CATEGORY,
      partyId: PARTY,
      chargeType: "rent",
      status: "posted",
      description: "Payment dedup integration charge",
      dueDate: BILLING_MONTH,
      amount: "100.00",
      currency: "MYR",
      outstandingAmount: "0.00", // already settled by the seeded payment below
      billingMonth: BILLING_MONTH,
      attachmentKeys: [],
    },
  });
}

/** Delete everything in FK-safe order (children before parents). */
async function cleanup() {
  const db = getDb();
  const orgs = { in: [ORG] };
  await db.paymentAllocation.deleteMany({ where: { organizationId: orgs } });
  await db.payment.deleteMany({ where: { organizationId: orgs } });
  await db.charge.deleteMany({ where: { organizationId: orgs } });
  await db.chargeCategory.deleteMany({ where: { organizationId: orgs } });
  await db.documentSeries.deleteMany({ where: { organizationId: orgs } });
  await db.listing.deleteMany({ where: { organizationId: orgs } });
  await db.apartment.deleteMany({ where: { organizationId: orgs } });
  await db.property.deleteMany({ where: { organizationId: orgs } });
  await db.party.deleteMany({ where: { organizationId: orgs } });
  await db.organization.deleteMany({ where: { id: orgs } });
}

dn("findRecentDuplicatePayment — real-Postgres rounding proof (integration, Spec2 R9 fix)", () => {
  beforeEach(async () => {
    await cleanup();
    await seed();
  });

  afterAll(async () => {
    await cleanup();
  });

  it("a Payment persisted from a 1.005-valued allocation (Postgres rounds numeric(12,2) half-up on write -> stored row is 1.01) IS found when the guard is queried with the ORIGINAL raw 1.005 — the guard fires on the real duplicate", async () => {
    const db = getDb();

    // Persist EXACTLY like production does (createPayment /
    // createPaymentWithAllocationsTx): hand Prisma a raw JS number for a
    // Decimal column — no manual Prisma.Decimal wrapping here. Postgres's own
    // numeric(12,2) rounding is what turns 1.005 into the stored 1.01.
    const created = await db.payment.create({
      data: {
        id: PAYMENT,
        organizationId: ORG,
        paymentNumber: "PAYDEDUP-INT-PAY-1",
        partyId: PARTY,
        paymentType: "rental_payment",
        paymentMethod: "bank_transfer",
        status: "posted",
        amount: 1.005,
        currency: "MYR",
        receivedAt: new Date(),
        attachmentKeys: [],
      },
      select: { id: true, amount: true },
    });
    // Prove the premise the whole fix depends on: the ACTUAL stored value.
    expect(created.amount.toString()).toBe("1.01");

    await db.paymentAllocation.create({
      data: {
        id: ALLOCATION,
        organizationId: ORG,
        paymentId: PAYMENT,
        chargeId: CHARGE,
        allocatedAmount: 1.005,
        allocatedAt: new Date(),
      },
    });

    const result = await findRecentDuplicatePayment(ORG, {
      partyId: PARTY,
      amount: 1.005,
      paymentMethod: "bank_transfer",
      chargeIds: [CHARGE],
      sinceMinutes: 10,
    });

    expect(result).toEqual({ id: PAYMENT });
  });

  it("a genuinely different amount (2.00) against the same party/charge/window returns null — the guard does not false-positive on real distinct amounts", async () => {
    const db = getDb();
    await db.payment.create({
      data: {
        id: PAYMENT,
        organizationId: ORG,
        paymentNumber: "PAYDEDUP-INT-PAY-2",
        partyId: PARTY,
        paymentType: "rental_payment",
        paymentMethod: "bank_transfer",
        status: "posted",
        amount: 1.005,
        currency: "MYR",
        receivedAt: new Date(),
        attachmentKeys: [],
      },
    });
    await db.paymentAllocation.create({
      data: {
        id: ALLOCATION,
        organizationId: ORG,
        paymentId: PAYMENT,
        chargeId: CHARGE,
        allocatedAmount: 1.005,
        allocatedAt: new Date(),
      },
    });

    const result = await findRecentDuplicatePayment(ORG, {
      partyId: PARTY,
      amount: 2.0,
      paymentMethod: "bank_transfer",
      chargeIds: [CHARGE],
      sinceMinutes: 10,
    });

    expect(result).toBeNull();
  });
});
