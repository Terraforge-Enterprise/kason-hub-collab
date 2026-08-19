/**
 * Integration tests for owner-ledger.sync.ts — the read-only bridge that
 * materialises OwnerLedgerEntry rows from FOUR existing subsystems:
 *   1. rent income  — rent Charges on the owner's units (per room, per charge)
 *   2. statement     — the owner_statement Invoice's child Charges (M6)
 *   3. utility       — UnitUtilityBill.ownerBorneUtilitiesTotal (M2 → M6 seam)
 *
 * Hits a real LOCAL Postgres with all Phase-2 migrations applied. Skipped by
 * default in `npx vitest run`. Run explicitly:
 *   RUN_INTEGRATION=1 DATABASE_URL="postgresql://yonghongtan@localhost:5432/kason_hub_dev" \
 *     npx vitest run src/modules/owner-ledger/__tests__/owner-ledger.sync.test.ts
 *
 * Mirrors the owner-billing integration harness: fixed-UUID seed + org-scoped
 * deleteMany cleanup in FK-safe order.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getDb } from "@kason/db";
import { listForPeriod } from "../owner-ledger.repository";
import { summarizeOwnerPeriod } from "@kason/shared";
import { syncMonthService, SYNC_ACTOR_ID } from "../owner-ledger.sync";
import type { OwnerLedgerActorCtx } from "../owner-ledger.types";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

// Hard safety: integration runs must only ever hit a local postgres.
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

// Fixed UUIDs — disjoint from every other integration test's constants.
const ORG = "0c000000-0000-4000-8000-0000000000a1";
const USER = "0c000000-0000-4000-8000-0000000000a2";
const PARTY = "0c000000-0000-4000-8000-0000000000a3";
const OWNER = "0c000000-0000-4000-8000-0000000000a4";
const TENANT = "0c000000-0000-4000-8000-0000000000a5";
const PROPERTY = "0c000000-0000-4000-8000-0000000000a6";
const APARTMENT = "0c000000-0000-4000-8000-0000000000a7";
const UNIT = "0c000000-0000-4000-8000-0000000000a8"; // occupied listing
const TENANCY = "0c000000-0000-4000-8000-0000000000a9";

const MONTH = "2026-06";
const MONTH_START = new Date(Date.UTC(2026, 5, 1)); // first-of-June UTC

const ctx: OwnerLedgerActorCtx = {
  orgId: ORG,
  actorUserId: USER,
  actorRole: "admin",
  ip: "127.0.0.1",
  userAgent: "vitest",
};

/** Delete everything this suite touches in FK-safe order. */
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
 * Seed one owner with an OCCUPIED unit + the three sources for MONTH:
 *  • one paid rent Charge (amount 1200, outstanding 200 ⇒ collected 1000)
 *  • one owner_statement Invoice (idempotencyKey owner:<OWNER>:<MONTH>, sst 16)
 *    with a management_fee (200) + cleaning (100) child Charge
 *  • one UnitUtilityBill with ownerBorneUtilitiesTotal 75.50
 *
 * When `opts.withStatementUtilityLines` is set, the statement ALSO carries the
 * PART-4 auto-fed owner-borne utility child Charges (tnb 50.50 + wifi 15.00 +
 * sewerage 10.00 = 75.50, exactly the bill's ownerBorneUtilitiesTotal). These are
 * the rows the C1 double-count regression test exercises.
 */
async function seed(opts: { withStatementUtilityLines?: boolean } = {}) {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG,
      name: "OL Sync Org",
      slug: "ol-sync-org",
      status: "active",
      defaultCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur",
      locale: "en-MY",
      subscriptionPlan: "free",
    },
  });
  await db.party.create({
    data: { id: PARTY, organizationId: ORG, displayName: "OL Operator", partyType: "individual", status: "active" },
  });
  await db.user.create({
    data: {
      id: USER,
      organizationId: ORG,
      email: "ol-sync-operator@example.com",
      fullName: "OL Operator",
      status: "active",
      role: "admin",
      userType: "operator",
      partyId: PARTY,
    },
  });
  await db.party.create({
    data: { id: OWNER, organizationId: ORG, displayName: "OL Owner", partyType: "individual", status: "active" },
  });
  await db.party.create({
    data: { id: TENANT, organizationId: ORG, displayName: "OL Tenant", partyType: "individual", status: "active" },
  });
  await db.property.create({
    data: {
      id: PROPERTY,
      organizationId: ORG,
      name: "OL Sync Property",
      propertyCode: "OL-SYNC-P1",
      propertyType: "apartment",
      addressLine1: "1 Sync St",
      city: "KL",
      country: "MY",
      status: "active",
      publishStatus: "draft",
    },
  });
  await db.apartment.create({
    data: { id: APARTMENT, organizationId: ORG, propertyId: PROPERTY, unitCode: "A-1", listingMode: "PARTITIONED" },
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
      // Owner re-point: owner→units resolves per-unit via Listing.ownerPartyId.
      ownerPartyId: OWNER,
    },
  });
  await db.tenancy.create({
    data: {
      id: TENANCY,
      organizationId: ORG,
      propertyId: PROPERTY,
      unitId: UNIT,
      tenantPartyId: TENANT,
      tenancyCode: "OL-SYNC-T1",
      status: "active",
      billingStatus: "current",
      startDate: new Date("2026-01-01T00:00:00.000Z"),
      monthlyRentAmount: "1200",
    },
  });
  await db.landlordTenancy.create({
    data: {
      organizationId: ORG,
      propertyId: PROPERTY,
      landlordId: OWNER,
      startDate: new Date("2026-01-01T00:00:00.000Z"),
      monthlyRent: "1200",
      status: "active",
    },
  });

  // ── Source 1: a paid rent Charge (collected = 1200 − 200 = 1000). ──
  await db.charge.create({
    data: {
      organizationId: ORG,
      chargeNumber: "OL-SYNC-RENT-1",
      tenancyId: TENANCY,
      unitId: UNIT,
      partyId: TENANT,
      chargeType: "rent",
      status: "posted",
      dueDate: new Date(Date.UTC(2026, 5, 5)),
      amount: "1200.00",
      currency: "MYR",
      outstandingAmount: "200.00",
    },
  });

  // ── Source 2: owner_statement Invoice + mgmt-fee + cleaning child Charges. ──
  const invoice = await db.invoice.create({
    data: {
      organizationId: ORG,
      invoiceNumber: "OL-SYNC-INV-1",
      partyId: OWNER,
      ownerPartyId: OWNER,
      propertyId: PROPERTY,
      invoiceType: "owner_statement",
      status: "draft",
      invoiceDate: MONTH_START,
      periodMonth: MONTH_START,
      totalAmount: "316.00",
      sstAmount: "16.00",
      currency: "MYR",
      idempotencyKey: `owner:${OWNER}:${MONTH}`,
    },
  });
  await db.charge.create({
    data: {
      organizationId: ORG,
      chargeNumber: "OL-SYNC-STMT-MGMT",
      unitId: UNIT,
      partyId: OWNER,
      chargeType: "management_fee",
      status: "draft",
      dueDate: MONTH_START,
      amount: "200.00",
      currency: "MYR",
      outstandingAmount: "200.00",
      invoiceId: invoice.id,
      billingMonth: MONTH_START,
    },
  });
  await db.charge.create({
    data: {
      organizationId: ORG,
      chargeNumber: "OL-SYNC-STMT-CLEAN",
      unitId: UNIT,
      partyId: OWNER,
      chargeType: "cleaning",
      status: "draft",
      dueDate: MONTH_START,
      amount: "100.00",
      currency: "MYR",
      outstandingAmount: "100.00",
      invoiceId: invoice.id,
      billingMonth: MONTH_START,
    },
  });

  // ── PART 4 auto-fed owner-borne utility statement lines (C1 regression). ──
  // tnb 50.50 + wifi 15.00 + sewerage 10.00 = 75.50 = ownerBorneUtilitiesTotal.
  if (opts.withStatementUtilityLines) {
    const utilLines: Array<{ n: string; t: string; amt: string }> = [
      { n: "OL-SYNC-STMT-TNB", t: "tnb", amt: "50.50" },
      { n: "OL-SYNC-STMT-WIFI", t: "wifi", amt: "15.00" },
      { n: "OL-SYNC-STMT-SEWER", t: "sewerage", amt: "10.00" },
    ];
    for (const l of utilLines) {
      await db.charge.create({
        data: {
          organizationId: ORG,
          chargeNumber: l.n,
          unitId: UNIT,
          partyId: OWNER,
          chargeType: l.t,
          status: "draft",
          dueDate: MONTH_START,
          amount: l.amt,
          currency: "MYR",
          outstandingAmount: l.amt,
          invoiceId: invoice.id,
          billingMonth: MONTH_START,
        },
      });
    }
  }

  // ── Source 3: a UnitUtilityBill with an owner-borne total. ──
  await db.unitUtilityBill.create({
    data: {
      organizationId: ORG,
      apartmentId: APARTMENT,
      periodMonth: MONTH_START,
      billingMode: "subsidy",
      tnbTotal: "300.00",
      ownerBorneUtilitiesTotal: "75.50",
      status: "charged",
      createdBy: USER,
    },
  });

  return { invoiceId: invoice.id };
}

dn("owner-ledger.sync — materialise rows from rent + statement + utility", () => {
  beforeEach(async () => {
    await cleanup();
    await seed();
  });

  afterAll(async () => {
    await cleanup();
  });

  it("(a) first sync creates one row per source + exactly one sync audit row", async () => {
    const db = getDb();
    const res = await syncMonthService(ctx, { ownerPartyId: OWNER, month: MONTH });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.status).toBe(200);
    // rent(1) + statement(2) + utility(1) = 4 created, 0 updated, 0 skipped.
    expect(res.data).toEqual({ created: 4, updated: 0, skipped: 0, reversed: 0 });

    const rows = await db.ownerLedgerEntry.findMany({ where: { organizationId: ORG } });
    expect(rows).toHaveLength(4);

    // ── rent income row ──
    const rent = rows.find((r) => r.sourceType === "rent");
    expect(rent).toBeDefined();
    expect(rent!.direction).toBe("income");
    expect(rent!.category).toBe("rental_income");
    expect(rent!.amount.toString()).toBe("1000"); // 1200 − 200 collected
    expect(rent!.paidBy).toBe("kaen");
    expect(rent!.includeInPayout).toBe(true);
    expect(rent!.listingId).toBe(UNIT);
    expect(rent!.tenancyId).toBe(TENANCY);
    expect(rent!.apartmentId).toBe(APARTMENT); // derived from listing → apartment
    expect(rent!.sourceChargeId).not.toBeNull();
    expect(rent!.createdById).toBe(SYNC_ACTOR_ID);
    expect(rent!.updatedById).toBe(SYNC_ACTOR_ID);

    // ── statement: management_fee (carries the aggregate SST) ──
    const mgmt = rows.find((r) => r.category === "management_fee");
    expect(mgmt).toBeDefined();
    expect(mgmt!.direction).toBe("expense");
    expect(mgmt!.sourceType).toBe("statement");
    expect(mgmt!.amount.toString()).toBe("200");
    expect(mgmt!.sstAmount!.toString()).toBe("16"); // aggregate Invoice.sstAmount
    expect(mgmt!.sourceChargeId).not.toBeNull();
    expect(mgmt!.sourceInvoiceId).not.toBeNull();

    // ── statement: cleaning (no SST attached) ──
    const cleaning = rows.find((r) => r.category === "cleaning");
    expect(cleaning).toBeDefined();
    expect(cleaning!.direction).toBe("expense");
    expect(cleaning!.sourceType).toBe("statement");
    expect(cleaning!.amount.toString()).toBe("100");
    expect(cleaning!.sstAmount).toBeNull();

    // ── utility expense row (C1 GROSS: the FULL tnbTotal, per-category sourceType) ──
    // The seed bill carries only tnbTotal 300 (airSelangor/indah/cleaning/wifi = 0),
    // so Source 3 books ONE utilities_tnb row at the FULL 300 — not the old
    // owner-borne aggregate (75.50).
    const util = rows.find((r) => r.sourceType === "utility_tnb");
    expect(util).toBeDefined();
    expect(util!.direction).toBe("expense");
    expect(util!.category).toBe("utilities_tnb");
    expect(util!.amount.toString()).toBe("300"); // FULL tnbTotal (gross model)
    expect(util!.sourceUtilityBillId).not.toBeNull();
    expect(util!.sourceChargeId).toBeNull(); // utility rows carry no charge id
    expect(util!.apartmentId).toBe(APARTMENT); // directly from UnitUtilityBill.apartmentId

    // Exactly one sync audit row, keyed on the owner, with the REAL actor.
    const audits = await db.auditLog.findMany({
      where: { organizationId: ORG, action: "owner_ledger.sync" },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.entityType).toBe("OwnerLedgerEntry");
    expect(audits[0]!.entityId).toBe(OWNER);
    expect(audits[0]!.actorUserId).toBe(USER); // real actor, NOT the sentinel
  });

  it("(b) a re-sync is idempotent: created:0 for ALL sources (incl. the utility row)", async () => {
    const db = getDb();
    const first = await syncMonthService(ctx, { ownerPartyId: OWNER, month: MONTH });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.created).toBe(4);

    const second = await syncMonthService(ctx, { ownerPartyId: OWNER, month: MONTH });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    // The KEY regression guard: the utility row (sourceChargeId null) must NOT
    // be re-created — code-side idempotency keyed on sourceUtilityBillId.
    expect(second.data).toEqual({ created: 0, updated: 4, skipped: 0, reversed: 0 });

    // Still exactly 4 rows total — no duplicates of any source.
    expect(await db.ownerLedgerEntry.count({ where: { organizationId: ORG } })).toBe(4);
    expect(await db.ownerLedgerEntry.count({ where: { organizationId: ORG, sourceType: "utility_tnb" } })).toBe(1);
  });

  it("(c) an admin-edited synced row (updatedById != sentinel) is SKIPPED, not overwritten", async () => {
    const db = getDb();
    const first = await syncMonthService(ctx, { ownerPartyId: OWNER, month: MONTH });
    expect(first.ok).toBe(true);

    // Simulate an admin edit: change the cleaning row's amount + claim it (non-sentinel updatedById).
    const cleaning = await db.ownerLedgerEntry.findFirst({
      where: { organizationId: ORG, category: "cleaning" },
    });
    expect(cleaning).not.toBeNull();
    await db.ownerLedgerEntry.update({
      where: { id: cleaning!.id },
      data: { amount: "999.00", updatedById: USER },
    });

    const second = await syncMonthService(ctx, { ownerPartyId: OWNER, month: MONTH });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    // 3 still-synced rows updated; the admin-edited cleaning row skipped.
    expect(second.data.created).toBe(0);
    expect(second.data.skipped).toBe(1);
    expect(second.data.updated).toBe(3);

    // The admin's value is preserved — sync did NOT overwrite it.
    const after = await db.ownerLedgerEntry.findUnique({ where: { id: cleaning!.id } });
    expect(after!.amount.toString()).toBe("999");
    expect(after!.updatedById).toBe(USER);
  });

  it("(d) cross-org owner resolves to an empty source set → nothing created", async () => {
    const res = await syncMonthService(
      { ...ctx, orgId: "0c000000-0000-4000-8000-0000000000ff" },
      { ownerPartyId: OWNER, month: MONTH },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toEqual({ created: 0, updated: 0, skipped: 0, reversed: 0 });
  });

  // ── PART 2 (Workstream D): paymentStatus driven by the SOURCE's real state ──
  // The sync previously hardcoded paymentStatus "paid" on every row regardless of
  // whether the tenant had actually paid. Now each ledger row's paymentStatus is
  // mapped from the status of the source row it was materialised from.

  it("(e2) rent income paymentStatus tracks the rent Charge.status (posted-unpaid → pending)", async () => {
    const db = getDb();
    // The seed's rent Charge is status "posted" with outstanding 200 (unpaid).
    const res = await syncMonthService(ctx, { ownerPartyId: OWNER, month: MONTH });
    expect(res.ok).toBe(true);
    const rent = await db.ownerLedgerEntry.findFirst({ where: { organizationId: ORG, sourceType: "rent" } });
    expect(rent).not.toBeNull();
    // posted (active-unpaid) → the owner sees "pending payment from tenant".
    expect(rent!.paymentStatus).toBe("pending");
  });

  it("(e3) rent income paymentStatus = paid once the rent Charge is fully paid", async () => {
    const db = getDb();
    // Flip the rent Charge to fully paid BEFORE syncing.
    await db.charge.updateMany({
      where: { organizationId: ORG, chargeType: "rent" },
      data: { status: "paid", outstandingAmount: "0.00" },
    });
    const res = await syncMonthService(ctx, { ownerPartyId: OWNER, month: MONTH });
    expect(res.ok).toBe(true);
    const rent = await db.ownerLedgerEntry.findFirst({ where: { organizationId: ORG, sourceType: "rent" } });
    expect(rent!.paymentStatus).toBe("paid");
  });

  it("(e4) rent income paymentStatus = partial when the rent Charge is partially_paid", async () => {
    const db = getDb();
    await db.charge.updateMany({
      where: { organizationId: ORG, chargeType: "rent" },
      data: { status: "partially_paid", outstandingAmount: "100.00" },
    });
    const res = await syncMonthService(ctx, { ownerPartyId: OWNER, month: MONTH });
    expect(res.ok).toBe(true);
    const rent = await db.ownerLedgerEntry.findFirst({ where: { organizationId: ORG, sourceType: "rent" } });
    expect(rent!.paymentStatus).toBe("partial");
  });

  it("(e5) statement expense paymentStatus tracks the child Charge.status (draft → pending; paid → paid)", async () => {
    const db = getDb();
    // The seed's statement child Charges are status "draft" → pending.
    let res = await syncMonthService(ctx, { ownerPartyId: OWNER, month: MONTH });
    expect(res.ok).toBe(true);
    const mgmtDraft = await db.ownerLedgerEntry.findFirst({ where: { organizationId: ORG, category: "management_fee" } });
    expect(mgmtDraft!.paymentStatus).toBe("pending");

    // Now pay the mgmt-fee child Charge and re-sync (row still sync-owned → updates).
    await db.charge.updateMany({
      where: { organizationId: ORG, chargeType: "management_fee" },
      data: { status: "paid", outstandingAmount: "0.00" },
    });
    res = await syncMonthService(ctx, { ownerPartyId: OWNER, month: MONTH });
    expect(res.ok).toBe(true);
    const mgmtPaid = await db.ownerLedgerEntry.findFirst({ where: { organizationId: ORG, category: "management_fee" } });
    expect(mgmtPaid!.paymentStatus).toBe("paid");
  });

  it("(e6) a DRAFT bill books NO Source-3 utility row (M-1: only charged bills are gross-sourced)", async () => {
    const db = getDb();
    // Flip the seeded bill back to draft (it was charged in the seed).
    await db.unitUtilityBill.updateMany({
      where: { organizationId: ORG },
      data: { status: "draft" },
    });
    const res = await syncMonthService(ctx, { ownerPartyId: OWNER, month: MONTH });
    expect(res.ok).toBe(true);
    // M-1: a draft bill has no tenant carve-out charges yet, so booking the FULL
    // supplier bill as an owner expense would debit the owner the whole bill
    // prematurely. Source 3 books non-charged bills NOWHERE — no utility row exists.
    const util = await db.ownerLedgerEntry.findFirst({ where: { organizationId: ORG, sourceType: "utility_tnb" } });
    expect(util).toBeNull();
  });

  it("(g) attachmentKeys on rent Charge propagate to the sync'd ledger entry (2b-5)", async () => {
    const db = getDb();
    // Update the seeded rent Charge to carry an attachment proof before syncing.
    await db.charge.updateMany({
      where: { organizationId: ORG, chargeType: "rent" },
      data: { attachmentKeys: ["bills/rent-proof.pdf"] },
    });
    const res = await syncMonthService(ctx, { ownerPartyId: OWNER, month: MONTH });
    expect(res.ok).toBe(true);
    const rent = await db.ownerLedgerEntry.findFirst({ where: { organizationId: ORG, sourceType: "rent" } });
    expect(rent).not.toBeNull();
    // 2b-5 contract: attachmentKeys must be carried through from the Charge, not hardcoded [].
    expect(rent!.attachmentKeys).toEqual(["bills/rent-proof.pdf"]);
  });

  it("(e7) utility expense paymentStatus = paid when the bill's tenant utility charges are all paid", async () => {
    const db = getDb();
    // Charged bill (seed) + a fully-paid tenant utility Charge linked via the bill's allocation.
    const bill = await db.unitUtilityBill.findFirstOrThrow({ where: { organizationId: ORG } });
    const utilCharge = await db.charge.create({
      data: {
        organizationId: ORG,
        chargeNumber: "OL-SYNC-UTIL-TEN",
        unitId: UNIT,
        tenancyId: TENANCY,
        partyId: TENANT,
        chargeType: "utility",
        status: "paid",
        dueDate: MONTH_START,
        amount: "75.50",
        currency: "MYR",
        outstandingAmount: "0.00",
        billingMonth: MONTH_START,
      },
    });
    await db.utilityAllocation.create({
      data: {
        organizationId: ORG,
        billId: bill.id,
        unitId: UNIT,
        tenancyId: TENANCY,
        partyId: TENANT,
        pax: 1,
        tnbShare: "0.00",
        airSelangorShare: "0.00",
        indahShare: "0.00",
        cleaningShare: "0.00",
        wifiShare: "0.00",
        subsidyDeduction: "0.00",
        computedAmount: "75.50",
        chargeId: utilCharge.id,
        status: "charged",
      },
    });
    const res = await syncMonthService(ctx, { ownerPartyId: OWNER, month: MONTH });
    expect(res.ok).toBe(true);
    const util = await db.ownerLedgerEntry.findFirst({ where: { organizationId: ORG, sourceType: "utility_tnb" } });
    expect(util!.paymentStatus).toBe("paid");
  });
});

// ── C1 GROSS: each utility category has EXACTLY ONE payout source (no double-count) ──
//
// The owner_statement (Source 2) carries itemised utility child Charges (PART-4
// auto-feed) + the RM100 cleaning config charge. The UnitUtilityBill (Source 3) books
// the FULL per-category supplier bills (tnb/water/indah/wifi) as the PAYOUT source. If
// both a utility category's full bill AND its Source-2 line counted, it would deduct
// TWICE → owner underpaid. Reconciliation (Approach B): Source 3 (full bill) owns the
// payout for tnb/water/indah/wifi; the matching Source-2 lines are NO LONGER
// materialized. management_fee AND cleaning stay Source-2 payout sources.
//
// FIX 1: cleaning is NOT gross-sourced. Even though this test gives the bill a cleaning
// (100), Source 3 books only tnbTotal (300) — cleaning's payout source is the Source-2
// config charge (so a standard owner with cleaning=0 in the bill is NOT overpaid).
//
// Seed totals for the month:
//   income (rent collected)      = 1000.00
//   Source-3 utilities_tnb       =  300.00  (FULL tnbTotal — payout source)
//   statement cleaning           =  100.00  (Source-2 config charge — payout source)
//   statement mgmt_fee + SST     =  200.00 + 16.00 = 216.00  (payout source)
//   statement tnb/wifi/sewerage  = NOT materialized (covered by the Source-3 full bills)
//
// Correct net payout (each category counted ONCE):
//   1000.00 − 300.00 − 100.00 − 216.00 = 384.00
dn("owner-ledger.sync — C1 GROSS: exactly one payout source per utility category", () => {
  beforeEach(async () => {
    await cleanup();
    await seed({ withStatementUtilityLines: true });
    // Give the bill a cleaning component too — FIX 1: Source 3 must STILL ignore it
    // (no utility_cleaning row); cleaning's payout source stays the Source-2 charge.
    await getDb().unitUtilityBill.updateMany({
      where: { organizationId: ORG },
      data: { cleaning: "100.00" },
    });
  });

  afterAll(async () => {
    await cleanup();
  });

  it("statement utility twins are NOT materialized; cleaning stays a Source-2 payout charge; one payout source per category", async () => {
    const db = getDb();
    const res = await syncMonthService(ctx, { ownerPartyId: OWNER, month: MONTH });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // rent(1) + statement mgmt/cleaning(2) + Source-3 tnb(1) = 4. Approach B: the
    // tnb/wifi/sewerage utility statement twins are NO LONGER materialized.
    // FIX 1: cleaning is NOT gross-sourced, so there is NO Source-3 cleaning row.
    expect(res.data.created).toBe(4);

    // The Source-2 statement utility rows are NO LONGER created (Approach B): the
    // Source-3 full bill is the sole payout+display source per category.
    for (const cat of ["utilities_tnb", "wifi", "indah_water", "water"]) {
      const s = await db.ownerLedgerEntry.findFirst({
        where: { organizationId: ORG, sourceType: "statement", category: cat },
      });
      expect(s, `no statement ${cat} twin should be created`).toBeNull();
    }
    // FIX 1: the Source-2 cleaning charge is the SOLE payout source for cleaning.
    const cleaning = await db.ownerLedgerEntry.findFirst({ where: { organizationId: ORG, sourceType: "statement", category: "cleaning" } });
    expect(cleaning, "statement cleaning row").not.toBeNull();
    expect(cleaning!.includeInPayout, "config cleaning must be deducted").toBe(true);

    // mgmt_fee (Source 2) + the FULL Source-3 bills count toward payout.
    const mgmt = await db.ownerLedgerEntry.findFirst({ where: { organizationId: ORG, category: "management_fee" } });
    expect(mgmt!.includeInPayout).toBe(true);
    const tnbFull = await db.ownerLedgerEntry.findFirst({ where: { organizationId: ORG, sourceType: "utility_tnb" } });
    expect(tnbFull!.includeInPayout).toBe(true);
    expect(tnbFull!.amount.toString()).toBe("300"); // FULL tnbTotal
    // FIX 1: NO Source-3 utility_cleaning row even though the bill carries cleaning 100.
    expect(await db.ownerLedgerEntry.findFirst({ where: { organizationId: ORG, sourceType: "utility_cleaning" } })).toBeNull();

    // Exactly ONE payout source per UnitUtilityBill category (the Source-3 full bill)...
    const tnbPayout = await db.ownerLedgerEntry.findMany({
      where: { organizationId: ORG, category: "utilities_tnb", direction: "expense", includeInPayout: true },
    });
    expect(tnbPayout, "one payout source for utilities_tnb").toHaveLength(1);
    expect(tnbPayout[0]!.sourceType).toBe("utility_tnb");
    // ...and for cleaning, the SOLE payout source is the Source-2 config charge.
    const cleaningPayout = await db.ownerLedgerEntry.findMany({
      where: { organizationId: ORG, category: "cleaning", direction: "expense", includeInPayout: true },
    });
    expect(cleaningPayout, "one payout source for cleaning").toHaveLength(1);
    expect(cleaningPayout[0]!.sourceType).toBe("statement");

    // ── Net payout: each category counted ONCE.
    //    1000.00 − 300.00(tnb, Source 3) − 100.00(cleaning, Source 2) − 216.00(mgmt+SST) = 384.00.
    //    A double-count (statement tnb also deducted) would yield 333.50.
    const lines = await listForPeriod(ORG, { ownerPartyId: OWNER });
    const summary = summarizeOwnerPeriod(lines);
    expect(summary.netPayoutToOwner).toBe("384.00");
  });
});

// ── Task 2a-2: Source 4 (tenant-borne income) ────────────────────────────────
//
// New UUIDs disjoint from all other suites (prefix 0d).
// Seed:
//   - owner owns one listing: UNIT2 (room, occupied)
//   - aircond Charge on UNIT2 → must produce category:"aircond_income" (direction:income)
//   - utility Charge on UNIT2 → must produce category:"utility_income" (direction:income)
// Note: carpark income now comes from Carpark entity charges (Source 5),
//   covered by carpark-money-split.integration.test.ts.
const ORG2    = "0d000000-0000-4000-8000-0000000000a1";
const USER2   = "0d000000-0000-4000-8000-0000000000a2";
const PARTY2  = "0d000000-0000-4000-8000-0000000000a3";
const OWNER2  = "0d000000-0000-4000-8000-0000000000a4";
const TENANT2 = "0d000000-0000-4000-8000-0000000000a5";
const PROP2   = "0d000000-0000-4000-8000-0000000000a6";
const APT2    = "0d000000-0000-4000-8000-0000000000a7";
const UNIT2   = "0d000000-0000-4000-8000-0000000000a8"; // room listing (occupied)
const TEN2    = "0d000000-0000-4000-8000-0000000000aa";

const ctx2: OwnerLedgerActorCtx = {
  orgId: ORG2,
  actorUserId: USER2,
  actorRole: "admin",
  ip: "127.0.0.1",
  userAgent: "vitest",
};

const MONTH2 = "2026-06";
const MONTH_START2 = new Date(Date.UTC(2026, 5, 1));

async function cleanup2() {
  const db = getDb();
  const org = { organizationId: ORG2 };
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
  await db.user.deleteMany({ where: { id: USER2 } });
  await db.party.deleteMany({ where: org });
  await db.organization.deleteMany({ where: { id: ORG2 } });
}

async function seed2() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG2, name: "OL Sync2 Org", slug: "ol-sync2-org", status: "active",
      defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free",
    },
  });
  await db.party.create({ data: { id: PARTY2, organizationId: ORG2, displayName: "Sync2 Op", partyType: "individual", status: "active" } });
  await db.user.create({ data: { id: USER2, organizationId: ORG2, email: "sync2@example.com", fullName: "Sync2 Op", status: "active", role: "admin", userType: "operator", partyId: PARTY2 } });
  await db.party.create({ data: { id: OWNER2, organizationId: ORG2, displayName: "Sync2 Owner", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: TENANT2, organizationId: ORG2, displayName: "Sync2 Tenant", partyType: "individual", status: "active" } });
  await db.property.create({
    data: { id: PROP2, organizationId: ORG2, name: "Sync2 Property", propertyCode: "S2P1", propertyType: "apartment", addressLine1: "2 Sync St", city: "KL", country: "MY", status: "active", publishStatus: "draft" },
  });
  await db.apartment.create({ data: { id: APT2, organizationId: ORG2, propertyId: PROP2, unitCode: "B-1", listingMode: "PARTITIONED" } });
  // Room listing (occupied)
  await db.listing.create({ data: { id: UNIT2, organizationId: ORG2, apartmentId: APT2, listingType: "room", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER2 } });
  await db.tenancy.create({
    data: { id: TEN2, organizationId: ORG2, propertyId: PROP2, unitId: UNIT2, tenantPartyId: TENANT2, tenancyCode: "S2T1", status: "active", billingStatus: "current", startDate: new Date("2026-01-01T00:00:00.000Z"), monthlyRentAmount: "500" },
  });
  await db.landlordTenancy.create({ data: { organizationId: ORG2, propertyId: PROP2, landlordId: OWNER2, startDate: new Date("2026-01-01T00:00:00.000Z"), monthlyRent: "500", status: "active" } });
  // Rent on room unit (Source 1 → rental_income)
  await db.charge.create({
    data: { organizationId: ORG2, chargeNumber: "S2-RENT-ROOM", tenancyId: TEN2, unitId: UNIT2, partyId: TENANT2, chargeType: "rent", status: "paid", dueDate: new Date(Date.UTC(2026, 5, 5)), amount: "500.00", currency: "MYR", outstandingAmount: "0.00" },
  });
  // Tenant-borne aircond Charge (Source 4 → aircond_income)
  await db.charge.create({
    data: { organizationId: ORG2, chargeNumber: "S2-AIRCOND", unitId: UNIT2, tenancyId: TEN2, partyId: TENANT2, chargeType: "aircond", status: "paid", dueDate: new Date(Date.UTC(2026, 5, 10)), amount: "80.00", currency: "MYR", outstandingAmount: "0.00", billingMonth: MONTH_START2 },
  });
  // Tenant-borne utility Charge (Source 4 → utility_income)
  await db.charge.create({
    data: { organizationId: ORG2, chargeNumber: "S2-UTIL", unitId: UNIT2, tenancyId: TEN2, partyId: TENANT2, chargeType: "utility", status: "paid", dueDate: new Date(Date.UTC(2026, 5, 10)), amount: "60.00", currency: "MYR", outstandingAmount: "0.00", billingMonth: MONTH_START2 },
  });
}

dn("owner-ledger.sync — 2a-2: Source 4 tenant-borne income", () => {
  beforeEach(async () => {
    await cleanup2();
    await seed2();
  });

  afterAll(async () => {
    await cleanup2();
  });

  it("(f2) tenant-borne aircond Charge produces a Source-4 aircond_income row (direction:income, includeInPayout:true — gross pairing)", async () => {
    const db = getDb();
    const res = await syncMonthService(ctx2, { ownerPartyId: OWNER2, month: MONTH2 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const aircondRow = await db.ownerLedgerEntry.findFirst({
      where: { organizationId: ORG2, sourceType: "tenant_aircond" },
    });
    expect(aircondRow).not.toBeNull();
    expect(aircondRow!.direction).toBe("income");
    expect(aircondRow!.category).toBe("aircond_income");
    expect(aircondRow!.amount.toString()).toBe("80");
    // C1 GROSS: carve-out income IS in the payout — pairs with the full-bill expense.
    expect(aircondRow!.includeInPayout).toBe(true);
    expect(aircondRow!.listingId).toBe(UNIT2);
    expect(aircondRow!.tenancyId).toBe(TEN2);
    expect(aircondRow!.sourceChargeId).not.toBeNull();
    expect(aircondRow!.paymentStatus).toBe("paid");
  });

  it("(f3) tenant-borne utility Charge produces a Source-4 utility_income row (direction:income, includeInPayout:true — gross pairing)", async () => {
    const db = getDb();
    const res = await syncMonthService(ctx2, { ownerPartyId: OWNER2, month: MONTH2 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const utilRow = await db.ownerLedgerEntry.findFirst({
      where: { organizationId: ORG2, sourceType: "tenant_utility" },
    });
    expect(utilRow).not.toBeNull();
    expect(utilRow!.direction).toBe("income");
    expect(utilRow!.category).toBe("utility_income");
    expect(utilRow!.amount.toString()).toBe("60");
    // C1 GROSS: carve-out income IS in the payout — pairs with the full-bill expense.
    expect(utilRow!.includeInPayout).toBe(true);
    expect(utilRow!.sourceChargeId).not.toBeNull();
    expect(utilRow!.paymentStatus).toBe("paid");
  });

  it("(f5) attachmentKeys on Source-4 tenant-borne Charge propagate to the sync'd ledger entry (2b-5)", async () => {
    const db = getDb();
    // Update the seeded aircond Charge to carry an attachment proof before syncing.
    await db.charge.updateMany({
      where: { organizationId: ORG2, chargeType: "aircond" },
      data: { attachmentKeys: ["bills/aircond-proof.pdf"] },
    });
    const res = await syncMonthService(ctx2, { ownerPartyId: OWNER2, month: MONTH2 });
    expect(res.ok).toBe(true);
    const aircondRow = await db.ownerLedgerEntry.findFirst({ where: { organizationId: ORG2, sourceType: "tenant_aircond" } });
    expect(aircondRow).not.toBeNull();
    // 2b-5 contract: attachmentKeys must be carried through from the Charge, not hardcoded [].
    expect(aircondRow!.attachmentKeys).toEqual(["bills/aircond-proof.pdf"]);
  });

  it("(f4) Source-4 rows are idempotent — re-sync produces 0 new rows", async () => {
    const db = getDb();
    const first = await syncMonthService(ctx2, { ownerPartyId: OWNER2, month: MONTH2 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const initialCount = await db.ownerLedgerEntry.count({ where: { organizationId: ORG2 } });

    const second = await syncMonthService(ctx2, { ownerPartyId: OWNER2, month: MONTH2 });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.created).toBe(0);
    expect(await db.ownerLedgerEntry.count({ where: { organizationId: ORG2 } })).toBe(initialCount);
  });
});
