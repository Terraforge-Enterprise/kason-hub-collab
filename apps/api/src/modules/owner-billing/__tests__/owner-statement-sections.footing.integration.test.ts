/**
 * C2 acceptance — the Yannie A-19-02 FOOTING test (END-TO-END).
 *
 * Seeds an A-19-02-like owner (4 room rent lines + a Studio aircond carve-out +
 * a Carpark entity + carpark Charge (Source 5) + a UnitUtilityBill of full
 * supplier bills + a Maintenance statement charge + a 10%/8%-SST
 * ManagementFeeConfig + Studio 1,960 deposit), runs the REAL owner-ledger sync
 * (C1 gross sourcing), then assembles the statement (C2 deposit-in-payout +
 * per-line mgmt fee) and asserts it FOOTS:
 *
 *   Income 3,201.13 + Deposit 1,960.00 − Expenses 1,119.25 = Total Payout 4,041.88
 *
 * Carpark income (120.00) flows via the ledger sync Source 5 (Carpark entity +
 * chargeType:"carpark" Charge), not via a Listing/Tenancy — unitKind is gone.
 *
 * Plus a COLLECTED-basis test: a partially-paid rent charge → income uses
 * collected (amount − outstanding); the unpaid portion is excluded.
 *
 * Real LOCAL Postgres; opt-in via RUN_INTEGRATION=1. Disjoint fixed UUIDs (0e..).
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
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

const ORG = "0e000000-0000-4000-8000-0000000000a1";
const USER = "0e000000-0000-4000-8000-0000000000a2";
const PARTY = "0e000000-0000-4000-8000-0000000000a3";
const OWNER = "0e000000-0000-4000-8000-0000000000a4";
const TENANT = "0e000000-0000-4000-8000-0000000000a5";
const PROPERTY = "0e000000-0000-4000-8000-0000000000a6";
// Four room Listings (Yannie A-19-02: partitioned rooms), one apartment each.
// CARPARK is now a Carpark entity ID (not a Listing), seeded inline in the first test.
const MASTER = "0e000000-0000-4000-8000-0000000000b1";
const STUDIO = "0e000000-0000-4000-8000-0000000000b2";
const MEDIUM = "0e000000-0000-4000-8000-0000000000b3";
const PARTITION = "0e000000-0000-4000-8000-0000000000b4";
const CARPARK = "0e000000-0000-4000-8000-0000000000b5";

const MONTH = "2026-06";
const MONTH_START = new Date(Date.UTC(2026, 5, 1));
const MID_MONTH = new Date(Date.UTC(2026, 5, 15)); // deposit createdAt inside the window

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
  await db.carpark.deleteMany({ where: org });
  await db.apartment.deleteMany({ where: org });
  await db.property.deleteMany({ where: org });
  await db.auditLog.deleteMany({ where: org });
  await db.user.deleteMany({ where: { id: USER } });
  await db.party.deleteMany({ where: org });
  await db.organization.deleteMany({ where: { id: ORG } });
}

type LineSpec = {
  id: string;
  rent: string;
  outstanding: string;
  status: string;
  aircond?: string; // optional aircond carve-out charge
  deposit?: string;
};

/** Seed A-19-02. `rentLines` lets the collected-basis test override amounts. */
async function seed(rentLines: LineSpec[]) {
  const db = getDb();
  await db.organization.create({
    data: { id: ORG, name: "Footing Org", slug: "footing-org", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" },
  });
  await db.party.create({ data: { id: PARTY, organizationId: ORG, displayName: "Footing Operator", partyType: "individual", status: "active" } });
  await db.user.create({ data: { id: USER, organizationId: ORG, email: "footing-op@example.com", fullName: "Footing Operator", status: "active", role: "admin", userType: "operator", partyId: PARTY } });
  await db.party.create({ data: { id: OWNER, organizationId: ORG, displayName: "A-19-02 Owner", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: TENANT, organizationId: ORG, displayName: "A-19-02 Tenant", partyType: "individual", status: "active" } });
  await db.property.create({ data: { id: PROPERTY, organizationId: ORG, name: "PV9 Residences", propertyCode: "PV9", propertyType: "apartment", addressLine1: "1 PV9 St", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });

  // One Apartment per listing (the schema's @@unique([apartmentId, listingType])
  // forbids multiple "room" listings under one apartment). The UnitUtilityBill is
  // booked on the FIRST apartment only — the gross expense is counted once
  // regardless of how the rooms map to apartments, so the footing is unchanged.
  let n = 0;
  for (const line of rentLines) {
    n += 1;
    const aptId = `0e000000-0000-4000-8000-0000000000d${n}`;
    await db.apartment.create({ data: { id: aptId, organizationId: ORG, propertyId: PROPERTY, unitCode: `A-19-0${n}`, listingMode: "PARTITIONED" } });
    await db.listing.create({
      data: { id: line.id, organizationId: ORG, apartmentId: aptId, listingType: "room", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER },
    });
    const tenancyId = `0e000000-0000-4000-8000-0000000000c${n}`;
    await db.tenancy.create({
      data: { id: tenancyId, organizationId: ORG, propertyId: PROPERTY, unitId: line.id, tenantPartyId: TENANT, tenancyCode: `A1902-T${n}`, status: "active", billingStatus: "current", startDate: new Date("2026-01-01T00:00:00.000Z"), monthlyRentAmount: line.rent },
    });
    await db.charge.create({
      data: { organizationId: ORG, chargeNumber: `A1902-RENT-${n}`, tenancyId, unitId: line.id, partyId: TENANT, chargeType: "rent", status: line.status, dueDate: new Date(Date.UTC(2026, 5, 5)), amount: line.rent, currency: "MYR", outstandingAmount: line.outstanding },
    });
    if (line.aircond) {
      await db.charge.create({
        data: { organizationId: ORG, chargeNumber: `A1902-AIRCOND-${n}`, tenancyId, unitId: line.id, partyId: TENANT, chargeType: "aircond", status: "paid", dueDate: new Date(Date.UTC(2026, 5, 5)), amount: line.aircond, currency: "MYR", outstandingAmount: "0.00", billingMonth: MONTH_START },
      });
    }
    if (line.deposit) {
      await db.deposit.create({
        data: { organizationId: ORG, tenancyId, partyId: TENANT, unitId: line.id, type: "security", amount: line.deposit, status: "held", createdAt: MID_MONTH },
      });
    }
  }

  // UnitUtilityBill — FULL supplier bills (owner-borne). tnb 188.70 / water 35.74 / wifi 200.
  // Booked on the first listing's apartment (0e..d1).
  await db.unitUtilityBill.create({
    data: { organizationId: ORG, apartmentId: "0e000000-0000-4000-8000-0000000000d1", periodMonth: MONTH_START, billingMode: "subsidy", tnbTotal: "188.70", airSelangor: "35.74", indahWater: "0.00", cleaning: "0.00", wifi: "200.00", ownerBorneUtilitiesTotal: "180.24", status: "charged", createdBy: USER },
  });

  // owner_statement Invoice (required by assembleYannieStatement) + a Maintenance charge (350).
  const invoice = await db.invoice.create({
    data: { organizationId: ORG, invoiceNumber: "OS-2026-06-A1902", partyId: OWNER, ownerPartyId: OWNER, propertyId: PROPERTY, invoiceType: "owner_statement", status: "draft", invoiceDate: MONTH_START, periodMonth: MONTH_START, totalAmount: "350.00", sstAmount: "0.00", currency: "MYR", idempotencyKey: `owner:${OWNER}:${MONTH}` },
  });
  await db.charge.create({
    data: { organizationId: ORG, chargeNumber: "A1902-MAINT", unitId: MASTER, partyId: OWNER, chargeType: "maintenance", status: "posted", dueDate: MONTH_START, amount: "350.00", currency: "MYR", outstandingAmount: "350.00", invoiceId: invoice.id, billingMonth: MONTH_START },
  });

  // ManagementFeeConfig — 10% + 8% SST.
  await db.managementFeeConfig.create({
    data: { organizationId: ORG, ownerPartyId: OWNER, propertyId: null, feeType: "percent", feeValue: "10.00", capAmount: null, sstPercent: "8.00", isActive: true },
  });

  return { invoiceId: invoice.id };
}

dn("assembleYannieStatement — A-19-02 footing (C2 end-to-end)", () => {
  afterAll(async () => {
    await cleanup();
  });

  it("foots to Total Payout 4,041.88 (gross income − full-bill expenses, per-line mgmt fee; carpark via Source 5)", async () => {
    await cleanup();
    const { invoiceId } = await seed([
      { id: MASTER, rent: "1000.00", outstanding: "0.00", status: "paid" },
      { id: STUDIO, rent: "522.67", outstanding: "0.00", status: "paid", aircond: "8.46", deposit: "1960.00" },
      { id: MEDIUM, rent: "800.00", outstanding: "0.00", status: "paid" },
      { id: PARTITION, rent: "750.00", outstanding: "0.00", status: "paid" },
    ]);

    // Carpark bay (new model): Carpark entity owned by OWNER + a carpark Charge with
    // carparkId set. Income flows through the ledger sync Source 5 (not a Listing/Tenancy).
    const db = getDb();
    await db.carpark.create({
      data: {
        id: CARPARK,
        organizationId: ORG,
        propertyId: PROPERTY,
        apartmentId: "0e000000-0000-4000-8000-0000000000d1", // MASTER's apartment
        ownerPartyId: OWNER,
        label: "P-01",
        monthlyRate: "120.00",
        status: "rented",
      },
    });
    await db.charge.create({
      data: {
        organizationId: ORG,
        chargeNumber: "A1902-CARPARK-1",
        carparkId: CARPARK,
        partyId: TENANT,
        chargeType: "carpark",
        status: "paid",
        dueDate: new Date(Date.UTC(2026, 5, 5)),
        amount: "120.00",
        currency: "MYR",
        outstandingAmount: "0.00",
      },
    });

    const sync = await syncMonthService(ledgerCtx, { ownerPartyId: OWNER, month: MONTH });
    expect(sync.ok).toBe(true);

    const s = await assembleYannieStatement(ctx, invoiceId);
    expect(s).not.toBeNull();

    // ── Income: gross 3,201.13 (5 rent + aircond carve-out). ──
    expect(s!.incomeBreakdown.totalIncome).toBe("3201.13");

    // ── Per-line mgmt fee (10% × 1.08; aircond = 0). ──
    const feeByAmount = new Map(s!.incomeBreakdown.rows.map((r) => [r.amount, `${r.mgmtFee}+${r.mgmtFeeSst}`]));
    expect(s!.incomeBreakdown.rows.find((r) => r.amount === "1000.00")!.mgmtFee).toBe("100.00");
    // Combined per-line fee (base + SST) for each line:
    const combined = (amount: string) => {
      const r = s!.incomeBreakdown.rows.find((x) => x.amount === amount)!;
      return (Math.round(parseFloat(r.mgmtFee) * 100) + Math.round(parseFloat(r.mgmtFeeSst) * 100)) / 100;
    };
    expect(combined("1000.00")).toBe(108.0);
    expect(combined("522.67")).toBe(56.45);
    expect(combined("800.00")).toBe(86.4);
    expect(combined("750.00")).toBe(81.0);
    expect(combined("120.00")).toBe(12.96);
    // Aircond carve-out (8.46) carries ZERO mgmt fee.
    const aircond = s!.incomeBreakdown.rows.find((r) => r.incomeType === "Aircond Fee")!;
    expect(aircond.amount).toBe("8.46");
    expect(aircond.mgmtFee).toBe("0.00");
    expect(aircond.mgmtFeeSst).toBe("0.00");
    expect(feeByAmount.get("8.46")).toBe("0.00+0.00");

    // Σ per-line mgmt fee.
    expect(s!.incomeBreakdown.totalMgmtFee).toBe("344.81");

    // ── Expenses: full bills + maintenance + KAEN fee = 1,119.25 (no double-count). ──
    expect(s!.expenseBreakdown.totalExpenses).toBe("1119.25");
    // Exactly ONE management-fee expense row (the single computed KAEN Service Fee).
    const mgmtRows = s!.expenseBreakdown.rows.filter((r) => r.category === "Management Fee");
    expect(mgmtRows).toHaveLength(1);
    expect((Math.round(parseFloat(mgmtRows[0]!.amount) * 100) + Math.round(parseFloat(mgmtRows[0]!.sstAmount) * 100)) / 100).toBe(344.81);
    // The FULL TNB bill (188.70) appears once — no double-counted utility expense.
    const tnbRows = s!.expenseBreakdown.rows.filter((r) => r.amount === "188.70");
    expect(tnbRows).toHaveLength(1);

    // ── Deposit collected this month = 1,960.00 (Studio only; carpark has no Listing
    //    deposit in the new model — income flows via Source 5 ledger sync). ──
    expect(s!.payoutSummary.depositCollected).toBe("1960.00");

    // ── THE FOOTING: Total Payout to Owner = 4,041.88
    //    (Income 3,201.13 + Deposit 1,960.00 − Expenses 1,119.25). ──
    const totalPayout = s!.payoutSummary.lines.find((l) => l.label === "Total Payout to Owner")!;
    expect(totalPayout.amount).toBe("4041.88");

    // Waterfall reconciles exactly in integer cents: GrossCashIn − Deductible = Total Payout.
    const cents = (x: string) => Math.round(parseFloat(x) * 100);
    const grossCashIn = s!.payoutSummary.lines.find((l) => l.label === "Gross Cash In")!;
    const deductible = s!.payoutSummary.lines.find((l) => l.label === "Less: Deductible Expenses")!;
    expect(cents(grossCashIn.amount) - cents(deductible.amount)).toBe(cents(totalPayout.amount));
    // Income 3,201.13 + Deposit 1,960.00 = Gross Cash In 5,161.13.
    expect(grossCashIn.amount).toBe("5161.13");
  });

  it("COLLECTED basis: a partially-paid rent uses (amount − outstanding); the unpaid portion is excluded", async () => {
    await cleanup();
    // Master billed 1000 but only 700 collected (outstanding 300, partially_paid).
    const { invoiceId } = await seed([
      { id: MASTER, rent: "1000.00", outstanding: "300.00", status: "partially_paid" },
    ]);
    const sync = await syncMonthService(ledgerCtx, { ownerPartyId: OWNER, month: MONTH });
    expect(sync.ok).toBe(true);

    const s = await assembleYannieStatement(ctx, invoiceId);
    expect(s).not.toBeNull();

    // Income = collected 700.00 (NOT the billed 1000.00).
    const masterRow = s!.incomeBreakdown.rows.find((r) => r.incomeType === "Monthly")!;
    expect(masterRow.amount).toBe("700.00");
    expect(masterRow.paymentStatus).toBe("partial");
    expect(s!.incomeBreakdown.totalIncome).toBe("700.00");

    // Per-line mgmt fee is computed on the COLLECTED amount: 10% × 700 = 70.00 (+5.60 SST).
    expect(masterRow.mgmtFee).toBe("70.00");
    expect(masterRow.mgmtFeeSst).toBe("5.60");
  });
});
