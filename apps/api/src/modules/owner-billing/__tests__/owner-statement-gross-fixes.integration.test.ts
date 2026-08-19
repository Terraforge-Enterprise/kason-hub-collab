/**
 * Fix-wave C-A — gross owner-statement money-math corrections (END-TO-END, TDD).
 *
 * Seeds a minimal owner-month, runs the REAL owner-ledger sync, then assembles the
 * statement and asserts the three deep-review fixes:
 *
 *   FIX 1 (CRITICAL): config cleaning (RM100) is a Source-2 PAYOUT charge again
 *     (includeInPayout:true) — NOT a Source-3 `utility_cleaning` row, NOT display-only.
 *     A statement with rent + RM100 cleaning DEDUCTS the 100 (owner NOT overpaid).
 *   FIX 2: the per-income-line mgmt fee resolves the config that applies to THAT
 *     line's property — a property-specific config OVERRIDES the all-properties one
 *     (Postgres `DESC` sorts NULLS FIRST, so a single findFirst wrongly picked the
 *     all-properties config).
 *   FIX 3: §5 lists each owner-relevant expense ONCE — the Source-2 utility twin is no
 *     longer materialized (Approach B), so it cannot double-list alongside the FULL
 *     Source-3 bill (no inflated total / owner-paid memo).
 *
 * Real LOCAL Postgres; opt-in via RUN_INTEGRATION=1. Disjoint fixed UUIDs (0f..).
 */
import { describe, it, expect, afterAll } from "vitest";
import { getDb } from "@kason/db";
import { syncMonthService } from "../../owner-ledger/owner-ledger.sync";
import { assembleYannieStatement } from "../owner-statement-sections";
import type { OwnerBillingActorCtx } from "../owner-billing.types";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

const ORG = "0f000000-0000-4000-8000-0000000000a1";
const USER = "0f000000-0000-4000-8000-0000000000a2";
const PARTY = "0f000000-0000-4000-8000-0000000000a3";
const OWNER = "0f000000-0000-4000-8000-0000000000a4";
const TENANT = "0f000000-0000-4000-8000-0000000000a5";
const PROPERTY = "0f000000-0000-4000-8000-0000000000a6";
const APARTMENT = "0f000000-0000-4000-8000-0000000000a7";
const UNIT = "0f000000-0000-4000-8000-0000000000a8";
const TENANCY = "0f000000-0000-4000-8000-0000000000a9";

const MONTH = "2026-06";
const MONTH_START = new Date(Date.UTC(2026, 5, 1));

const ledgerCtx = {
  orgId: ORG,
  actorUserId: USER,
  actorRole: "admin" as const,
  ip: "127.0.0.1",
  userAgent: "vitest",
};
const ctx: OwnerBillingActorCtx = { orgId: ORG, actorUserId: USER, actorRole: "admin" };

async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  await db.ownerLedgerEntry.deleteMany({ where: org });
  await db.deposit.deleteMany({ where: org });
  await db.utilityAllocation.deleteMany({ where: org });
  await db.charge.deleteMany({ where: org });
  await db.invoice.deleteMany({ where: org });
  await db.unitUtilityBill.deleteMany({ where: org });
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

type SeedOpts = {
  rent?: string;
  rentStatus?: string;
  rentOutstanding?: string;
  cleaningCharge?: string; // Source-2 cleaning charge on the owner_statement invoice
  statementUtilityCharges?: Array<{ chargeType: string; amount: string }>; // Source-2 display-only
  utilityBill?: {
    tnbTotal?: string;
    airSelangor?: string;
    indahWater?: string;
    cleaning?: string;
    wifi?: string;
  };
  configs?: Array<{ propertyId: string | null; feeValue: string; sstPercent?: string }>;
};

/** Seed one owner with a single occupied unit + an owner_statement invoice. */
async function seed(opts: SeedOpts = {}): Promise<{ invoiceId: string }> {
  const db = getDb();
  await db.organization.create({
    data: { id: ORG, name: "FixWave Org", slug: "fixwave-org", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" },
  });
  await db.party.create({ data: { id: PARTY, organizationId: ORG, displayName: "FixWave Operator", partyType: "individual", status: "active" } });
  await db.user.create({ data: { id: USER, organizationId: ORG, email: "fixwave-op@example.com", fullName: "FixWave Operator", status: "active", role: "admin", userType: "operator", partyId: PARTY } });
  await db.party.create({ data: { id: OWNER, organizationId: ORG, displayName: "FixWave Owner", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: TENANT, organizationId: ORG, displayName: "FixWave Tenant", partyType: "individual", status: "active" } });
  await db.property.create({ data: { id: PROPERTY, organizationId: ORG, name: "FixWave Property", propertyCode: "FW-P1", propertyType: "apartment", addressLine1: "1 FixWave St", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
  await db.apartment.create({ data: { id: APARTMENT, organizationId: ORG, propertyId: PROPERTY, unitCode: "FW-1", listingMode: "PARTITIONED" } });
  await db.listing.create({ data: { id: UNIT, organizationId: ORG, apartmentId: APARTMENT, listingType: "room", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER } });
  await db.tenancy.create({ data: { id: TENANCY, organizationId: ORG, propertyId: PROPERTY, unitId: UNIT, tenantPartyId: TENANT, tenancyCode: "FW-T1", status: "active", billingStatus: "current", startDate: new Date("2026-01-01T00:00:00.000Z"), monthlyRentAmount: opts.rent ?? "1000.00" } });

  // Source 1: rent charge (collected = amount − outstanding).
  await db.charge.create({
    data: { organizationId: ORG, chargeNumber: "FW-RENT-1", tenancyId: TENANCY, unitId: UNIT, partyId: TENANT, chargeType: "rent", status: opts.rentStatus ?? "paid", dueDate: new Date(Date.UTC(2026, 5, 5)), amount: opts.rent ?? "1000.00", currency: "MYR", outstandingAmount: opts.rentOutstanding ?? "0.00" },
  });

  // owner_statement Invoice (required by assembleYannieStatement).
  const invoice = await db.invoice.create({
    data: { organizationId: ORG, invoiceNumber: "OS-2026-06-FIXWAVE", partyId: OWNER, ownerPartyId: OWNER, propertyId: PROPERTY, invoiceType: "owner_statement", status: "draft", invoiceDate: MONTH_START, periodMonth: MONTH_START, totalAmount: "0.00", sstAmount: "0.00", currency: "MYR", idempotencyKey: `owner:${OWNER}:${MONTH}` },
  });

  // Source 2: config cleaning charge (the RM100 auto-bill path).
  if (opts.cleaningCharge) {
    await db.charge.create({
      data: { organizationId: ORG, chargeNumber: "FW-STMT-CLEAN", unitId: UNIT, partyId: OWNER, chargeType: "cleaning", status: "posted", dueDate: MONTH_START, amount: opts.cleaningCharge, currency: "MYR", outstandingAmount: opts.cleaningCharge, invoiceId: invoice.id, billingMonth: MONTH_START },
    });
  }

  // Source 2: display-only owner-borne utility statement lines (PART-4 auto-feed).
  for (const [i, u] of (opts.statementUtilityCharges ?? []).entries()) {
    await db.charge.create({
      data: { organizationId: ORG, chargeNumber: `FW-STMT-UTIL-${i}`, unitId: UNIT, partyId: OWNER, chargeType: u.chargeType, status: "posted", dueDate: MONTH_START, amount: u.amount, currency: "MYR", outstandingAmount: u.amount, invoiceId: invoice.id, billingMonth: MONTH_START },
    });
  }

  // Source 3: full per-category supplier bill.
  if (opts.utilityBill) {
    await db.unitUtilityBill.create({
      data: { organizationId: ORG, apartmentId: APARTMENT, periodMonth: MONTH_START, billingMode: "subsidy", tnbTotal: opts.utilityBill.tnbTotal ?? "0.00", airSelangor: opts.utilityBill.airSelangor ?? "0.00", indahWater: opts.utilityBill.indahWater ?? "0.00", cleaning: opts.utilityBill.cleaning ?? "0.00", wifi: opts.utilityBill.wifi ?? "0.00", ownerBorneUtilitiesTotal: "0.00", status: "charged", createdBy: USER },
    });
  }

  // ManagementFeeConfig rows (property-specific and/or all-properties).
  for (const c of opts.configs ?? []) {
    await db.managementFeeConfig.create({
      data: { organizationId: ORG, ownerPartyId: OWNER, propertyId: c.propertyId, feeType: "percent", feeValue: c.feeValue, capAmount: null, sstPercent: c.sstPercent ?? "8.00", isActive: true },
    });
  }

  return { invoiceId: invoice.id };
}

const payoutLine = (s: NonNullable<Awaited<ReturnType<typeof assembleYannieStatement>>>, label: string) =>
  s.payoutSummary.lines.find((l) => l.label === label);

dn("owner statement — fix-wave C-A (gross money math)", () => {
  afterAll(async () => {
    await cleanup();
  });

  // ── FIX 1 (CRITICAL): config cleaning is deducted; owner NOT overpaid. ──
  it("FIX 1: config cleaning (RM100) is a Source-2 payout charge — deducted, no utility_cleaning row", async () => {
    await cleanup();
    // Rent 1000 + RM100 config cleaning; NO mgmt config (so no fee). A UnitUtilityBill
    // with cleaning=100 too, to PROVE Source 3 never books a `utility_cleaning` row.
    const { invoiceId } = await seed({
      rent: "1000.00",
      cleaningCharge: "100.00",
      utilityBill: { cleaning: "100.00" },
    });

    const sync = await syncMonthService(ledgerCtx, { ownerPartyId: OWNER, month: MONTH });
    expect(sync.ok).toBe(true);

    const db = getDb();
    const rows = await db.ownerLedgerEntry.findMany({ where: { organizationId: ORG } });

    // The Source-2 cleaning charge is a PAYOUT source (includeInPayout:true), not display-only.
    const cleaning = rows.find((r) => r.sourceType === "statement" && r.category === "cleaning");
    expect(cleaning, "Source-2 cleaning ledger row").toBeDefined();
    expect(cleaning!.includeInPayout, "config cleaning must be deducted from the payout").toBe(true);

    // There must be NO Source-3 utility_cleaning expense row (cleaning is not gross-sourced).
    expect(rows.filter((r) => r.sourceType === "utility_cleaning")).toHaveLength(0);

    const s = await assembleYannieStatement(ctx, invoiceId);
    expect(s).not.toBeNull();

    // Income 1000, expenses = cleaning 100 → Total Payout 900 (owner NOT overpaid by 100).
    expect(s!.incomeBreakdown.totalIncome).toBe("1000.00");
    expect(s!.expenseBreakdown.totalExpenses).toBe("100.00");
    const cleanExpense = s!.expenseBreakdown.rows.filter((r) => r.category === "Cleaning");
    expect(cleanExpense).toHaveLength(1);
    expect(cleanExpense[0]!.amount).toBe("100.00");
    expect(payoutLine(s!, "Total Payout to Owner")!.amount).toBe("900.00");
  });

  // ── FIX 2: property-specific config OVERRIDES all-properties (NULLS-LAST). ──
  it("FIX 2: per-line mgmt fee uses the property-specific config, not the all-properties one", async () => {
    await cleanup();
    // Two active configs: all-properties 10% and property-specific 5% for this property.
    const { invoiceId } = await seed({
      rent: "1000.00",
      configs: [
        { propertyId: null, feeValue: "10.00", sstPercent: "8.00" },
        { propertyId: PROPERTY, feeValue: "5.00", sstPercent: "8.00" },
      ],
    });

    const sync = await syncMonthService(ledgerCtx, { ownerPartyId: OWNER, month: MONTH });
    expect(sync.ok).toBe(true);

    const s = await assembleYannieStatement(ctx, invoiceId);
    expect(s).not.toBeNull();

    // 5% × 1000 = 50.00 base (+ 8% SST = 4.00) — the property-specific rate, NOT 10% (100.00).
    const row = s!.incomeBreakdown.rows.find((r) => r.incomeType === "Monthly")!;
    expect(row.mgmtFee).toBe("50.00");
    expect(row.mgmtFeeSst).toBe("4.00");
    expect(s!.incomeBreakdown.totalMgmtFee).toBe("54.00");
    // The single KAEN Service Fee expense uses the property-specific 54.00, not 108.00.
    const mgmtRows = s!.expenseBreakdown.rows.filter((r) => r.category === "Management Fee");
    expect(mgmtRows).toHaveLength(1);
    const feeCents = Math.round(parseFloat(mgmtRows[0]!.amount) * 100) + Math.round(parseFloat(mgmtRows[0]!.sstAmount) * 100);
    expect(feeCents).toBe(5400);
    // Total Payout = 1000 − 54 = 946.00.
    expect(payoutLine(s!, "Total Payout to Owner")!.amount).toBe("946.00");
  });

  // ── FIX 3: §5 lists each owner-relevant expense ONCE (no display-only twin). ──
  it("FIX 3: no Source-2 utility twin is materialized, so §5 lists each expense ONCE (no double-list, no inflated total)", async () => {
    await cleanup();
    // FULL Source-3 TNB bill 188.70 (deducted) + a display-only Source-2 owner-borne
    // tnb leftover 50.00 (includeInPayout:false). NO mgmt config.
    const { invoiceId } = await seed({
      rent: "1000.00",
      utilityBill: { tnbTotal: "188.70" },
      statementUtilityCharges: [{ chargeType: "tnb", amount: "50.00" }],
    });

    const sync = await syncMonthService(ledgerCtx, { ownerPartyId: OWNER, month: MONTH });
    expect(sync.ok).toBe(true);

    const db = getDb();
    const rows = await db.ownerLedgerEntry.findMany({ where: { organizationId: ORG } });
    // Approach B: the Source-2 tnb twin is NO LONGER materialized — the FULL Source-3
    // bill is the sole payout+display source, so §5 lists TNB exactly once (below).
    const displayOnly = rows.find((r) => r.sourceType === "statement" && r.category === "utilities_tnb");
    expect(displayOnly, "no Source-2 tnb twin should be materialized").toBeUndefined();

    const s = await assembleYannieStatement(ctx, invoiceId);
    expect(s).not.toBeNull();

    // §5 lists the TNB expense ONCE (the FULL Source-3 bill 188.70) — the 50.00
    // display-only twin must NOT appear.
    expect(s!.expenseBreakdown.rows.filter((r) => r.amount === "188.70")).toHaveLength(1);
    expect(s!.expenseBreakdown.rows.filter((r) => r.amount === "50.00")).toHaveLength(0);
    // Total expenses = 188.70 only (NOT 238.70 — no inflated total).
    expect(s!.expenseBreakdown.totalExpenses).toBe("188.70");
    // No spurious "Owner-paid expenses (not deducted)" memo (the twin no longer inflates it).
    expect(payoutLine(s!, "Owner-paid expenses (not deducted)")).toBeUndefined();
    // Total Payout is unaffected (the display-only row was never deductible): 1000 − 188.70.
    expect(payoutLine(s!, "Total Payout to Owner")!.amount).toBe("811.30");
  });
});
