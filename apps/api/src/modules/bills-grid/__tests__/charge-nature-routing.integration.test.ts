/**
 * Task 5 (charge-nature-expense-profit-routing): issue-grouped.ts's CORE routing
 * change. A tenant recurring line (chargeType "utility", NOT a grid-expense charge —
 * sourceGridExpenseId is null) that carries nature:"expense" must, when
 * ENABLE_CHARGE_NATURE_ROUTING is ON, be routed onto its OWN Expense Bill (EB-)
 * document instead of co-grouping onto the tenant's IVTEN — because recovering a
 * tenant-borne expense is NOT KAEN service revenue. And it must FAIL CLOSED: if the
 * destination flag (ENABLE_EXPENSE_BILL) is OFF, issuance throws rather than
 * silently mis-booking the Expense charge as IVTEN revenue.
 *
 * This is the END-TO-END proof (billService → mint → issueGroupedGridInvoiceTx) that
 * a chargeType:"utility" charge — for which isGridExpenseCharge is FALSE — routes to
 * EB PURELY via the new `nature` clause (expense-bill-routing.integration.test.ts
 * already covers the chargeType:"expense" / isGridExpenseCharge path).
 *
 * Harness copied from recurring-nature-mint.integration.test.ts (Task 4): seed a
 * whole unit, add a recurring line carrying `nature`, force the flags per-row, bill.
 * The only new surface vs Task 4: we assert on the ISSUED DOCUMENT's series (EB vs
 * IVTEN) instead of on the Charge fields, and add ENABLE_EXPENSE_BILL to the flags.
 *
 * Run: from apps/api
 *   set -a; . ../../.env; set +a; RUN_INTEGRATION=1 npx vitest run \
 *     src/modules/bills-grid/__tests__/charge-nature-routing.integration.test.ts
 *
 * Proves (brief's three acceptance rows):
 *  a. tenant recurring nature:"expense", ENABLE_CHARGE_NATURE_ROUTING+ENABLE_EXPENSE_BILL
 *     ON → the charge's line lands on an EB- document, NEVER on IVTEN.
 *  b. same charge, ENABLE_CHARGE_NATURE_ROUTING OFF (EB flag still on) → lands on
 *     IVTEN, NO EB document minted (byte-identical to pre-feature — the mint also
 *     stamps nature null when the flag is off).
 *  c. tenant nature:"expense" but ENABLE_EXPENSE_BILL OFF → issuance FAILS CLOSED:
 *     the row's tx throws ChargeNatureDestinationDisabledError and rolls back
 *     (outcome "save_failed"); ZERO documents and ZERO charges persist — the expense
 *     is never mis-booked as KAEN revenue.
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

const ORG = "e6c00000-0000-4000-8000-000000000001";
const USER = "e6c00000-0000-4000-8000-000000000002";
const PROP = "e6c00000-0000-4000-8000-000000000003";
const APT = "e6c00000-0000-4000-8000-000000000004";
const ROOM = "e6c00000-0000-4000-8000-000000000005";
const OWNER_PARTY = "e6c00000-0000-4000-8000-000000000006";
const TENANT_PARTY = "e6c00000-0000-4000-8000-000000000007";
const TENANCY = "e6c00000-0000-4000-8000-000000000008";
const DEF1 = "e6c00000-0000-4000-8000-00000000000b";
const REV1 = "e6c00000-0000-4000-8000-00000000000e";

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
  await db.organization.create({ data: { id: ORG, name: "CNR", slug: "cnr", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" } });
  await db.user.create({ data: { id: USER, organizationId: ORG, email: "cnr@example.test", fullName: "CNR", status: "active", role: "manager", userType: "operator" } });
  await db.property.create({ data: { id: PROP, organizationId: ORG, name: "P", propertyCode: "P-CNR", propertyType: "residential", addressLine1: "1", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
  await db.party.create({ data: { id: OWNER_PARTY, organizationId: ORG, displayName: "Owner", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: TENANT_PARTY, organizationId: ORG, displayName: "Tenant", partyType: "individual", status: "active" } });
  await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "A-CNR", listingMode: "WHOLE" } });
  await db.listing.create({ data: { id: ROOM, organizationId: ORG, apartmentId: APT, listingType: "whole_unit", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER_PARTY } });
  await db.tenancy.create({ data: { id: TENANCY, organizationId: ORG, propertyId: PROP, unitId: ROOM, tenantPartyId: TENANT_PARTY, tenancyCode: "T-CNR", status: "active", billingStatus: "current", startDate: new Date("2026-01-01"), monthlyRentAmount: "2000.00", numberOfPax: 1 } });
  const entry = await db.unitBillsGridEntry.create({
    data: {
      organizationId: ORG, apartmentId: APT, periodMonth: PERIOD, createdBy: USER,
      tnbTotalRaw: "300.00", airSelangorRaw: "0.00", wifi: "0.00", cleaning: "0.00",
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

dn("bills-grid — nature:'expense' tenant charge routes to EB (Task 5)", () => {
  // ENABLE_PHASE2_BILLING_DOCS is the money-mint seam (the flag-gated issuance MINT only
  // runs under it); the routing flags are set per-test.
  beforeEach(async () => { await cleanup(); process.env.ENABLE_PHASE2_BILLING_DOCS = "true"; });
  afterEach(async () => {
    delete process.env.ENABLE_PHASE2_BILLING_DOCS;
    delete process.env.ENABLE_CHARGE_NATURE_ROUTING;
    delete process.env.ENABLE_EXPENSE_BILL;
    await cleanup();
  });

  it("row a — tenant recurring nature:'expense', ENABLE_CHARGE_NATURE_ROUTING+ENABLE_EXPENSE_BILL ON → lands on EB-, NO IVTEN line", async () => {
    const db = getDb();
    process.env.ENABLE_CHARGE_NATURE_ROUTING = "true";
    process.env.ENABLE_EXPENSE_BILL = "true";
    const { entryId, token } = await seedWholeUnit();
    const line = await addRecurringLine(entryId, { name: "Aircon service", amount: "30.00", bearer: "tenant", nature: "expense" });

    const r = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt: token }] });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.data.results[0].outcome).toBe("invoiced");

    // The minted recurring charge is chargeType "utility" (NOT a grid-expense charge) and
    // carries nature "expense" (Task-4 mint) — so its EB routing is driven PURELY by nature.
    const rc = await db.charge.findFirstOrThrow({ where: { organizationId: ORG, sourceRecurringLineId: line.id } });
    expect(rc.nature).toBe("expense");
    expect(rc.chargeType).toBe("utility");
    expect(rc.sourceGridExpenseId).toBeNull();

    // Its billing-document line lands on an Expense Bill (EB-), tenant counterparty.
    const dl = await db.billingDocumentLine.findFirstOrThrow({ where: { chargeId: rc.id } });
    const doc = await db.billingDocument.findUniqueOrThrow({ where: { id: dl.documentId } });
    expect(doc.documentNumber.startsWith("EB-")).toBe(true);
    expect(doc.counterpartyType).toBe("tenant");

    // NO IVTEN line anywhere references this expense charge.
    const ivtenLine = await db.billingDocumentLine.findFirst({
      where: { chargeId: rc.id, document: { documentNumber: { startsWith: "IVTEN-" } } },
    });
    expect(ivtenLine).toBeNull();
  });

  it("row b — same charge, ENABLE_CHARGE_NATURE_ROUTING OFF (EB flag still on) → lands on IVTEN, no EB document (byte-identical)", async () => {
    const db = getDb();
    delete process.env.ENABLE_CHARGE_NATURE_ROUTING; // nature routing OFF
    process.env.ENABLE_EXPENSE_BILL = "true";        // EB destination available, but inert without nature routing
    const { entryId, token } = await seedWholeUnit();
    const line = await addRecurringLine(entryId, { name: "Aircon service", amount: "30.00", bearer: "tenant", nature: "expense" });

    const r = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt: token }] });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.data.results[0].outcome).toBe("invoiced");

    const rc = await db.charge.findFirstOrThrow({ where: { organizationId: ORG, sourceRecurringLineId: line.id } });
    expect(rc.nature).toBeNull(); // flag OFF never stamps nature — mint byte-identical to pre-feature

    const dl = await db.billingDocumentLine.findFirstOrThrow({ where: { chargeId: rc.id } });
    const doc = await db.billingDocument.findUniqueOrThrow({ where: { id: dl.documentId } });
    expect(doc.documentNumber.startsWith("IVTEN-")).toBe(true);

    // Nature routing is fully inert — NO EB document was minted for this org.
    const ebCount = await db.billingDocument.count({ where: { organizationId: ORG, documentNumber: { startsWith: "EB-" } } });
    expect(ebCount).toBe(0);
  });

  it("row c — tenant nature:'expense' but ENABLE_EXPENSE_BILL OFF → issuance FAILS CLOSED (save_failed; no IVTEN revenue line, no charge)", async () => {
    const db = getDb();
    process.env.ENABLE_CHARGE_NATURE_ROUTING = "true";
    delete process.env.ENABLE_EXPENSE_BILL; // destination flag OFF → must NOT fall back to booking as IVTEN revenue
    const { entryId, token } = await seedWholeUnit();
    await addRecurringLine(entryId, { name: "Aircon service", amount: "30.00", bearer: "tenant", nature: "expense" });

    const r = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt: token }] });
    expect(r.ok).toBe(true); if (!r.ok) return;
    // The row's tx threw ChargeNatureDestinationDisabledError and rolled back → save_failed.
    expect(r.data.results[0].outcome).toBe("save_failed");

    // Fail-closed proof: NOTHING persisted — no revenue line, no charge — the expense was
    // never mis-booked as KAEN service revenue.
    expect(await db.billingDocument.count({ where: { organizationId: ORG } })).toBe(0);
    expect(await db.billingDocument.count({ where: { organizationId: ORG, documentNumber: { startsWith: "IVTEN-" } } })).toBe(0);
    expect(await db.charge.count({ where: { organizationId: ORG } })).toBe(0);
  });
});
