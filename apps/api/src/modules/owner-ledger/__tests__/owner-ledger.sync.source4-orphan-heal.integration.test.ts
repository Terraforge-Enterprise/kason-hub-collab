/**
 * Finding C — Source-4 owner-billed ORPHAN self-heal (reverse pass, MONEY).
 *
 * Finding C fixed the Source-4 CREATION query to EXCLUDE owner-billed utility/aircond
 * charges (partyId === ownerPartyId, e.g. GRIDOWN) from being booked as tenant income
 * going forward. But rows ALREADY materialized before that fix — sync-owned Source-4
 * rows (sourceType tenant_utility / tenant_aircond, updatedById === SYNC_ACTOR_ID)
 * whose source Charge is owner-billed — are ORPHANED: the reverse pass only voided
 * rows whose source Charge is void/credited, so these stale mis-booked rows persist
 * ($0 today while the owner charge is unpaid, but a latent owner-OVERPAYOUT the moment
 * it ever collects). They must self-heal on the next sync.
 *
 * The reverse-pass fix additionally voids a sync-owned candidate row when it IS a
 * Source-4 row (sourceType ∈ {tenant_utility, tenant_aircond}) whose source Charge has
 * partyId === ownerPartyId — exactly what Finding C now excludes from creation. It must
 * NOT touch: a legitimate tenant carve-out (source charge billed to a TENANT), an
 * admin-edited row (updatedById !== SYNC_ACTOR_ID), a Source-6 owner_borne_expense
 * deduction (whose source charge is ALSO owner-billed BY DESIGN), or rows in a different
 * month; and when a month is FROZEN (freeze guard short-circuit) the heal must not run.
 *
 * The rows are inserted DIRECTLY (simulating pre-Finding-C materialization) because the
 * post-fix sync would never create them. The owner has a seeded listing so the sync
 * reaches the reverse pass.
 *
 * Real LOCAL Postgres; opt-in via RUN_INTEGRATION=1. Disjoint fixed UUIDs (4a..).
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getDb } from "@kason/db";
import { syncMonthService, SYNC_ACTOR_ID } from "../owner-ledger.sync";
import type { OwnerLedgerActorCtx } from "../owner-ledger.types";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

const ORG = "4a010000-0000-4000-8000-000000000001";
const USER = "4a010000-0000-4000-8000-000000000002";
const OP_PARTY = "4a010000-0000-4000-8000-000000000003";
const OWNER = "4a010000-0000-4000-8000-000000000004";
const TENANT = "4a010000-0000-4000-8000-000000000005";
const PROPERTY = "4a010000-0000-4000-8000-000000000006";
const APARTMENT = "4a010000-0000-4000-8000-000000000007";
const UNIT = "4a010000-0000-4000-8000-000000000008";
const TENANCY = "4a010000-0000-4000-8000-000000000009";

// Source charges. Most are "posted" (NOT void/credited) so the EXISTING reverse-pass
// dead-charge check misses them; only the new owner-billed-Source-4 heal can void a row.
const CH_OWNER_UTIL = "4a010000-0000-4000-8000-0000000000d1"; // partyId=OWNER, utility, posted → B1 heal
const CH_OWNER_AIRCOND = "4a010000-0000-4000-8000-0000000000d2"; // partyId=OWNER, aircond, posted → B5 heal
const CH_TENANT_UTIL = "4a010000-0000-4000-8000-0000000000d3"; // partyId=TENANT, utility, paid  → B2 keep
const CH_OWNER_UTIL_ADMIN = "4a010000-0000-4000-8000-0000000000d4"; // partyId=OWNER, utility, posted → B3 keep (admin row)
const CH_OWNER_EXPENSE = "4a010000-0000-4000-8000-0000000000d5"; // partyId=OWNER, expense, posted → B4 keep (Source 6)
const CH_OWNER_UTIL_VOID = "4a010000-0000-4000-8000-0000000000d6"; // partyId=OWNER, utility, VOID   → B9 dual-trigger
const CH_OWNER_OTHER_MONTH = "4a010000-0000-4000-8000-0000000000d7"; // partyId=OWNER, utility, other month → B10 keep

// Pre-inserted ledger rows (simulating pre-Finding-C materialization).
const ROW_OWNER_UTIL = "4a010000-0000-4000-8000-0000000000e1";
const ROW_OWNER_AIRCOND = "4a010000-0000-4000-8000-0000000000e2";
const ROW_TENANT_UTIL = "4a010000-0000-4000-8000-0000000000e3";
const ROW_ADMIN = "4a010000-0000-4000-8000-0000000000e4";
const ROW_OWNER_EXPENSE = "4a010000-0000-4000-8000-0000000000e5";
const ROW_DUAL = "4a010000-0000-4000-8000-0000000000e6";
const ROW_OTHER_MONTH = "4a010000-0000-4000-8000-0000000000e7";

const MONTH = "2026-06";
const MONTH_START = new Date(Date.UTC(2026, 5, 1));
const DUE = new Date(Date.UTC(2026, 5, 5));
// Adjacent month (May) — for the cross-month scoping guard (B10).
const OTHER_MONTH_START = new Date(Date.UTC(2026, 4, 1));
const OTHER_DUE = new Date(Date.UTC(2026, 4, 5));

const FROZEN_FLAG = "ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER";

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
  await db.ownerStatementPeriod.deleteMany({ where: org });
  await db.ownerLedgerEntry.deleteMany({ where: org });
  await db.charge.deleteMany({ where: org });
  await db.tenancy.deleteMany({ where: org });
  await db.listing.deleteMany({ where: org });
  await db.apartment.deleteMany({ where: org });
  await db.property.deleteMany({ where: org });
  await db.auditLog.deleteMany({ where: org });
  await db.user.deleteMany({ where: { id: USER } });
  await db.party.deleteMany({ where: org });
  await db.organization.deleteMany({ where: { id: ORG } });
}

/** A sync-owned Source-4-style ledger row pointing at `sourceChargeId`, status "active". */
function rowData(args: {
  id: string;
  sourceType: string;
  sourceChargeId: string;
  category: string;
  amount: string;
  direction?: string;
  statementMonth?: Date;
  transactionDate?: Date;
}) {
  return {
    id: args.id,
    organizationId: ORG,
    ownerPartyId: OWNER,
    propertyId: PROPERTY,
    apartmentId: APARTMENT,
    listingId: UNIT,
    tenancyId: null,
    statementMonth: args.statementMonth ?? MONTH_START,
    transactionDate: args.transactionDate ?? DUE,
    direction: args.direction ?? "income",
    category: args.category,
    amount: args.amount,
    paidBy: "kaen",
    sourceType: args.sourceType,
    sourceChargeId: args.sourceChargeId,
    status: "active",
    createdById: SYNC_ACTOR_ID,
    updatedById: SYNC_ACTOR_ID,
  };
}

async function seed() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG, name: "OL Orphan Org", slug: "ol-orphan-org", status: "active",
      defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free",
    },
  });
  await db.party.create({ data: { id: OP_PARTY, organizationId: ORG, displayName: "OL Orphan Operator", partyType: "individual", status: "active" } });
  await db.user.create({
    data: { id: USER, organizationId: ORG, email: "ol-orphan-operator@example.com", fullName: "OL Orphan Operator", status: "active", role: "admin", userType: "operator", partyId: OP_PARTY },
  });
  await db.party.create({ data: { id: OWNER, organizationId: ORG, displayName: "OL Orphan Owner", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: TENANT, organizationId: ORG, displayName: "OL Orphan Tenant", partyType: "individual", status: "active" } });
  await db.property.create({
    data: { id: PROPERTY, organizationId: ORG, name: "OL Orphan Property", propertyCode: "OL-ORPH-P1", propertyType: "apartment", addressLine1: "1 Orphan St", city: "KL", country: "MY", status: "active", publishStatus: "draft" },
  });
  await db.apartment.create({ data: { id: APARTMENT, organizationId: ORG, propertyId: PROPERTY, unitCode: "A-1", listingMode: "PARTITIONED" } });
  await db.listing.create({
    data: { id: UNIT, organizationId: ORG, apartmentId: APARTMENT, listingType: "room", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER },
  });
  await db.tenancy.create({
    data: { id: TENANCY, organizationId: ORG, propertyId: PROPERTY, unitId: UNIT, tenantPartyId: TENANT, tenancyCode: "OL-ORPH-T1", status: "active", billingStatus: "current", startDate: new Date("2026-01-01T00:00:00.000Z"), monthlyRentAmount: "1000" },
  });

  await db.charge.createMany({
    data: [
      // Owner-billed utility (GRIDOWN-style) — partyId=OWNER, posted. Mis-booked Source-4 row must HEAL.
      { id: CH_OWNER_UTIL, organizationId: ORG, chargeNumber: `GRIDOWN-${MONTH}-util`, unitId: UNIT, partyId: OWNER, chargeType: "utility", status: "posted", dueDate: DUE, amount: "50.00", currency: "MYR", outstandingAmount: "50.00", billingMonth: MONTH_START },
      // Owner-billed aircond — partyId=OWNER, posted. Mis-booked Source-4 aircond row must HEAL.
      { id: CH_OWNER_AIRCOND, organizationId: ORG, chargeNumber: `GRIDOWN-${MONTH}-ac`, unitId: UNIT, partyId: OWNER, chargeType: "aircond", status: "posted", dueDate: DUE, amount: "8.00", currency: "MYR", outstandingAmount: "8.00", billingMonth: MONTH_START },
      // Legitimate tenant carve-out — partyId=TENANT, paid. Source-4 row must STAY active.
      { id: CH_TENANT_UTIL, organizationId: ORG, chargeNumber: `GRIDUTIL-${MONTH}-tenant`, unitId: UNIT, tenancyId: TENANCY, partyId: TENANT, chargeType: "utility", status: "paid", dueDate: DUE, amount: "12.00", currency: "MYR", outstandingAmount: "0.00", billingMonth: MONTH_START },
      // Owner-billed utility for the ADMIN-edited row — partyId=OWNER, posted. Admin row must STAY.
      { id: CH_OWNER_UTIL_ADMIN, organizationId: ORG, chargeNumber: `GRIDOWN-${MONTH}-admin`, unitId: UNIT, partyId: OWNER, chargeType: "utility", status: "posted", dueDate: DUE, amount: "40.00", currency: "MYR", outstandingAmount: "40.00", billingMonth: MONTH_START },
      // Owner-borne expense (Source 6) — partyId=OWNER, expense, posted. Source-6 row must STAY.
      { id: CH_OWNER_EXPENSE, organizationId: ORG, chargeNumber: `GRIDEXP-${MONTH}-owner`, unitId: UNIT, partyId: OWNER, chargeType: "expense", status: "posted", dueDate: DUE, amount: "25.00", currency: "MYR", outstandingAmount: "25.00", billingMonth: MONTH_START },
      // Owner-billed utility that is ALSO void — B9 dual-trigger (dead-charge AND owner-billed).
      { id: CH_OWNER_UTIL_VOID, organizationId: ORG, chargeNumber: `GRIDOWN-${MONTH}-void`, unitId: UNIT, partyId: OWNER, chargeType: "utility", status: "void", dueDate: DUE, amount: "30.00", currency: "MYR", outstandingAmount: "30.00", billingMonth: MONTH_START },
      // Owner-billed utility in the ADJACENT month — B10 cross-month scoping.
      { id: CH_OWNER_OTHER_MONTH, organizationId: ORG, chargeNumber: `GRIDOWN-2026-05-util`, unitId: UNIT, partyId: OWNER, chargeType: "utility", status: "posted", dueDate: OTHER_DUE, amount: "20.00", currency: "MYR", outstandingAmount: "20.00", billingMonth: OTHER_MONTH_START },
    ],
  });

  // Pre-inserted sync-owned ledger rows (as they existed before Finding C).
  await db.ownerLedgerEntry.createMany({
    data: [
      rowData({ id: ROW_OWNER_UTIL, sourceType: "tenant_utility", sourceChargeId: CH_OWNER_UTIL, category: "utility_income", amount: "50.00" }),
      rowData({ id: ROW_OWNER_AIRCOND, sourceType: "tenant_aircond", sourceChargeId: CH_OWNER_AIRCOND, category: "aircond_income", amount: "8.00" }),
      rowData({ id: ROW_TENANT_UTIL, sourceType: "tenant_utility", sourceChargeId: CH_TENANT_UTIL, category: "utility_income", amount: "12.00" }),
      // B3: admin-edited (updatedById = real USER) owner-billed Source-4 row — never-touch.
      { ...rowData({ id: ROW_ADMIN, sourceType: "tenant_utility", sourceChargeId: CH_OWNER_UTIL_ADMIN, category: "utility_income", amount: "40.00" }), updatedById: USER },
      // B4: Source-6 owner_borne_expense row (owner-billed source charge BY DESIGN) — no over-reach.
      rowData({ id: ROW_OWNER_EXPENSE, sourceType: "owner_borne_expense", sourceChargeId: CH_OWNER_EXPENSE, category: "other_expense", amount: "25.00", direction: "expense" }),
      // B9: owner-billed AND void — both the dead-charge trigger and the owner-billed trigger apply.
      rowData({ id: ROW_DUAL, sourceType: "tenant_utility", sourceChargeId: CH_OWNER_UTIL_VOID, category: "utility_income", amount: "30.00" }),
      // B10: owner-billed mis-booked row in the ADJACENT month.
      rowData({ id: ROW_OTHER_MONTH, sourceType: "tenant_utility", sourceChargeId: CH_OWNER_OTHER_MONTH, category: "utility_income", amount: "20.00", statementMonth: OTHER_MONTH_START, transactionDate: OTHER_DUE }),
    ],
  });
}

dn("owner-ledger.sync — Source-4 owner-billed orphan self-heal (Finding C reverse pass)", () => {
  beforeEach(async () => {
    await cleanup();
    await seed();
  });
  afterAll(async () => {
    await cleanup();
  });

  it("B1: voids a mis-booked owner-billed tenant_utility Source-4 row (reversed>=1)", async () => {
    const db = getDb();
    const res = await syncMonthService(ctx, { ownerPartyId: OWNER, month: MONTH });
    expect(res.ok).toBe(true);
    expect(res.ok && res.data.reversed).toBeGreaterThanOrEqual(1);

    const row = await db.ownerLedgerEntry.findUniqueOrThrow({ where: { id: ROW_OWNER_UTIL } });
    expect(row.status, "owner-billed tenant_utility row must self-heal to void").toBe("void");

    // The heal is audited the same way as a source-dead reversal.
    const audit = await db.auditLog.findFirst({
      where: { organizationId: ORG, action: "owner_ledger.entry.reverse_synced", entityId: ROW_OWNER_UTIL },
    });
    expect(audit, "healed row must carry a reverse_synced audit").not.toBeNull();
  });

  it("B2: keeps a legitimate tenant carve-out Source-4 row active (regression guard)", async () => {
    const db = getDb();
    await syncMonthService(ctx, { ownerPartyId: OWNER, month: MONTH });
    const row = await db.ownerLedgerEntry.findUniqueOrThrow({ where: { id: ROW_TENANT_UTIL } });
    expect(row.status, "tenant-billed carve-out is valid income and must NOT be voided").toBe("active");
  });

  it("B3: never touches an admin-edited owner-billed Source-4 row", async () => {
    const db = getDb();
    await syncMonthService(ctx, { ownerPartyId: OWNER, month: MONTH });
    const row = await db.ownerLedgerEntry.findUniqueOrThrow({ where: { id: ROW_ADMIN } });
    expect(row.status, "admin-edited row (updatedById != SYNC_ACTOR_ID) must stay untouched").toBe("active");
    expect(row.updatedById).toBe(USER);
  });

  it("B4: never voids a Source-6 owner_borne_expense deduction (owner-billed by design)", async () => {
    const db = getDb();
    await syncMonthService(ctx, { ownerPartyId: OWNER, month: MONTH });
    const row = await db.ownerLedgerEntry.findUniqueOrThrow({ where: { id: ROW_OWNER_EXPENSE } });
    expect(row.status, "owner_borne_expense is a legit owner-billed deduction — no over-reach").toBe("active");
  });

  it("B5: voids a mis-booked owner-billed tenant_aircond Source-4 row (both sourceTypes)", async () => {
    const db = getDb();
    await syncMonthService(ctx, { ownerPartyId: OWNER, month: MONTH });
    const row = await db.ownerLedgerEntry.findUniqueOrThrow({ where: { id: ROW_OWNER_AIRCOND } });
    expect(row.status, "owner-billed tenant_aircond row must self-heal to void").toBe("void");
  });

  it("B6: heal is idempotent — a second sync does not re-void, double-count, or resurrect", async () => {
    const db = getDb();
    await syncMonthService(ctx, { ownerPartyId: OWNER, month: MONTH }); // heals ROW_OWNER_UTIL + ROW_OWNER_AIRCOND
    const res2 = await syncMonthService(ctx, { ownerPartyId: OWNER, month: MONTH });
    expect(res2.ok && res2.data.reversed, "already-void rows are not candidates on re-sync").toBe(0);

    const row = await db.ownerLedgerEntry.findUniqueOrThrow({ where: { id: ROW_OWNER_UTIL } });
    expect(row.status).toBe("void");
    // Non-resurrection: Finding C keeps the owner-billed charge out of `planned`, so no
    // fresh ACTIVE row for it reappears on re-sync.
    const resurrected = await db.ownerLedgerEntry.findFirst({
      where: { organizationId: ORG, sourceChargeId: CH_OWNER_UTIL, status: "active" },
    });
    expect(resurrected, "no fresh active row may reappear for the owner-billed charge").toBeNull();
  });

  it("B7: does NOT heal in a FROZEN month (freeze guard short-circuits; flag ON = UAT/prod path)", async () => {
    const db = getDb();
    await db.ownerStatementPeriod.create({
      data: {
        organizationId: ORG,
        ownerPartyId: OWNER,
        apartmentId: null,
        periodMonth: MONTH_START,
        status: "frozen",
        idempotencyKey: `ownerstmt:${OWNER}:${MONTH}`,
        sourceMaxUpdatedAt: new Date(),
      },
    });
    const prev = process.env[FROZEN_FLAG];
    process.env[FROZEN_FLAG] = "1";
    try {
      const res = await syncMonthService(ctx, { ownerPartyId: OWNER, month: MONTH });
      expect(res.ok && res.data.reversed, "frozen month must short-circuit before the reverse pass").toBe(0);
      const row = await db.ownerLedgerEntry.findUniqueOrThrow({ where: { id: ROW_OWNER_UTIL } });
      expect(row.status, "frozen (append-only) rows must NOT be healed — corrections flow forward").toBe("active");
    } finally {
      if (prev === undefined) delete process.env[FROZEN_FLAG];
      else process.env[FROZEN_FLAG] = prev;
    }
  });

  it("B8: removes the mis-booked owner income from the ACTIVE (payout-counted) row set", async () => {
    const db = getDb();
    await syncMonthService(ctx, { ownerPartyId: OWNER, month: MONTH });
    // Every payout reader (computeOwnerPayout / summaries) filters status:"active". After the
    // heal, NO active income row may reference an owner-billed charge → it cannot inflate payout.
    const activeMisbooked = await db.ownerLedgerEntry.findMany({
      where: {
        organizationId: ORG,
        ownerPartyId: OWNER,
        statementMonth: MONTH_START,
        status: "active",
        direction: "income",
        sourceChargeId: { in: [CH_OWNER_UTIL, CH_OWNER_AIRCOND] },
      },
    });
    expect(activeMisbooked, "mis-booked owner income must be gone from the active payout set").toHaveLength(0);
    // The legitimate tenant carve-out income is untouched and still counts.
    const tenantActive = await db.ownerLedgerEntry.findUniqueOrThrow({ where: { id: ROW_TENANT_UTIL } });
    expect(tenantActive.status).toBe("active");
  });

  it("B9: an owner-billed AND void charge voids the row exactly once (single audit, no double-count)", async () => {
    const db = getDb();
    await syncMonthService(ctx, { ownerPartyId: OWNER, month: MONTH });
    const row = await db.ownerLedgerEntry.findUniqueOrThrow({ where: { id: ROW_DUAL } });
    expect(row.status).toBe("void");
    // Both triggers apply, but the loop voids each candidate once → exactly one audit row.
    const audits = await db.auditLog.count({
      where: { organizationId: ORG, action: "owner_ledger.entry.reverse_synced", entityId: ROW_DUAL },
    });
    expect(audits, "dual-trigger row must be voided/audited exactly once").toBe(1);
  });

  it("B10: does not heal an owner-billed mis-booked row in a DIFFERENT month", async () => {
    const db = getDb();
    await syncMonthService(ctx, { ownerPartyId: OWNER, month: MONTH });
    const row = await db.ownerLedgerEntry.findUniqueOrThrow({ where: { id: ROW_OTHER_MONTH } });
    expect(row.status, "the reverse pass is scoped to statementMonth — other months are untouched").toBe("active");
  });
});
