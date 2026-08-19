/**
 * Integration tests for Task T4 — owner-ledger paymentStatus sync on tenant payment.
 *
 * When a tenant payment is applied and a Charge reaches "paid", the service must
 * trigger syncOwnerLedgerForCharges so the owner-ledger row's paymentStatus flips
 * from "pending" to "paid" without a separate manual sync.
 *
 * Hits a real LOCAL Postgres. Skipped by default in `npx vitest run`. Run:
 *   RUN_INTEGRATION=1 ENABLE_PHASE2_OWNER_BILLING=1 \
 *   DATABASE_URL="postgresql://yonghongtan@localhost:5432/kason_hub_dev?schema=public" \
 *   npx vitest run src/modules/payments/__tests__/payments.integration.test.ts
 */
import { beforeEach, afterAll, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { allocatePaymentService } from "../payments.service";
import { syncOwnerLedgerForCharges } from "../../owner-ledger/owner-ledger.sync-hook";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

// Hard safety: never run against a remote DB.
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

// Fixed UUIDs — all-hex, disjoint from other integration tests (prefix c4).
const ORG           = "c4000000-0000-4000-8000-000000000001";
const ADMIN_USER    = "c4000000-0000-4000-8000-000000000002";
const TENANT_PARTY  = "c4000000-0000-4000-8000-000000000003";
const OWNER_PARTY   = "c4000000-0000-4000-8000-000000000004";
const OWNER_USER    = "c4000000-0000-4000-8000-000000000005";
const PROPERTY      = "c4000000-0000-4000-8000-000000000006";
const APARTMENT     = "c4000000-0000-4000-8000-000000000007";
const UNIT          = "c4000000-0000-4000-8000-000000000008";
const PAYMENT       = "c4000000-0000-4000-8000-000000000010";
const CHARGE        = "c4000000-0000-4000-8000-000000000011";

async function cleanup() {
  const db = getDb();
  const orgScope = { organizationId: ORG };
  await db.ownerLedgerEntry.deleteMany({ where: orgScope });
  await db.notification.deleteMany({ where: orgScope });
  await db.paymentAllocation.deleteMany({ where: orgScope });
  await db.payment.deleteMany({ where: orgScope });
  await db.charge.deleteMany({ where: orgScope });
  await db.listing.deleteMany({ where: orgScope });
  await db.apartment.deleteMany({ where: orgScope });
  await db.property.deleteMany({ where: orgScope });
  await db.auditLog.deleteMany({ where: orgScope });
  await db.user.deleteMany({ where: orgScope });
  await db.party.deleteMany({ where: orgScope });
  await db.organization.deleteMany({ where: { id: ORG } });
}

/** Seed an org with an owner, a tenant, and an owned unit. */
async function seed() {
  const db = getDb();
  await db.organization.create({
    data: { id: ORG, name: "T4 Integration Org", slug: "t4-int-org", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" },
  });
  await db.party.create({ data: { id: TENANT_PARTY, organizationId: ORG, displayName: "T4 Tenant", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: OWNER_PARTY, organizationId: ORG, displayName: "T4 Owner", partyType: "individual", status: "active" } });
  // Admin/operator user — actorUserId FK on AuditLog requires this.
  await db.user.create({ data: { id: ADMIN_USER, organizationId: ORG, email: "t4-admin@example.test", fullName: "T4 Admin", status: "active", role: "manager", userType: "operator" } });
  // Owner's portal user — required by notifyOwnersOfChargesPaid to create the notification.
  await db.user.create({ data: { id: OWNER_USER, organizationId: ORG, email: "t4-owner@example.test", fullName: "T4 Owner", status: "active", role: "owner", userType: "owner", partyId: OWNER_PARTY } });
  await db.property.create({
    data: { id: PROPERTY, organizationId: ORG, name: "T4 Property", propertyCode: "T4-P1", propertyType: "apartment", addressLine1: "1 T4 St", city: "KL", country: "MY", status: "active", publishStatus: "draft" },
  });
  await db.apartment.create({ data: { id: APARTMENT, organizationId: ORG, propertyId: PROPERTY, unitCode: "T4-A-1", listingMode: "PARTITIONED" } });
  // Owned unit — Listing.ownerPartyId is the per-unit owner resolution used by the sync.
  await db.listing.create({
    data: { id: UNIT, organizationId: ORG, apartmentId: APARTMENT, listingType: "room", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER_PARTY },
  });
  // Rent charge on the owned unit with billingMonth set — required by syncOwnerLedgerForCharges
  // to derive the month, and dueDate within that month for syncMonthService to find it.
  await db.charge.create({
    data: {
      id: CHARGE, organizationId: ORG, chargeNumber: "CHG-T4-001",
      partyId: TENANT_PARTY, unitId: UNIT,
      chargeType: "rent", status: "posted",
      dueDate: new Date("2026-06-30T00:00:00.000Z"),
      billingMonth: new Date("2026-06-01T00:00:00.000Z"),
      amount: "600.00", currency: "MYR", outstandingAmount: "600.00",
    },
  });
  // A posted payment the tenant is paying with.
  await db.payment.create({
    data: {
      id: PAYMENT, organizationId: ORG, paymentNumber: "PAY-T4-001",
      partyId: TENANT_PARTY, paymentType: "payment", paymentMethod: "bank_transfer",
      status: "posted", amount: "600.00", currency: "MYR",
      receivedAt: new Date("2026-06-01T00:00:00.000Z"),
    },
  });
}

dn("T4 — owner-ledger paymentStatus flips to 'paid' on tenant payment allocation", () => {
  beforeEach(async () => {
    await cleanup();
    await seed();
  });
  afterAll(async () => {
    await cleanup();
  });

  it("allocatePaymentService paying a posted charge flips owner-ledger paymentStatus to 'paid'", async () => {
    const db = getDb();

    // Step 1: pre-sync to materialise the owner-ledger row in "pending" state
    // (charge is posted, not yet paid). syncOwnerLedgerForCharges requires
    // ENABLE_PHASE2_OWNER_BILLING=1 in env (set in the test command).
    await syncOwnerLedgerForCharges(ORG, ADMIN_USER, "manager", [CHARGE]);

    const rowBefore = await db.ownerLedgerEntry.findFirst({
      where: { organizationId: ORG, ownerPartyId: OWNER_PARTY, sourceType: "rent" },
    });
    expect(rowBefore).not.toBeNull();
    expect(rowBefore?.paymentStatus).toBe("pending");

    // Step 2: apply the full payment via allocatePaymentService.
    // After T4 implementation, the service calls syncOwnerLedgerForCharges
    // post-commit, which re-syncs the now-paid charge and flips paymentStatus.
    const session = { userId: ADMIN_USER, orgId: ORG, role: "manager" };
    const result = await allocatePaymentService(session, {
      paymentId: PAYMENT,
      chargeId: CHARGE,
      allocatedAmount: "600.00",
    });
    expect(result.ok).toBe(true);

    // Step 3: the charge must now be "paid".
    const charge = await db.charge.findUniqueOrThrow({ where: { id: CHARGE } });
    expect(charge.status).toBe("paid");

    // Step 4: the owner-ledger row must now show paymentStatus "paid" (set by the
    // post-payment sync triggered inside allocatePaymentService).
    const rowAfter = await db.ownerLedgerEntry.findFirst({
      where: { organizationId: ORG, ownerPartyId: OWNER_PARTY, sourceType: "rent" },
    });
    expect(rowAfter?.paymentStatus).toBe("paid");
  });
});
