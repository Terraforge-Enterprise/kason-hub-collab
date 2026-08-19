/**
 * Task 5: billing + re-Bill integration for CUSTOM recurring lines (spec R7).
 * HIGHEST money risk. Real local Postgres only, dedicated org, flag-gated.
 * Run: from apps/api
 *   set -a; . ../../.env; set +a; RUN_INTEGRATION=1 npx vitest run \
 *     src/modules/bills-grid/__tests__/recurring-bill.integration.test.ts
 *
 * Proves:
 *  (a) one tenant-borne custom line → exactly one Charge with sourceRecurringLineId set, routed
 *      to the tenant IVTEN, appearing as its own invoice line.
 *  (b) re-Bill (confirmed, after a utility change) → the old recurring Charge is credited and
 *      exactly ONE fresh recurring Charge is issued (no duplicate live charge).
 *  (c) one owner-borne custom line → its amount is inside ownerBorne, the owner IVOWN carries it,
 *      and the mint Σ-invariant holds (outcome invoiced, not save_failed).
 *  (d) two same-amount owner custom lines both mint (the amount-dedup index exempts recurring).
 *  (e) an enabled applicable CUSTOM def with NO materialized line on first Bill → recurring_unresolved
 *      (fail-closed, billedAt still null, nothing minted).
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

const ORG = "c9500000-0000-4000-8000-000000000001";
const USER = "c9500000-0000-4000-8000-000000000002";
const PROP = "c9500000-0000-4000-8000-000000000003";
const APT = "c9500000-0000-4000-8000-000000000004";
const ROOM = "c9500000-0000-4000-8000-000000000005";
const OWNER_PARTY = "c9500000-0000-4000-8000-000000000006";
const TENANT_PARTY = "c9500000-0000-4000-8000-000000000007";
const TENANCY = "c9500000-0000-4000-8000-000000000008";
const APT_NOTEN = "c9500000-0000-4000-8000-000000000009";
const ROOM2 = "c9500000-0000-4000-8000-00000000000a";
const DEF1 = "c9500000-0000-4000-8000-00000000000b";
const DEF2 = "c9500000-0000-4000-8000-00000000000c";
const DEF3 = "c9500000-0000-4000-8000-00000000000d";
const REV1 = "c9500000-0000-4000-8000-00000000000e";

const session = { orgId: ORG, userId: USER, role: "manager" };
// Re-Bill is allowed only for the org-local current month — bill in it so (b) can re-Bill.
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
  await db.organization.create({ data: { id: ORG, name: "RB", slug: "rb", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" } });
  await db.user.create({ data: { id: USER, organizationId: ORG, email: "rb@example.test", fullName: "RB", status: "active", role: "manager", userType: "operator" } });
  await db.property.create({ data: { id: PROP, organizationId: ORG, name: "P", propertyCode: "P-RB", propertyType: "residential", addressLine1: "1", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
  await db.party.create({ data: { id: OWNER_PARTY, organizationId: ORG, displayName: "Owner", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: TENANT_PARTY, organizationId: ORG, displayName: "Tenant", partyType: "individual", status: "active" } });
  await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "A-RB", listingMode: "WHOLE" } });
  await db.listing.create({ data: { id: ROOM, organizationId: ORG, apartmentId: APT, listingType: "whole_unit", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER_PARTY } });
  await db.tenancy.create({ data: { id: TENANCY, organizationId: ORG, propertyId: PROP, unitId: ROOM, tenantPartyId: TENANT_PARTY, tenancyCode: "T-RB", status: "active", billingStatus: "current", startDate: new Date("2026-01-01"), monthlyRentAmount: "2000.00", numberOfPax: 1 } });
  const entry = await db.unitBillsGridEntry.create({
    data: {
      organizationId: ORG, apartmentId: APT, periodMonth: PERIOD, createdBy: USER,
      tnbTotalRaw: "300.00", airSelangorRaw: "0.00", wifi: "120.00", cleaning: "0.00",
      tnbPattern: "absorbed", airPattern: "recharged", cleaningBearer: "owner", wifiBearer: "tenant", maintenanceFeeBearer: "owner",
    },
  });
  await db.gridMeterReading.create({ data: { organizationId: ORG, entryId: entry.id, apartmentId: APT, periodMonth: PERIOD, listingId: ROOM, tenancyId: null, partyId: null, amount: "0.00", createdBy: USER } });
  return { entryId: entry.id, token: entry.updatedAt.toISOString() };
}

async function catId(code: string): Promise<string> {
  await ensureChargeCategorySeeds(ORG);
  return (await getDb().chargeCategory.findFirstOrThrow({ where: { organizationId: ORG, code }, select: { id: true } })).id;
}

async function addRecurringLine(entryId: string, opts: { id?: string; definitionId?: string; name: string; amount: string; bearer: "owner" | "tenant" }) {
  await ensureChargeCategorySeeds(ORG);
  const code = opts.bearer === "owner" ? "recurring_other_owner" : "recurring_other_tenant";
  const cat = await getDb().chargeCategory.findFirstOrThrow({ where: { organizationId: ORG, code }, select: { id: true, name: true, family: true } });
  return getDb().gridEntryRecurringLine.create({
    data: {
      organizationId: ORG, gridEntryId: entryId, definitionId: opts.definitionId ?? DEF1, revisionId: REV1,
      name: opts.name, amount: opts.amount, bearer: opts.bearer,
      categoryId: cat.id, categoryCode: code, categoryName: cat.name, categoryFamily: cat.family,
      resolvedPartyId: opts.bearer === "owner" ? OWNER_PARTY : TENANT_PARTY,
      resolvedTenancyId: opts.bearer === "owner" ? null : TENANCY,
      resolvedUnitId: ROOM, effectiveMonth: PERIOD, kind: "CUSTOM",
    },
  });
}

dn("bills-grid recurring billing + re-Bill (Task 5)", () => {
  beforeEach(async () => { await cleanup(); process.env.ENABLE_PHASE2_BILLING_DOCS = "true"; });
  afterEach(async () => { delete process.env.ENABLE_PHASE2_BILLING_DOCS; await cleanup(); });

  it("(a) tenant-borne custom line → one Charge with sourceRecurringLineId, routed to the tenant IVTEN as its own line", async () => {
    const db = getDb();
    const { entryId, token } = await seedWholeUnit();
    await catId("recurring_other_tenant");
    const line = await addRecurringLine(entryId, { name: "Late fee", amount: "30.00", bearer: "tenant" });

    const r = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt: token }] });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.data.results[0].outcome).toBe("invoiced");

    const rc = await db.charge.findMany({ where: { organizationId: ORG, sourceRecurringLineId: { not: null } } });
    expect(rc.length).toBe(1);
    expect(rc[0].sourceRecurringLineId).toBe(line.id);
    expect(rc[0].sourceGridEntryId).toBe(entryId); // BOTH provenance stamps (R7)
    expect(rc[0].partyId).toBe(TENANT_PARTY);
    expect(rc[0].tenancyId).toBe(TENANCY);
    expect(rc[0].amount.toString()).toBe("30");
    expect(rc[0].chargeNumber).toContain("GRIDRECUR-");
    // Its own invoice line on a tenant (IVTEN) document.
    const dl = await db.billingDocumentLine.findFirstOrThrow({ where: { chargeId: rc[0].id }, include: { document: true } });
    expect(dl.document.counterpartyType).toBe("tenant");
    expect(dl.document.documentStatus).toBe("ISSUED");
  });

  it("(b) re-Bill (confirmed) credits the old recurring Charge and issues exactly one fresh — no duplicate", async () => {
    const db = getDb();
    const { entryId, token } = await seedWholeUnit();
    await addRecurringLine(entryId, { name: "Late fee", amount: "30.00", bearer: "tenant" });
    const first = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt: token }] });
    expect(first.ok && first.data.results[0].outcome).toBe("invoiced");

    // Force a real change (utility) so the re-Bill is not a no-op, then re-Bill confirmed.
    await db.unitBillsGridEntry.update({ where: { id: entryId }, data: { wifi: "150.00" } });
    const fresh = await db.unitBillsGridEntry.findUniqueOrThrow({ where: { id: entryId } });
    const r = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt: fresh.updatedAt.toISOString(), confirmRebill: true }] });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.data.results[0].outcome).toBe("reinvoiced");

    const recur = await db.charge.findMany({ where: { organizationId: ORG, sourceRecurringLineId: { not: null } }, select: { status: true, chargeNumber: true } });
    // Exactly one LIVE recurring charge; the prior generation is credited (no duplicate live).
    const live = recur.filter((c) => c.status === "posted");
    const credited = recur.filter((c) => c.status === "credited");
    expect(live.length).toBe(1);
    expect(credited.length).toBe(1);
    expect(live[0].chargeNumber).toContain("-r1"); // re-mint suffix
  });

  it("(c) owner-borne custom line → included in ownerBorne, carried on the owner IVOWN, Σ-invariant holds", async () => {
    const db = getDb();
    const { entryId, token } = await seedWholeUnit();
    const line = await addRecurringLine(entryId, { name: "Service fee", amount: "50.00", bearer: "owner" });

    const r = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt: token }] });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.data.results[0].outcome).toBe("invoiced"); // Σ held (else save_failed)

    const rc = await db.charge.findFirstOrThrow({ where: { organizationId: ORG, sourceRecurringLineId: line.id } });
    expect(rc.partyId).toBe(OWNER_PARTY);
    expect(rc.tenancyId).toBeNull();
    expect(rc.amount.toString()).toBe("50");
    const dl = await db.billingDocumentLine.findFirstOrThrow({ where: { chargeId: rc.id }, include: { document: true } });
    expect(dl.document.counterpartyType).toBe("owner");
  });

  it("(d) two same-amount owner custom lines both mint (amount-dedup index exempts recurring)", async () => {
    const db = getDb();
    const { entryId, token } = await seedWholeUnit();
    await addRecurringLine(entryId, { id: DEF1, definitionId: DEF1, name: "Service fee", amount: "50.00", bearer: "owner" });
    await addRecurringLine(entryId, { id: DEF2, definitionId: DEF2, name: "Insurance", amount: "50.00", bearer: "owner" });

    const r = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt: token }] });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.data.results[0].outcome).toBe("invoiced");
    const rc = await db.charge.findMany({ where: { organizationId: ORG, sourceRecurringLineId: { not: null } } });
    expect(rc.length).toBe(2); // both minted despite identical (unit, category, month, amount)
    expect(new Set(rc.map((c) => c.sourceRecurringLineId)).size).toBe(2);
  });

  it("(e) first Bill with an enabled applicable CUSTOM def but NO materialized line → recurring_unresolved, nothing minted", async () => {
    const db = getDb();
    // Apartment with an owner but no active tenancy; a tenant-borne def enabled+applicable, NO line.
    await db.organization.create({ data: { id: ORG, name: "RB", slug: "rb", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" } });
    await db.user.create({ data: { id: USER, organizationId: ORG, email: "rb@example.test", fullName: "RB", status: "active", role: "manager", userType: "operator" } });
    await db.property.create({ data: { id: PROP, organizationId: ORG, name: "P", propertyCode: "P-RB", propertyType: "residential", addressLine1: "1", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
    await db.party.create({ data: { id: OWNER_PARTY, organizationId: ORG, displayName: "Owner", partyType: "individual", status: "active" } });
    await db.apartment.create({ data: { id: APT_NOTEN, organizationId: ORG, propertyId: PROP, unitCode: "B-RB", listingMode: "WHOLE" } });
    await db.listing.create({ data: { id: ROOM2, organizationId: ORG, apartmentId: APT_NOTEN, listingType: "whole_unit", occupancyStatus: "vacant", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER_PARTY } });
    const cat = await catId("recurring_other_tenant");
    await db.recurringChargeDefinition.create({ data: { id: DEF3, organizationId: ORG, apartmentId: APT_NOTEN, kind: "CUSTOM", code: "custom-tfee", name: "Tenant fee", createdBy: USER } });
    await db.recurringChargeRevision.create({ data: { definitionId: DEF3, amount: "30.00", bearer: "tenant", categoryId: cat, effectiveFromMonth: PERIOD, effectiveToMonth: null, enabled: true, createdBy: USER } });
    const entry = await db.unitBillsGridEntry.create({
      data: { organizationId: ORG, apartmentId: APT_NOTEN, periodMonth: PERIOD, createdBy: USER, tnbTotalRaw: "0.00", airSelangorRaw: "0.00", wifi: "0.00", cleaning: "0.00", tnbPattern: "recharged", airPattern: "recharged", cleaningBearer: "owner", wifiBearer: "owner", maintenanceFeeBearer: "owner" },
    });

    const r = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT_NOTEN, expectedUpdatedAt: entry.updatedAt.toISOString() }] });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.data.results[0].outcome).toBe("recurring_unresolved");
    const after = await db.unitBillsGridEntry.findUniqueOrThrow({ where: { id: entry.id } });
    expect(after.billedAt).toBeNull();
    expect(after.invoicedAt).toBeNull();
    expect(await db.charge.count({ where: { organizationId: ORG } })).toBe(0);
  });
});
