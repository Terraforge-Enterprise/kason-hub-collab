/**
 * Task 7: reconcile-unit-month-ledger cron — drift detection integration test.
 *
 * Verifies that a drifted UnitMonthLedger row (wrong netPayoutC, untouched
 * sourceMaxUpdatedAt) is detected by the reconciliation cron, corrected via
 * materializeOwnerUnitMonths, and marked with an owner_ledger.figure_drift
 * AuditLog entry.
 *
 * Real LOCAL Postgres; opt-in via RUN_INTEGRATION=1. Disjoint fixed UUIDs (fb..).
 */
import { describe, it, expect, afterAll } from "vitest";
import { getDb } from "@kason/db";
import { materializeOwnerUnitMonths } from "../unit-month-ledger.materialize";
import type { OwnerBillingActorCtx } from "../../owner-billing/owner-billing.types";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(
      `Refusing to run integration tests against non-local DB host: ${host}`,
    );
  }
}

// ─── Fixed UUIDs — prefix fb (unique to this test file, all-hex) ─────────────
const ORG      = "fb000000-0000-4000-8000-000000000001";
const USER     = "fb000000-0000-4000-8000-000000000002";
const PARTY_OP = "fb000000-0000-4000-8000-000000000003";
const OWNER    = "fb000000-0000-4000-8000-000000000004";
const TENANT   = "fb000000-0000-4000-8000-000000000005";
const PROPERTY = "fb000000-0000-4000-8000-000000000006";

const APT1     = "fb000000-0000-4000-8000-0000000000a1";
const APT2     = "fb000000-0000-4000-8000-0000000000b1";

const LISTING1 = "fb000000-0000-4000-8000-0000000000a2";
const LISTING2 = "fb000000-0000-4000-8000-0000000000b2";

const TENANCY1 = "fb000000-0000-4000-8000-0000000000a3";
const TENANCY2 = "fb000000-0000-4000-8000-0000000000b3";

const MONTH       = "2025-08";
const MONTH_START = new Date(Date.UTC(2025, 7, 1)); // 2025-08-01T00:00:00Z
const MID_MONTH   = new Date(Date.UTC(2025, 7, 15));

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
      id: ORG, name: "Reconcile Org", slug: "reconcile-org",
      status: "active", defaultCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free",
    },
  });
  await db.party.create({
    data: {
      id: PARTY_OP, organizationId: ORG,
      displayName: "Reconcile Op", partyType: "individual", status: "active",
    },
  });
  await db.user.create({
    data: {
      id: USER, organizationId: ORG, email: "reconcile-op@example.com",
      fullName: "Reconcile Op", status: "active", role: "admin",
      userType: "operator", partyId: PARTY_OP,
    },
  });
  await db.party.create({
    data: {
      id: OWNER, organizationId: ORG,
      displayName: "Reconcile Owner", partyType: "individual", status: "active",
    },
  });
  await db.party.create({
    data: {
      id: TENANT, organizationId: ORG,
      displayName: "Reconcile Tenant", partyType: "individual", status: "active",
    },
  });
  await db.property.create({
    data: {
      id: PROPERTY, organizationId: ORG, name: "Reconcile Residences",
      propertyCode: "REC1", propertyType: "apartment",
      addressLine1: "7 Reconcile St", city: "KL", country: "MY",
      status: "active", publishStatus: "draft",
    },
  });

  await db.apartment.create({
    data: {
      id: APT1, organizationId: ORG, propertyId: PROPERTY,
      unitCode: "R-07-01", listingMode: "WHOLE",
    },
  });
  await db.apartment.create({
    data: {
      id: APT2, organizationId: ORG, propertyId: PROPERTY,
      unitCode: "R-07-02", listingMode: "WHOLE",
    },
  });
  await db.listing.create({
    data: {
      id: LISTING1, organizationId: ORG, apartmentId: APT1,
      listingType: "unit", occupancyStatus: "occupied", listingStatus: "active",
      currency: "MYR", ownerPartyId: OWNER,
    },
  });
  await db.listing.create({
    data: {
      id: LISTING2, organizationId: ORG, apartmentId: APT2,
      listingType: "unit", occupancyStatus: "occupied", listingStatus: "active",
      currency: "MYR", ownerPartyId: OWNER,
    },
  });

  await db.tenancy.create({
    data: {
      id: TENANCY1, organizationId: ORG, propertyId: PROPERTY,
      unitId: LISTING1, tenantPartyId: TENANT, tenancyCode: "REC-T1",
      status: "active", billingStatus: "current",
      startDate: new Date("2025-01-01T00:00:00.000Z"),
      monthlyRentAmount: "1500.00",
    },
  });
  await db.tenancy.create({
    data: {
      id: TENANCY2, organizationId: ORG, propertyId: PROPERTY,
      unitId: LISTING2, tenantPartyId: TENANT, tenancyCode: "REC-T2",
      status: "active", billingStatus: "current",
      startDate: new Date("2025-01-01T00:00:00.000Z"),
      monthlyRentAmount: "900.00",
    },
  });

  await db.managementFeeConfig.create({
    data: {
      organizationId: ORG, ownerPartyId: OWNER, propertyId: null,
      feeType: "percent", feeValue: "10.00", capAmount: null,
      sstPercent: "8.00", isActive: true,
    },
  });

  // OwnerLedgerEntry rows for APT1 — income 1500, expense 200.
  await db.ownerLedgerEntry.create({
    data: {
      organizationId: ORG, ownerPartyId: OWNER,
      propertyId: PROPERTY, apartmentId: APT1, listingId: LISTING1,
      statementMonth: MONTH_START, transactionDate: MID_MONTH,
      direction: "income", category: "rental_income",
      description: "Aug rent APT1", amount: "1500.00", sstAmount: null,
      paidBy: "tenant", paymentStatus: "paid", taxCategory: "exempt",
      includeInPayout: true, status: "active",
      sourceType: "manual", createdById: USER, updatedById: USER,
    },
  });
  await db.ownerLedgerEntry.create({
    data: {
      organizationId: ORG, ownerPartyId: OWNER,
      propertyId: PROPERTY, apartmentId: APT1, listingId: LISTING1,
      statementMonth: MONTH_START, transactionDate: MID_MONTH,
      direction: "expense", category: "maintenance",
      description: "Aug maintenance APT1", amount: "200.00", sstAmount: null,
      paidBy: "owner", paymentStatus: "paid", taxCategory: "exempt",
      includeInPayout: true, status: "active",
      sourceType: "manual", createdById: USER, updatedById: USER,
    },
  });

  // OwnerLedgerEntry rows for APT2 — income 900 only.
  await db.ownerLedgerEntry.create({
    data: {
      organizationId: ORG, ownerPartyId: OWNER,
      propertyId: PROPERTY, apartmentId: APT2, listingId: LISTING2,
      statementMonth: MONTH_START, transactionDate: MID_MONTH,
      direction: "income", category: "rental_income",
      description: "Aug rent APT2", amount: "900.00", sstAmount: null,
      paidBy: "tenant", paymentStatus: "paid", taxCategory: "exempt",
      includeInPayout: true, status: "active",
      sourceType: "manual", createdById: USER, updatedById: USER,
    },
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────
dn("reconcile-unit-month-ledger cron — drift detection", () => {
  afterAll(async () => {
    await cleanup();
  });

  it("reconcile fixes a drifted row and records a figure_drift audit", async () => {
    await cleanup();
    await seed();
    const db = getDb();

    // Baseline materialization.
    await materializeOwnerUnitMonths(billingCtx, OWNER, MONTH);

    // Inject a wrong netPayoutC WITHOUT bumping sourceMaxUpdatedAt.
    // The monotonic guard in materializeOwnerUnitMonths checks sourceMaxUpdatedAt;
    // leaving it unchanged means the recompute's equal-or-newer watermark still
    // overwrites the corrupted value, allowing drift detection.
    await db.unitMonthLedger.update({
      where: {
        organizationId_apartmentId_periodMonth: {
          organizationId: ORG,
          apartmentId: APT1,
          periodMonth: MONTH_START,
        },
      },
      data: { netPayoutC: 999999 },
    });

    // Enable the flag so the cron runs (not a no-op).
    const prevFlag = process.env.ENABLE_UNIT_MONTH_LEDGER;
    process.env.ENABLE_UNIT_MONTH_LEDGER = "true";

    try {
      const { runReconcileUnitMonthLedgerCron } = await import(
        "../../../cron/reconcile-unit-month-ledger"
      );
      // now = 2025-08-15 → months include 2025-08-01 (MONTH_START).
      const r = await runReconcileUnitMonthLedgerCron(
        new Date(Date.UTC(2025, 7, 15)),
      );

      expect(r.fixed).toBeGreaterThanOrEqual(1);

      const fixed = await db.unitMonthLedger.findFirst({
        where: {
          organizationId: ORG,
          apartmentId: APT1,
          periodMonth: MONTH_START,
        },
      });
      expect(fixed!.netPayoutC).not.toBe(999999);

      const audit = await db.auditLog.findFirst({
        where: { organizationId: ORG, action: "owner_ledger.figure_drift" },
      });
      expect(audit).not.toBeNull();
    } finally {
      process.env.ENABLE_UNIT_MONTH_LEDGER = prevFlag ?? "";
    }
  });
});
