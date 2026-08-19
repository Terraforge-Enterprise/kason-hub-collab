/**
 * C1 — GROSS sync sourcing (full supplier bills as expense + tenant carve-outs as
 * payout income). Verifies the owner-ledger sync books Yannie's GROSS model:
 *
 *   • Source 3 books the FULL per-category UnitUtilityBill amounts as SEPARATE
 *     expense rows (tnbTotal→utilities_tnb, airSelangor→water, indahWater→
 *     indah_water, wifi→wifi), includeInPayout:true, with a per-category sourceType
 *     ("utility_<cat>") so the DB @@unique(org, sourceType, sourceUtilityBillId)
 *     admits one row per category WITHOUT a migration. CLEANING is NOT gross-sourced
 *     — config cleaning is a Source-2 payout charge (FIX 1).
 *   • Source 4 tenant carve-out income (aircond/utility) is includeInPayout:true,
 *     so it pairs with the full-bill expense and nets to the owner's real share.
 *   • Source 2 RECONCILIATION (Approach B): the owner_statement's utility child charges
 *     are NO LONGER materialized — the Source-3 full bill is the sole payout+display
 *     source per category. management_fee / maintenance / insurance / CLEANING / other
 *     non-gross-sourced categories still materialize and stay in the payout (Source 2).
 *
 * Real LOCAL Postgres; opt-in via RUN_INTEGRATION=1. Disjoint fixed UUIDs (0c..bN).
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getDb } from "@kason/db";
import { summarizeOwnerPeriod } from "@kason/shared";
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

const ORG = "0c000000-0000-4000-8000-0000000000b1";
const USER = "0c000000-0000-4000-8000-0000000000b2";
const PARTY = "0c000000-0000-4000-8000-0000000000b3";
const OWNER = "0c000000-0000-4000-8000-0000000000b4";
const TENANT = "0c000000-0000-4000-8000-0000000000b5";
const PROPERTY = "0c000000-0000-4000-8000-0000000000b6";
const APARTMENT = "0c000000-0000-4000-8000-0000000000b7";
const UNIT = "0c000000-0000-4000-8000-0000000000b8";
const TENANCY = "0c000000-0000-4000-8000-0000000000b9";

const MONTH = "2026-06";
const MONTH_START = new Date(Date.UTC(2026, 5, 1));

const ctx: OwnerLedgerActorCtx = {
  orgId: ORG,
  actorUserId: USER,
  actorRole: "admin",
  ip: "127.0.0.1",
  userAgent: "vitest",
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
 * Seed a gross-model owner-month:
 *  • rent Charge 1000 (paid → collected 1000)             → Source 1 income
 *  • aircond carve-out Charge 8.46 (paid)                  → Source 4 income
 *  • UnitUtilityBill: tnbTotal 188.70, airSelangor 35.74,
 *    indahWater 12.00, cleaning 100.00, wifi 200.00        → Source 3 full bills
 *    (cleaning is NOT gross-sourced — proves FIX 1 even when the bill has cleaning)
 *  • owner_statement Invoice (sst 16) with child charges:
 *      management_fee 200 (KEPT in payout)
 *      maintenance    350 (KEPT)
 *      cleaning       100 (KEPT — Source-2 config charge is cleaning's payout source)
 *      tnb  50 / wifi 30 / sewerage 12                     → Source 2 (NOT materialized, Approach B)
 */
async function seed() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG, name: "OL Gross Org", slug: "ol-gross-org", status: "active",
      defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free",
    },
  });
  await db.party.create({ data: { id: PARTY, organizationId: ORG, displayName: "OL Operator", partyType: "individual", status: "active" } });
  await db.user.create({
    data: { id: USER, organizationId: ORG, email: "ol-gross-operator@example.com", fullName: "OL Operator", status: "active", role: "admin", userType: "operator", partyId: PARTY },
  });
  await db.party.create({ data: { id: OWNER, organizationId: ORG, displayName: "OL Gross Owner", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: TENANT, organizationId: ORG, displayName: "OL Gross Tenant", partyType: "individual", status: "active" } });
  await db.property.create({
    data: { id: PROPERTY, organizationId: ORG, name: "OL Gross Property", propertyCode: "OL-GROSS-P1", propertyType: "apartment", addressLine1: "1 Gross St", city: "KL", country: "MY", status: "active", publishStatus: "draft" },
  });
  await db.apartment.create({ data: { id: APARTMENT, organizationId: ORG, propertyId: PROPERTY, unitCode: "A-1", listingMode: "PARTITIONED" } });
  await db.listing.create({
    data: { id: UNIT, organizationId: ORG, apartmentId: APARTMENT, listingType: "room", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER },
  });
  await db.tenancy.create({
    data: { id: TENANCY, organizationId: ORG, propertyId: PROPERTY, unitId: UNIT, tenantPartyId: TENANT, tenancyCode: "OL-GROSS-T1", status: "active", billingStatus: "current", startDate: new Date("2026-01-01T00:00:00.000Z"), monthlyRentAmount: "1000" },
  });

  // Source 1: rent Charge (fully paid → collected 1000).
  await db.charge.create({
    data: { organizationId: ORG, chargeNumber: "OL-GROSS-RENT-1", tenancyId: TENANCY, unitId: UNIT, partyId: TENANT, chargeType: "rent", status: "paid", dueDate: new Date(Date.UTC(2026, 5, 5)), amount: "1000.00", currency: "MYR", outstandingAmount: "0.00" },
  });

  // Source 4: aircond carve-out Charge (paid → collected 8.46).
  await db.charge.create({
    data: { organizationId: ORG, chargeNumber: "OL-GROSS-AIRCOND-1", tenancyId: TENANCY, unitId: UNIT, partyId: TENANT, chargeType: "aircond", status: "paid", dueDate: new Date(Date.UTC(2026, 5, 5)), amount: "8.46", currency: "MYR", outstandingAmount: "0.00" },
  });

  // Source 2: owner_statement with KEPT + display-only child charges.
  const invoice = await db.invoice.create({
    data: { organizationId: ORG, invoiceNumber: "OL-GROSS-INV-1", partyId: OWNER, ownerPartyId: OWNER, propertyId: PROPERTY, invoiceType: "owner_statement", status: "draft", invoiceDate: MONTH_START, periodMonth: MONTH_START, totalAmount: "0.00", sstAmount: "16.00", currency: "MYR", idempotencyKey: `owner:${OWNER}:${MONTH}` },
  });
  const stmtCharges: Array<{ n: string; t: string; amt: string }> = [
    { n: "OL-GROSS-STMT-MGMT", t: "management_fee", amt: "200.00" },
    { n: "OL-GROSS-STMT-MAINT", t: "maintenance", amt: "350.00" },
    { n: "OL-GROSS-STMT-TNB", t: "tnb", amt: "50.00" },
    { n: "OL-GROSS-STMT-WIFI", t: "wifi", amt: "30.00" },
    { n: "OL-GROSS-STMT-CLEAN", t: "cleaning", amt: "100.00" },
    { n: "OL-GROSS-STMT-SEWER", t: "sewerage", amt: "12.00" },
  ];
  for (const c of stmtCharges) {
    await db.charge.create({
      data: { organizationId: ORG, chargeNumber: c.n, unitId: UNIT, partyId: OWNER, chargeType: c.t, status: "draft", dueDate: MONTH_START, amount: c.amt, currency: "MYR", outstandingAmount: c.amt, invoiceId: invoice.id, billingMonth: MONTH_START },
    });
  }

  // Source 3: UnitUtilityBill with full per-category amounts.
  await db.unitUtilityBill.create({
    data: {
      organizationId: ORG, apartmentId: APARTMENT, periodMonth: MONTH_START, billingMode: "subsidy",
      tnbTotal: "188.70", airSelangor: "35.74", indahWater: "12.00", cleaning: "100.00", wifi: "200.00",
      ownerBorneUtilitiesTotal: "150.00", status: "charged", createdBy: USER,
    },
  });
}

dn("owner-ledger.sync — GROSS sourcing (C1)", () => {
  beforeEach(async () => {
    await cleanup();
    await seed();
  });
  afterAll(async () => {
    await cleanup();
  });

  it("Source 3 books the FULL per-category bills as separate payout expense rows", async () => {
    const db = getDb();
    const res = await syncMonthService(ctx, { ownerPartyId: OWNER, month: MONTH });
    expect(res.ok).toBe(true);

    const rows = await db.ownerLedgerEntry.findMany({ where: { organizationId: ORG } });

    // One expense row per non-zero UnitUtilityBill category, at the FULL amount.
    // CLEANING is NOT gross-sourced (FIX 1) even though the bill carries cleaning 100.
    const want: Array<{ category: string; sourceType: string; amount: string }> = [
      { category: "utilities_tnb", sourceType: "utility_tnb", amount: "188.7" },
      { category: "water", sourceType: "utility_water", amount: "35.74" },
      { category: "indah_water", sourceType: "utility_indah_water", amount: "12" },
      { category: "wifi", sourceType: "utility_wifi", amount: "200" },
    ];
    for (const w of want) {
      const row = rows.find((r) => r.sourceType === w.sourceType);
      expect(row, `expected a ${w.sourceType} row`).toBeDefined();
      expect(row!.direction).toBe("expense");
      expect(row!.category).toBe(w.category);
      expect(row!.amount.toString()).toBe(w.amount);
      expect(row!.includeInPayout).toBe(true);
      expect(row!.sourceUtilityBillId).not.toBeNull();
      expect(row!.sourceChargeId).toBeNull();
    }
    // The OLD single aggregate "utility" row must NOT exist anymore.
    expect(rows.filter((r) => r.sourceType === "utility")).toHaveLength(0);
    // FIX 1: cleaning is NEVER gross-sourced (Source 3) — no utility_cleaning row.
    expect(rows.filter((r) => r.sourceType === "utility_cleaning")).toHaveLength(0);
  });

  it("Source 4 tenant carve-out income is includeInPayout:true (pairs with the full bill)", async () => {
    const db = getDb();
    await syncMonthService(ctx, { ownerPartyId: OWNER, month: MONTH });
    const aircond = await db.ownerLedgerEntry.findFirst({
      where: { organizationId: ORG, sourceType: "tenant_aircond" },
    });
    expect(aircond).not.toBeNull();
    expect(aircond!.direction).toBe("income");
    expect(aircond!.category).toBe("aircond_income");
    expect(aircond!.amount.toString()).toBe("8.46");
    expect(aircond!.includeInPayout).toBe(true);
  });

  it("Source 2 reconciliation: utility statement twins are NOT materialized; cleaning stays a payout charge; exactly ONE payout source per category", async () => {
    const db = getDb();
    await syncMonthService(ctx, { ownerPartyId: OWNER, month: MONTH });
    const rows = await db.ownerLedgerEntry.findMany({ where: { organizationId: ORG } });

    // Source-2 statement utility child charges are NO LONGER materialized (Approach B):
    // the Source-3 full bill is the sole payout+display source for each utility.
    const stmtRows = rows.filter((r) => r.sourceType === "statement");
    for (const cat of ["utilities_tnb", "wifi", "indah_water", "water"]) {
      expect(
        stmtRows.find((r) => r.category === cat),
        `no statement ${cat} twin should be created`,
      ).toBeUndefined();
    }
    // Net payout must be byte-identical to the pre-change gross model: the twin was
    // includeInPayout:false, so its removal cannot move payout. Sum in integer cents
    // (money-safe, no float drift) from the fixture's own asserted amounts.
    const EXPECTED_PAYOUT_EXPENSES_CENTS =
      18870 + 3574 + 1200 + 20000 + // Source-3 full bills: tnb 188.70 + water 35.74 + indah 12.00 + wifi 200.00
      20000 + 35000 + 10000; //        Source-2 kept: mgmt 200.00 + maintenance 350.00 + config cleaning 100.00
    const payoutExpensesCents = rows
      .filter((r) => r.direction === "expense" && r.includeInPayout && r.status === "active")
      .reduce((a, r) => a + Math.round(Number(r.amount) * 100), 0);
    expect(payoutExpensesCents).toBe(EXPECTED_PAYOUT_EXPENSES_CENTS);
    // management_fee + maintenance stay in the payout.
    expect(stmtRows.find((r) => r.category === "management_fee")!.includeInPayout).toBe(true);
    expect(stmtRows.find((r) => r.category === "maintenance_fee")!.includeInPayout).toBe(true);
    // FIX 1: the Source-2 cleaning charge is the SOLE payout source for cleaning —
    // NOT display-only, and there is no Source-3 utility_cleaning row.
    const stmtCleaning = stmtRows.find((r) => r.category === "cleaning");
    expect(stmtCleaning, "statement cleaning row").toBeDefined();
    expect(stmtCleaning!.includeInPayout, "config cleaning must be deducted").toBe(true);
    expect(rows.filter((r) => r.sourceType === "utility_cleaning")).toHaveLength(0);

    // EXACTLY ONE payout source per UnitUtilityBill category (the Source-3 full bill).
    for (const cat of ["utilities_tnb", "water", "indah_water", "wifi"]) {
      const payoutRows = rows.filter((r) => r.category === cat && r.direction === "expense" && r.includeInPayout);
      expect(payoutRows, `one payout source for ${cat}`).toHaveLength(1);
      expect(payoutRows[0]!.sourceType.startsWith("utility_")).toBe(true);
    }
    // CLEANING's single payout source is the Source-2 config charge (sourceType "statement").
    const cleaningPayout = rows.filter((r) => r.category === "cleaning" && r.direction === "expense" && r.includeInPayout);
    expect(cleaningPayout, "one payout source for cleaning").toHaveLength(1);
    expect(cleaningPayout[0]!.sourceType).toBe("statement");
  });

  it("summarizeOwnerPeriod nets full bills against carve-out income to the owner share", async () => {
    const db = getDb();
    await syncMonthService(ctx, { ownerPartyId: OWNER, month: MONTH });
    const rows = await db.ownerLedgerEntry.findMany({ where: { organizationId: ORG, status: "active" } });
    const lines: OwnerLedgerLine[] = rows.map((e) => ({
      direction: e.direction as "income" | "expense" | "payout",
      category: e.category,
      amount: e.amount.toString(),
      sstAmount: e.sstAmount != null ? e.sstAmount.toString() : null,
      includeInPayout: e.includeInPayout,
      taxCategory: e.taxCategory,
    }));
    const s = summarizeOwnerPeriod(lines);
    // gross income = rent 1000 + aircond carve-out 8.46
    expect(s.grossRental).toBe("1008.46");
    // payout expenses = full bills tnb/water/indah/wifi (188.70+35.74+12+200=436.44)
    //   + cleaning 100 (Source-2 config charge) + mgmt 200 (+16 SST) + maintenance 350
    //   = 436.44 + 100.00 + 216.00 + 350.00 = 1102.44  (cleaning deducted ONCE, via Source 2)
    // netPayout = 1008.46 − 1102.44 = −93.98
    expect(s.netPayoutToOwner).toBe("-93.98");
  });

  it("re-sync is idempotent: no duplicate utility rows (per-category sourceType keys)", async () => {
    const db = getDb();
    const first = await syncMonthService(ctx, { ownerPartyId: OWNER, month: MONTH });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = await syncMonthService(ctx, { ownerPartyId: OWNER, month: MONTH });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.created).toBe(0);

    // FOUR distinct utility_* expense rows (tnb/water/indah/wifi — cleaning is
    // Source-2, not gross-sourced), never duplicated.
    const utilRows = await db.ownerLedgerEntry.findMany({
      where: { organizationId: ORG, sourceType: { startsWith: "utility_" } },
    });
    expect(utilRows).toHaveLength(4);
  });
});
