/**
 * Task 4 (charge-nature-expense-profit-routing): the recurring-charge MINT
 * (recurringChargeData in service.ts) must (a) stamp `nature` onto the minted
 * Charge (flag-gated), and (b) when ENABLE_CHARGE_NATURE_ROUTING is ON and a
 * tenant-borne line carries nature:"expense", record revenueRecognition
 * "recovery_of_advance" (recovering a tenant-borne expense is NOT KAEN service
 * revenue) instead of "manager_revenue". Owner side stays "owner_funds".
 *
 * Money mint logic. Real local Postgres only, dedicated org, flag-gated. Mirrors
 * recurring-bill.integration.test.ts's harness (seedWholeUnit + addRecurringLine +
 * billService) — the only new surface is a `nature` param on addRecurringLine and
 * forcing ENABLE_CHARGE_NATURE_ROUTING ON for the flag-ON rows (same pattern as
 * expense-bill-routing.integration.test.ts forces ENABLE_EXPENSE_BILL).
 *
 * Run: from apps/api
 *   set -a; . ../../.env; set +a; RUN_INTEGRATION=1 npx vitest run \
 *     src/modules/bills-grid/__tests__/recurring-nature-mint.integration.test.ts
 *
 * Proves (brief's three acceptance rows + the flag-OFF byte-identical guarantee):
 *  1. tenant line nature:"expense", flag ON → Charge.nature "expense" AND
 *     revenueRecognition "recovery_of_advance".
 *  2. tenant line nature:"profit" (or null), flag ON → revenueRecognition
 *     "manager_revenue" (unchanged); nature stamped through.
 *  3. tenant line nature:"expense", flag OFF → nature stamped null,
 *     revenueRecognition "manager_revenue" (byte-identical to today).
 *  4. owner line nature:"expense", flag ON → Charge.nature "expense",
 *     revenueRecognition "owner_funds" (owner side never flips).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { billService, currentBillingMonthUTC } from "../service";
import { ensureChargeCategorySeeds } from "../../charge-categories/seed";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`Refusing non-local DB host: ${host}`);
}

const ORG = "d4a00000-0000-4000-8000-000000000001";
const USER = "d4a00000-0000-4000-8000-000000000002";
const PROP = "d4a00000-0000-4000-8000-000000000003";
const APT = "d4a00000-0000-4000-8000-000000000004";
const ROOM = "d4a00000-0000-4000-8000-000000000005";
const OWNER_PARTY = "d4a00000-0000-4000-8000-000000000006";
const TENANT_PARTY = "d4a00000-0000-4000-8000-000000000007";
const TENANCY = "d4a00000-0000-4000-8000-000000000008";
const DEF1 = "d4a00000-0000-4000-8000-00000000000b";
const REV1 = "d4a00000-0000-4000-8000-00000000000e";

const session = { orgId: ORG, userId: USER, role: "manager" };
const PERIOD = currentBillingMonthUTC("Asia/Kuala_Lumpur");
const PERIOD_STR = PERIOD.toISOString().slice(0, 10);

async function cleanup() {
  const db = getDb();
  await db.billingDocumentLine.deleteMany({ where: { document: { organizationId: ORG } } });
  await db.billingDocument.deleteMany({ where: { organizationId: ORG } });
  await db.paymentAllocation.deleteMany({ where: { organizationId: ORG } });
  await db.chargeEvent.deleteMany({ where: { organizationId: ORG } });
  await db.charge.deleteMany({ where: { organizationId: ORG } });
  await db.gridEntryRecurringLine.deleteMany({ where: { organizationId: ORG } });
  await db.recurringChargeRevision.deleteMany({ where: { definition: { organizationId: ORG } } });
  await db.recurringChargeDefinition.deleteMany({ where: { organizationId: ORG } });
  await db.gridMeterReading.deleteMany({ where: { organizationId: ORG } });
  await db.unitBillsGridEntry.deleteMany({ where: { organizationId: ORG } });
  await db.unitBillsBearerConfig.deleteMany({ where: { organizationId: ORG } });
  await db.tenancy.deleteMany({ where: { organizationId: ORG } });
  await db.listing.deleteMany({ where: { organizationId: ORG } });
  await db.apartment.deleteMany({ where: { organizationId: ORG } });
  await db.property.deleteMany({ where: { organizationId: ORG } });
  await db.chargeCategory.deleteMany({ where: { organizationId: ORG } });
  await db.documentSeries.deleteMany({ where: { organizationId: ORG } });
  await db.referenceSequence.deleteMany({ where: { organizationId: ORG } });
  await db.auditLog.deleteMany({ where: { organizationId: ORG } });
  await db.user.deleteMany({ where: { organizationId: ORG } });
  await db.party.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function seedWholeUnit(): Promise<{ entryId: string; token: string }> {
  const db = getDb();
  await db.organization.create({ data: { id: ORG, name: "RNM", slug: "rnm", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" } });
  await db.user.create({ data: { id: USER, organizationId: ORG, email: "rnm@example.test", fullName: "RNM", status: "active", role: "manager", userType: "operator" } });
  await db.property.create({ data: { id: PROP, organizationId: ORG, name: "P", propertyCode: "P-RNM", propertyType: "residential", addressLine1: "1", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
  await db.party.create({ data: { id: OWNER_PARTY, organizationId: ORG, displayName: "Owner", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: TENANT_PARTY, organizationId: ORG, displayName: "Tenant", partyType: "individual", status: "active" } });
  await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "A-RNM", listingMode: "WHOLE" } });
  await db.listing.create({ data: { id: ROOM, organizationId: ORG, apartmentId: APT, listingType: "whole_unit", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER_PARTY } });
  await db.tenancy.create({ data: { id: TENANCY, organizationId: ORG, propertyId: PROP, unitId: ROOM, tenantPartyId: TENANT_PARTY, tenancyCode: "T-RNM", status: "active", billingStatus: "current", startDate: new Date("2026-01-01"), monthlyRentAmount: "2000.00", numberOfPax: 1 } });
  const entry = await db.unitBillsGridEntry.create({
    data: {
      organizationId: ORG, apartmentId: APT, periodMonth: PERIOD, createdBy: USER,
      tnbTotalRaw: "300.00", airSelangorRaw: "0.00", wifi: "120.00", wifiNature: "profit", cleaning: "0.00", // charge-nature gate: this scaffolding WiFi is not what the test measures; "profit" reproduces the pre-gate null behaviour (manager_revenue → IVTEN) exactly
      tnbPattern: "absorbed", airPattern: "recharged", cleaningBearer: "owner", wifiBearer: "tenant", maintenanceFeeBearer: "owner",
    },
  });
  await db.gridMeterReading.create({ data: { organizationId: ORG, entryId: entry.id, apartmentId: APT, periodMonth: PERIOD, listingId: ROOM, tenancyId: null, partyId: null, amount: "0.00", createdBy: USER } });
  return { entryId: entry.id, token: entry.updatedAt.toISOString() };
}

/** Materialize one CUSTOM recurring snapshot line, carrying `nature` (Task 4). */
async function addRecurringLine(entryId: string, opts: { name: string; amount: string; bearer: "owner" | "tenant"; nature?: "expense" | "profit" | null }) {
  await ensureChargeCategorySeeds(ORG);
  const code = opts.bearer === "owner" ? "recurring_other_owner" : "recurring_other_tenant";
  const cat = await getDb().chargeCategory.findFirstOrThrow({ where: { organizationId: ORG, code }, select: { id: true, name: true, family: true } });
  return getDb().gridEntryRecurringLine.create({
    data: {
      organizationId: ORG, gridEntryId: entryId, definitionId: DEF1, revisionId: REV1,
      name: opts.name, amount: opts.amount, bearer: opts.bearer, nature: opts.nature ?? null,
      categoryId: cat.id, categoryCode: code, categoryName: cat.name, categoryFamily: cat.family,
      resolvedPartyId: opts.bearer === "owner" ? OWNER_PARTY : TENANT_PARTY,
      resolvedTenancyId: opts.bearer === "owner" ? null : TENANCY,
      resolvedUnitId: ROOM, effectiveMonth: PERIOD, kind: "CUSTOM",
    },
  });
}

dn("bills-grid recurring mint — nature + nature-driven revenueRecognition (Task 4)", () => {
  // ENABLE_PHASE2_BILLING_DOCS is the money-mint seam (recurringChargeData only runs under it);
  // ENABLE_CHARGE_NATURE_ROUTING is set per-test.
  beforeEach(async () => { await cleanup(); process.env.ENABLE_PHASE2_BILLING_DOCS = "true"; });
  afterEach(async () => {
    delete process.env.ENABLE_PHASE2_BILLING_DOCS;
    delete process.env.ENABLE_CHARGE_NATURE_ROUTING;
    // Task 5 TENANT destination flag — enabled per-row below so a tenant nature:"expense"
    // charge's issuance does not fail closed (see the row 1 comment). The owner side has
    // no such flag any more.
    delete process.env.ENABLE_EXPENSE_BILL;
    await cleanup();
  });

  it("row 1 — tenant line nature:'expense', flag ON → Charge.nature 'expense' AND revenueRecognition 'recovery_of_advance'", async () => {
    const db = getDb();
    process.env.ENABLE_CHARGE_NATURE_ROUTING = "true";
    // Task 5 fail-closed contract: a tenant nature:"expense" charge whose EB destination
    // is off now THROWS at issuance (never books as IVTEN revenue). Enable ENABLE_EXPENSE_BILL
    // so the charge routes to EB and this mint-focused test still reaches a successful bill —
    // the Charge-field assertions below (nature/revenueRecognition/…) are unaffected by routing.
    process.env.ENABLE_EXPENSE_BILL = "true";
    const { entryId, token } = await seedWholeUnit();
    const line = await addRecurringLine(entryId, { name: "Aircon service", amount: "30.00", bearer: "tenant", nature: "expense" });

    const r = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt: token }] });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.data.results[0].outcome).toBe("invoiced");

    const rc = await db.charge.findFirstOrThrow({ where: { organizationId: ORG, sourceRecurringLineId: line.id } });
    expect(rc.nature).toBe("expense");
    expect(rc.revenueRecognition).toBe("recovery_of_advance");
    // Owner-funding vs settlement untouched — still the manager's tenant recovery.
    expect(rc.settlementRecipient).toBe("manager");
    expect(rc.fundedBy).toBe("manager");
  });

  it("row 2a — tenant line nature:'profit', flag ON → nature 'profit', revenueRecognition 'manager_revenue' (unchanged)", async () => {
    const db = getDb();
    process.env.ENABLE_CHARGE_NATURE_ROUTING = "true";
    const { entryId, token } = await seedWholeUnit();
    const line = await addRecurringLine(entryId, { name: "Convenience fee", amount: "40.00", bearer: "tenant", nature: "profit" });

    const r = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt: token }] });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.data.results[0].outcome).toBe("invoiced");

    const rc = await db.charge.findFirstOrThrow({ where: { organizationId: ORG, sourceRecurringLineId: line.id } });
    expect(rc.nature).toBe("profit");
    expect(rc.revenueRecognition).toBe("manager_revenue");
  });

  it("row 2b — tenant line nature:null, flag ON → FAILS CLOSED (nature_unresolved), nothing minted (Fix 3, R5)", async () => {
    // Fix 3 (bill-time fail-closed): a null-nature line under the flag is a dark-period definition
    // (the config route's 422 NATURE_REQUIRED never fired for it). Rather than SILENTLY defaulting
    // it to manager_revenue (the pre-Fix-3 behaviour this row used to assert), billing now fails
    // closed so nothing is minted — the admin re-saves the definition with a nature.
    const db = getDb();
    process.env.ENABLE_CHARGE_NATURE_ROUTING = "true";
    const { entryId, token } = await seedWholeUnit();
    const line = await addRecurringLine(entryId, { name: "Late fee", amount: "25.00", bearer: "tenant", nature: null });

    const r = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt: token }] });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.data.results[0].outcome).toBe("nature_unresolved");

    // Nothing minted — the line is NOT silently booked as profit.
    expect(await db.charge.findFirst({ where: { organizationId: ORG, sourceRecurringLineId: line.id } })).toBeNull();
    expect(await db.charge.count({ where: { organizationId: ORG } })).toBe(0);
  });

  it("row 3 — tenant line nature:'expense', flag OFF → nature stamped null, revenueRecognition 'manager_revenue' (byte-identical)", async () => {
    const db = getDb();
    delete process.env.ENABLE_CHARGE_NATURE_ROUTING; // flag OFF
    const { entryId, token } = await seedWholeUnit();
    const line = await addRecurringLine(entryId, { name: "Aircon service", amount: "30.00", bearer: "tenant", nature: "expense" });

    const r = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt: token }] });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.data.results[0].outcome).toBe("invoiced");

    const rc = await db.charge.findFirstOrThrow({ where: { organizationId: ORG, sourceRecurringLineId: line.id } });
    expect(rc.nature).toBeNull(); // flag OFF never stamps nature — even though the line says "expense"
    expect(rc.revenueRecognition).toBe("manager_revenue"); // unchanged from today
  });

  it("row 4 — owner line nature:'expense', flag ON → Charge.nature 'expense', revenueRecognition 'owner_funds' (owner side never flips)", async () => {
    const db = getDb();
    process.env.ENABLE_CHARGE_NATURE_ROUTING = "true";
    // No destination flag needed: the Task-5 fail-closed throw for an owner nature:"expense"
    // charge was removed with ENABLE_OWNER_BORNE_DEDUCT (2026-08-16). Such a charge now
    // bills onto IVOWN like any other owner charge and nets out of the payout at collection,
    // so it can no longer fail closed and the Charge-field assertions below are unaffected.
    const { entryId, token } = await seedWholeUnit();
    const line = await addRecurringLine(entryId, { name: "Owner service", amount: "50.00", bearer: "owner", nature: "expense" });

    const r = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt: token }] });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.data.results[0].outcome).toBe("invoiced");

    const rc = await db.charge.findFirstOrThrow({ where: { organizationId: ORG, sourceRecurringLineId: line.id } });
    expect(rc.partyId).toBe(OWNER_PARTY);
    expect(rc.tenancyId).toBeNull();
    expect(rc.nature).toBe("expense"); // nature is stamped on the owner charge too (flag ON)
    expect(rc.revenueRecognition).toBe("owner_funds"); // owner economics never become recovery_of_advance
    expect(rc.settlementRecipient).toBe("owner");
    expect(rc.fundedBy).toBe("owner");
  });
});
