/**
 * Unpaired tenant utility carve-outs must not inflate the owner's payout.
 *
 * Reproduces the reported statement: a WHOLE unit whose tenant was billed 754.00 of
 * utilities through the bills grid. The grid never writes a UnitUtilityBill (its
 * HARD CONSTRAINT 2), so Source 3 cannot book the offsetting full-bill expense and
 * the gross pair is permanently half-formed. Before the fix the ledger reported
 * Gross Rental 754 / Expenses 0 / Net Payout 754 — KAEN was told to remit the owner
 * money it had collected in order to pay TNB and Air Selangor.
 *
 * The three cases below pin the fix AND its two guards: PARTITIONED units and
 * genuinely paired carve-outs must behave exactly as they did before.
 *
 * Real LOCAL Postgres; opt-in via RUN_INTEGRATION=1. Disjoint fixed UUIDs (0d..cN).
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getDb } from "@kason/db";
import { summarizeOwnerPeriod, computeOwnerRunningBalance } from "@kason/shared";
import type { OwnerLedgerLine } from "@kason/shared";
import { syncMonthService } from "../owner-ledger.sync";
import type { OwnerLedgerActorCtx } from "../owner-ledger.types";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

const ORG = "0d000000-0000-4000-8000-0000000000c1";
const USER = "0d000000-0000-4000-8000-0000000000c2";
const PARTY = "0d000000-0000-4000-8000-0000000000c3";
const OWNER = "0d000000-0000-4000-8000-0000000000c4";
const TENANT = "0d000000-0000-4000-8000-0000000000c5";
const PROPERTY = "0d000000-0000-4000-8000-0000000000c6";
const APARTMENT = "0d000000-0000-4000-8000-0000000000c7";
const UNIT = "0d000000-0000-4000-8000-0000000000c8";
const TENANCY = "0d000000-0000-4000-8000-0000000000c9";

const MONTH = "2026-07";
const MONTH_START = new Date(Date.UTC(2026, 6, 1));

/** The five "Shared Utility" rows from the reported statement — 754.00 total. */
const TENANT_UTILITIES = ["300.00", "100.00", "134.00", "100.00", "120.00"];

const ctx: OwnerLedgerActorCtx = {
  orgId: ORG, actorUserId: USER, actorRole: "admin", ip: "127.0.0.1", userAgent: "vitest",
};

async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  await db.ownerLedgerEntry.deleteMany({ where: org });
  await db.utilityAllocation.deleteMany({ where: org });
  await db.charge.deleteMany({ where: org });
  await db.invoice.deleteMany({ where: org });
  await db.unitUtilityBill.deleteMany({ where: org });
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

/**
 * Seed one owner-month:
 *   • rent Charge 1800 fully paid                 → Source 1 income (the owner's real money)
 *   • five tenant utility Charges totalling 754   → Source 4 carve-out income
 *   • NO UnitUtilityBill unless `withChargedBill` → Source 3 has nothing to book
 */
async function seed(listingMode: "WHOLE" | "PARTITIONED", withChargedBill = false) {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG, name: "OL PT Org", slug: "ol-pt-org", status: "active",
      defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free",
    },
  });
  await db.party.create({ data: { id: PARTY, organizationId: ORG, displayName: "OL PT Operator", partyType: "individual", status: "active" } });
  await db.user.create({
    data: { id: USER, organizationId: ORG, email: "ol-pt-operator@example.com", fullName: "OL PT Operator", status: "active", role: "admin", userType: "operator", partyId: PARTY },
  });
  await db.party.create({ data: { id: OWNER, organizationId: ORG, displayName: "OL PT Owner", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: TENANT, organizationId: ORG, displayName: "OL PT Tenant", partyType: "individual", status: "active" } });
  await db.property.create({
    data: { id: PROPERTY, organizationId: ORG, name: "OL PT Property", propertyCode: "OL-PT-P1", propertyType: "apartment", addressLine1: "1 PT St", city: "KL", country: "MY", status: "active", publishStatus: "draft" },
  });
  await db.apartment.create({ data: { id: APARTMENT, organizationId: ORG, propertyId: PROPERTY, unitCode: "A-01", listingMode } });
  await db.listing.create({
    data: { id: UNIT, organizationId: ORG, apartmentId: APARTMENT, listingType: listingMode === "WHOLE" ? "whole_unit" : "room", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER },
  });
  await db.tenancy.create({
    data: { id: TENANCY, organizationId: ORG, propertyId: PROPERTY, unitId: UNIT, tenantPartyId: TENANT, tenancyCode: "OL-PT-T1", status: "active", billingStatus: "current", startDate: new Date("2026-01-01T00:00:00.000Z"), monthlyRentAmount: "1800" },
  });

  await db.charge.create({
    data: { organizationId: ORG, chargeNumber: "OL-PT-RENT-1", tenancyId: TENANCY, unitId: UNIT, partyId: TENANT, chargeType: "rent", status: "paid", dueDate: new Date(Date.UTC(2026, 6, 5)), amount: "1800.00", currency: "MYR", outstandingAmount: "0.00" },
  });

  for (const [i, amount] of TENANT_UTILITIES.entries()) {
    await db.charge.create({
      data: { organizationId: ORG, chargeNumber: `OL-PT-UTIL-${i + 1}`, tenancyId: TENANCY, unitId: UNIT, partyId: TENANT, chargeType: "utility", status: "paid", dueDate: new Date(Date.UTC(2026, 6, 10)), amount, currency: "MYR", outstandingAmount: "0.00" },
    });
  }

  if (withChargedBill) {
    // The legacy meter path: a CHARGED supplier bill exists, so Source 3 books the
    // full amount as an expense and the carve-out income is a genuine offset.
    await db.unitUtilityBill.create({
      data: {
        organizationId: ORG, apartmentId: APARTMENT, periodMonth: MONTH_START, billingMode: "whole",
        tnbTotal: "600.00", airSelangor: "154.00", indahWater: "0.00", cleaning: "0.00",
        status: "charged", createdBy: USER,
      },
    });
  }
}

const toLines = (rows: Array<{ direction: string; category: string; amount: { toString(): string }; sstAmount: { toString(): string } | null; includeInPayout: boolean; taxCategory: string }>): OwnerLedgerLine[] =>
  rows.map((e) => ({
    direction: e.direction as "income" | "expense" | "payout",
    category: e.category,
    amount: e.amount.toString(),
    sstAmount: e.sstAmount != null ? e.sstAmount.toString() : null,
    includeInPayout: e.includeInPayout,
    taxCategory: e.taxCategory,
  }));

dn("owner-ledger sync — unpaired tenant utility carve-outs (pass-through)", () => {
  beforeEach(async () => { await cleanup(); });
  afterAll(async () => { await cleanup(); });

  it("WHOLE unit, no supplier bill → 754 stays visible but leaves the payout untouched", async () => {
    await seed("WHOLE");
    const db = getDb();
    const res = await syncMonthService(ctx, { ownerPartyId: OWNER, month: MONTH });
    expect(res.ok).toBe(true);

    const rows = await db.ownerLedgerEntry.findMany({ where: { organizationId: ORG, status: "active" } });

    // The rows are still there — the owner must be able to see what their tenant paid.
    const carveOuts = rows.filter((r) => r.sourceType === "tenant_utility");
    expect(carveOuts, "all five utility rows are still booked").toHaveLength(5);
    expect(carveOuts.every((r) => r.includeInPayout === false), "every unpaired carve-out is pass-through").toBe(true);

    const s = summarizeOwnerPeriod(toLines(rows));
    expect(s.grossRental, "only the rent is the owner's income").toBe("1800.00");
    expect(s.passThroughIncome, "the tenant's utilities are reported separately").toBe("754.00");
    // Before the fix this read 2554.00 — the owner would have been paid the tenant's
    // utility money on top of their rent.
    expect(s.netPayoutToOwner).toBe("1800.00");

    // The balance KAEN actually remits must agree with the statement, or the cash
    // paid would differ from the document.
    expect(computeOwnerRunningBalance(toLines(rows))).toBe("1800.00");
  });

  it("PARTITIONED unit is untouched — same data still books the carve-out as payout income", async () => {
    await seed("PARTITIONED");
    const db = getDb();
    await syncMonthService(ctx, { ownerPartyId: OWNER, month: MONTH });
    const rows = await db.ownerLedgerEntry.findMany({ where: { organizationId: ORG, status: "active" } });

    const carveOuts = rows.filter((r) => r.sourceType === "tenant_utility");
    expect(carveOuts).toHaveLength(5);
    expect(carveOuts.every((r) => r.includeInPayout === true), "partitioned keeps today's behaviour").toBe(true);

    const s = summarizeOwnerPeriod(toLines(rows));
    expect(s.grossRental).toBe("2554.00"); // 1800 + 754, exactly as before the change
    expect(s.passThroughIncome).toBe("0.00");
  });

  it("WHOLE unit WITH a charged supplier bill → carve-out still offsets the full bill", async () => {
    // The guard against the opposite money bug: drop the income half here and the
    // owner is deducted the entire 754 supplier bill their tenant already paid.
    await seed("WHOLE", true);
    const db = getDb();
    await syncMonthService(ctx, { ownerPartyId: OWNER, month: MONTH });
    const rows = await db.ownerLedgerEntry.findMany({ where: { organizationId: ORG, status: "active" } });

    const carveOuts = rows.filter((r) => r.sourceType === "tenant_utility");
    expect(carveOuts.every((r) => r.includeInPayout === true), "a paired carve-out stays in the payout").toBe(true);

    const s = summarizeOwnerPeriod(toLines(rows));
    expect(s.grossRental).toBe("2554.00");            // rent 1800 + carve-out 754
    expect(s.totalExpenses).toBe("754.00");           // full bill 600 + 154
    expect(s.netPayoutToOwner).toBe("1800.00");       // the pair nets to zero — owner keeps their rent
    expect(s.passThroughIncome).toBe("0.00");
  });
});
