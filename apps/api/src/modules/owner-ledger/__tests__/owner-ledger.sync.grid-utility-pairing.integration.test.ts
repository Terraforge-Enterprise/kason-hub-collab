/**
 * PARTITIONED units: the grid's provider bill must reach the owner ledger.
 *
 * Partitioned is the MIRROR of the whole-unit case. There the tenant pays exactly
 * the bill, so the owner's utility position is zero and the carve-out is pure
 * pass-through. Here it is NOT zero — and the difference is the owner's:
 *
 *   • private submeters bill at KAEN's rate (0.60), which is above TNB's, so a
 *     300.00 master bill is recharged to tenants as 320.00 → the 20.00 spread is
 *     OWNER PROFIT (compute.ts:107-113 states this outright)
 *   • subsidy (RM50/pax when enabled) reduces what tenants are charged while the
 *     supplier bill is unchanged → the owner covers the difference
 *   • a vacant room's aircond, and the rounding residual, are the owner's too
 *
 * The gross model expresses all of that as income − expense, and it needs BOTH
 * halves. Source 3 books the expense half from a charged UnitUtilityBill — which
 * bills-grid never writes. So on the grid path only the income half existed and
 * the owner was credited the tenant's ENTIRE utility payment (320 instead of 20).
 *
 * Real LOCAL Postgres; opt-in via RUN_INTEGRATION=1. Disjoint fixed UUIDs (0e..dN).
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

const ORG = "0e000000-0000-4000-8000-0000000000d1";
const USER = "0e000000-0000-4000-8000-0000000000d2";
const PARTY = "0e000000-0000-4000-8000-0000000000d3";
const OWNER = "0e000000-0000-4000-8000-0000000000d4";
const TENANT_A = "0e000000-0000-4000-8000-0000000000d5";
const TENANT_B = "0e000000-0000-4000-8000-0000000000d6";
const PROPERTY = "0e000000-0000-4000-8000-0000000000d7";
const APARTMENT = "0e000000-0000-4000-8000-0000000000d8";
const ROOM_A = "0e000000-0000-4000-8000-0000000000d9";
const ROOM_B = "0e000000-0000-4000-8000-0000000000da";
const TENANCY_A = "0e000000-0000-4000-8000-0000000000db";
const TENANCY_B = "0e000000-0000-4000-8000-0000000000dc";
const GRID_ENTRY = "0e000000-0000-4000-8000-0000000000dd";

const MONTH = "2026-07";
const MONTH_START = new Date(Date.UTC(2026, 6, 1));

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
  await db.unitBillsGridEntry.deleteMany({ where: org });
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

async function seedBase() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG, name: "OL Grid Org", slug: "ol-grid-org", status: "active",
      defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free",
    },
  });
  await db.party.create({ data: { id: PARTY, organizationId: ORG, displayName: "OL Grid Operator", partyType: "individual", status: "active" } });
  await db.user.create({
    data: { id: USER, organizationId: ORG, email: "ol-grid-operator@example.com", fullName: "OL Grid Operator", status: "active", role: "admin", userType: "operator", partyId: PARTY },
  });
  await db.party.create({ data: { id: OWNER, organizationId: ORG, displayName: "OL Grid Owner", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: TENANT_A, organizationId: ORG, displayName: "OL Grid Tenant A", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: TENANT_B, organizationId: ORG, displayName: "OL Grid Tenant B", partyType: "individual", status: "active" } });
  await db.property.create({
    data: { id: PROPERTY, organizationId: ORG, name: "OL Grid Property", propertyCode: "OL-GRID-P1", propertyType: "apartment", addressLine1: "1 Grid St", city: "KL", country: "MY", status: "active", publishStatus: "draft" },
  });
  // PARTITIONED — the whole-unit pass-through rule must NOT apply here.
  await db.apartment.create({ data: { id: APARTMENT, organizationId: ORG, propertyId: PROPERTY, unitCode: "B-02", listingMode: "PARTITIONED" } });
  // A partitioned apartment's rooms are distinguished by listingType
  // (@@unique([apartmentId, listingType])), not by a label column.
  for (const [id, listingType] of [[ROOM_A, "master_room"], [ROOM_B, "middle_room"]] as const) {
    await db.listing.create({
      data: { id, organizationId: ORG, apartmentId: APARTMENT, listingType, occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER },
    });
  }
  for (const [id, room, tenant, code] of [[TENANCY_A, ROOM_A, TENANT_A, "T1"], [TENANCY_B, ROOM_B, TENANT_B, "T2"]] as const) {
    await db.tenancy.create({
      data: { id, organizationId: ORG, propertyId: PROPERTY, unitId: room, tenantPartyId: tenant, tenancyCode: `OL-GRID-${code}`, status: "active", billingStatus: "current", startDate: new Date("2026-01-01T00:00:00.000Z"), monthlyRentAmount: "900" },
    });
  }
}

/** A billed grid entry carrying the RAW master provider bill for the month. */
async function seedGridEntry(opts: { tnbTotalRaw: string; tnbPattern?: string; billed?: boolean }) {
  await getDb().unitBillsGridEntry.create({
    data: {
      id: GRID_ENTRY, organizationId: ORG, apartmentId: APARTMENT, periodMonth: MONTH_START,
      tnbTotalRaw: opts.tnbTotalRaw,
      tnbPattern: opts.tnbPattern ?? "recharged",
      billedAt: (opts.billed ?? true) ? new Date(Date.UTC(2026, 6, 28)) : null,
      createdBy: USER,
    },
  });
}

/** Private per-room submeter charges, billed at KAEN's rate (above TNB's). */
async function seedAircondCharges(amounts: [string, string]) {
  const db = getDb();
  const rooms = [
    { unitId: ROOM_A, tenancyId: TENANCY_A, partyId: TENANT_A },
    { unitId: ROOM_B, tenancyId: TENANCY_B, partyId: TENANT_B },
  ];
  for (const [i, r] of rooms.entries()) {
    await db.charge.create({
      data: {
        organizationId: ORG, chargeNumber: `OL-GRID-AC-${i + 1}`, tenancyId: r.tenancyId, unitId: r.unitId,
        partyId: r.partyId, chargeType: "aircond", status: "paid", dueDate: new Date(Date.UTC(2026, 6, 10)),
        amount: amounts[i]!, currency: "MYR", outstandingAmount: "0.00",
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

dn("owner-ledger sync — grid provider bill completes the partitioned pair", () => {
  beforeEach(async () => { await cleanup(); });
  afterAll(async () => { await cleanup(); });

  it("meter spread: TNB 300 recharged as 320 → owner earns the 20, not the 320", async () => {
    await seedBase();
    await seedGridEntry({ tnbTotalRaw: "300.00" });
    await seedAircondCharges(["170.00", "150.00"]); // 320.00 at KAEN's 0.60 rate
    const db = getDb();

    const res = await syncMonthService(ctx, { ownerPartyId: OWNER, month: MONTH });
    expect(res.ok).toBe(true);

    const rows = await db.ownerLedgerEntry.findMany({ where: { organizationId: ORG, status: "active" } });
    const s = summarizeOwnerPeriod(toLines(rows));

    // The tenant side is unchanged — partitioned carve-outs stay real owner income.
    expect(s.grossRental, "the tenants' submetered electricity").toBe("320.00");
    // …and the master bill KAEN fronted is now booked against it.
    const tnbExpense = rows.filter((r) => r.category === "utilities_tnb" && r.direction === "expense");
    expect(tnbExpense, "one expense row for the master TNB bill").toHaveLength(1);
    expect(tnbExpense[0]!.amount.toString()).toBe("300");
    expect(tnbExpense[0]!.includeInPayout).toBe(true);

    // Before the fix this was 320.00 — the owner was handed the tenants' whole
    // electricity payment instead of the markup KAEN recovered above the bill.
    expect(s.netPayoutToOwner, "owner keeps only the meter spread").toBe("20.00");
    expect(computeOwnerRunningBalance(toLines(rows))).toBe("20.00");
  });

  it("is idempotent — a re-sync does not duplicate the provider-bill expense", async () => {
    await seedBase();
    await seedGridEntry({ tnbTotalRaw: "300.00" });
    await seedAircondCharges(["170.00", "150.00"]);
    const db = getDb();

    await syncMonthService(ctx, { ownerPartyId: OWNER, month: MONTH });
    const second = await syncMonthService(ctx, { ownerPartyId: OWNER, month: MONTH });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.data.created).toBe(0);

    const tnbExpense = await db.ownerLedgerEntry.findMany({
      where: { organizationId: ORG, category: "utilities_tnb", direction: "expense", status: "active" },
    });
    expect(tnbExpense).toHaveLength(1);
    expect(summarizeOwnerPeriod(toLines(await db.ownerLedgerEntry.findMany({ where: { organizationId: ORG, status: "active" } }))).netPayoutToOwner).toBe("20.00");
  });

  it("owner-ABSORBED electricity books nothing — the owner is already invoiced for it", async () => {
    // "absorbed" mints a GRIDOWN- charge billed TO the owner (bills-grid/service.ts
    // :1557-1580). Deducting the same bill from the payout as well would charge the
    // owner twice for one supply.
    await seedBase();
    await seedGridEntry({ tnbTotalRaw: "300.00", tnbPattern: "absorbed" });
    const db = getDb();

    await syncMonthService(ctx, { ownerPartyId: OWNER, month: MONTH });
    const tnbExpense = await db.ownerLedgerEntry.findMany({
      where: { organizationId: ORG, category: "utilities_tnb", direction: "expense", status: "active" },
    });
    expect(tnbExpense).toHaveLength(0);
  });

  it("tenant-direct electricity books nothing — no KAEN money is involved", async () => {
    await seedBase();
    await seedGridEntry({ tnbTotalRaw: "300.00", tnbPattern: "tenant_direct" });
    const db = getDb();

    await syncMonthService(ctx, { ownerPartyId: OWNER, month: MONTH });
    const tnbExpense = await db.ownerLedgerEntry.findMany({
      where: { organizationId: ORG, category: "utilities_tnb", direction: "expense", status: "active" },
    });
    expect(tnbExpense).toHaveLength(0);
  });

  it("an UNBILLED grid entry books nothing — the bill is still a draft", async () => {
    // Mirrors Source 3's `status === "charged"` gate: no tenant charges exist yet,
    // so booking the expense now would show the owner owing the whole master bill.
    await seedBase();
    await seedGridEntry({ tnbTotalRaw: "300.00", billed: false });
    const db = getDb();

    await syncMonthService(ctx, { ownerPartyId: OWNER, month: MONTH });
    const tnbExpense = await db.ownerLedgerEntry.findMany({
      where: { organizationId: ORG, category: "utilities_tnb", direction: "expense", status: "active" },
    });
    expect(tnbExpense).toHaveLength(0);
  });
});
