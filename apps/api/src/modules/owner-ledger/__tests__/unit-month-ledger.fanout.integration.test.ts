/**
 * Task 6: fan-out triggers — re-materialize UnitMonthLedger on fee-config changes.
 *
 * Verifies that after `updateFeeConfigService` changes the management fee rate,
 * the UnitMonthLedger row is automatically re-materialized so mgmtFeeC reflects
 * the new rate.
 *
 * RED phase: no trigger → mgmtFeeC unchanged after update.
 * GREEN phase: trigger wired → mgmtFeeC changed after update.
 *
 * Real LOCAL Postgres; opt-in via RUN_INTEGRATION=1. Disjoint fixed UUIDs (fa00..).
 */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { getDb } from "@kason/db";
import { materializeOwnerUnitMonths } from "../unit-month-ledger.materialize";
import { updateFeeConfigService } from "../../owner-billing/owner-billing.service";
import type { OwnerBillingActorCtx } from "../../owner-billing/owner-billing.types";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

// ─── Fixed UUIDs — prefix fa (unique to this test file, all-hex) ─────────────
const ORG      = "fa000000-0000-4000-8000-000000000001";
const USER     = "fa000000-0000-4000-8000-000000000002";
const PARTY_OP = "fa000000-0000-4000-8000-000000000003";
const OWNER    = "fa000000-0000-4000-8000-000000000004";
const TENANT   = "fa000000-0000-4000-8000-000000000005";
const PROPERTY = "fa000000-0000-4000-8000-000000000006";
const APT1     = "fa000000-0000-4000-8000-0000000000a1";
const LISTING1 = "fa000000-0000-4000-8000-0000000000a2";
const TENANCY1 = "fa000000-0000-4000-8000-0000000000a3";

const MONTH       = "2025-09";
const MONTH_START = new Date(Date.UTC(2025, 8, 1)); // 2025-09-01T00:00:00Z
const MID_MONTH   = new Date(Date.UTC(2025, 8, 15));

const billingCtx: OwnerBillingActorCtx = {
  orgId: ORG,
  actorUserId: USER,
  actorRole: "admin",
};

// ─── Cleanup ──────────────────────────────────────────────────────────────────
async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  await db.unitMonthLedger.deleteMany({ where: org });
  await db.ownerLedgerEntry.deleteMany({ where: org });
  await db.deposit.deleteMany({ where: org });
  await db.charge.deleteMany({ where: org });
  await db.invoice.deleteMany({ where: org });
  await db.managementFeeConfig.deleteMany({ where: org });
  await db.tenancy.deleteMany({ where: org });
  await db.landlordTenancy.deleteMany({ where: org });
  await db.listing.deleteMany({ where: org });
  await db.apartment.deleteMany({ where: org });
  await db.property.deleteMany({ where: org });
  await db.auditLog.deleteMany({ where: org });
  await db.user.deleteMany({ where: { id: USER } });
  await db.party.deleteMany({ where: org });
  await db.organization.deleteMany({ where: { id: ORG } });
}

// ─── Seed ─────────────────────────────────────────────────────────────────────
async function seed() {
  const db = getDb();

  await db.organization.create({
    data: {
      id: ORG, name: "Fanout Org", slug: "fanout-org",
      status: "active", defaultCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free",
    },
  });
  await db.party.create({ data: { id: PARTY_OP, organizationId: ORG, displayName: "Fanout Op", partyType: "individual", status: "active" } });
  await db.user.create({ data: { id: USER, organizationId: ORG, email: "fanout-op@example.com", fullName: "Fanout Op", status: "active", role: "admin", userType: "operator", partyId: PARTY_OP } });
  await db.party.create({ data: { id: OWNER, organizationId: ORG, displayName: "Fanout Owner", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: TENANT, organizationId: ORG, displayName: "Fanout Tenant", partyType: "individual", status: "active" } });
  await db.property.create({
    data: {
      id: PROPERTY, organizationId: ORG, name: "Fanout Residences",
      propertyCode: "FAN1", propertyType: "apartment",
      addressLine1: "1 Fanout St", city: "KL", country: "MY",
      status: "active", publishStatus: "draft",
    },
  });

  await db.apartment.create({ data: { id: APT1, organizationId: ORG, propertyId: PROPERTY, unitCode: "F-01-01", listingMode: "WHOLE" } });
  await db.listing.create({ data: { id: LISTING1, organizationId: ORG, apartmentId: APT1, listingType: "unit", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER } });

  await db.tenancy.create({
    data: {
      id: TENANCY1, organizationId: ORG, propertyId: PROPERTY, unitId: LISTING1,
      tenantPartyId: TENANT, tenancyCode: "FAN-T1", status: "active",
      billingStatus: "current", startDate: new Date("2025-01-01T00:00:00.000Z"),
      monthlyRentAmount: "2000.00",
    },
  });

  // ManagementFeeConfig — 10% + 8% SST (active, all-properties).
  await db.managementFeeConfig.create({
    data: {
      organizationId: ORG, ownerPartyId: OWNER, propertyId: null,
      feeType: "percent", feeValue: "10.00", capAmount: null,
      sstPercent: "8.00", isActive: true,
    },
  });

  // Income ledger row — RM2000 rental income for MONTH.
  await db.ownerLedgerEntry.create({
    data: {
      organizationId: ORG, ownerPartyId: OWNER,
      propertyId: PROPERTY, apartmentId: APT1, listingId: LISTING1,
      statementMonth: MONTH_START, transactionDate: MID_MONTH,
      direction: "income", category: "rental_income",
      description: "Sep rent APT1", amount: "2000.00", sstAmount: null,
      paidBy: "tenant", paymentStatus: "paid", taxCategory: "exempt",
      includeInPayout: true, status: "active",
      sourceType: "manual", createdById: USER, updatedById: USER,
    },
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────
dn("fee-config fan-out trigger — updateFeeConfigService re-materializes UnitMonthLedger", () => {
  // Fan-out materialization is gated on ENABLE_UNIT_MONTH_LEDGER; enable for this
  // file and clear afterward (sequential integration run shares one process).
  beforeAll(() => {
    process.env.ENABLE_UNIT_MONTH_LEDGER = "true";
  });

  afterAll(async () => {
    delete process.env.ENABLE_UNIT_MONTH_LEDGER;
    await cleanup();
  });

  it("mgmtFeeC changes after updateFeeConfigService updates the fee rate", async () => {
    await cleanup();
    await seed();
    const db = getDb();

    // Step 1: baseline materialization at 10% fee.
    await materializeOwnerUnitMonths(billingCtx, OWNER, MONTH);

    const before = await db.unitMonthLedger.findFirst({
      where: { organizationId: ORG, apartmentId: APT1, periodMonth: MONTH_START },
    });
    expect(before).not.toBeNull();
    expect(before!.mgmtFeeC).toBeGreaterThan(0);

    // Step 2: fetch the fee config to get expectedUpdatedAt.
    const feeConfig = await db.managementFeeConfig.findFirst({
      where: { organizationId: ORG, ownerPartyId: OWNER },
    });
    expect(feeConfig).not.toBeNull();

    // Step 3: update the fee rate to 20% — the trigger should re-materialize.
    const updateResult = await updateFeeConfigService(billingCtx, feeConfig!.id, {
      feeValue: "20",
      expectedUpdatedAt: feeConfig!.updatedAt.toISOString(),
    });
    expect(updateResult.ok).toBe(true);

    // Step 4: the UnitMonthLedger row should reflect the new 20% fee.
    const after = await db.unitMonthLedger.findFirst({
      where: { organizationId: ORG, apartmentId: APT1, periodMonth: MONTH_START },
    });
    expect(after).not.toBeNull();

    // The mgmtFeeC must have changed (20% > 10% on same income base).
    expect(after!.mgmtFeeC).not.toBe(before!.mgmtFeeC);
  });
});
