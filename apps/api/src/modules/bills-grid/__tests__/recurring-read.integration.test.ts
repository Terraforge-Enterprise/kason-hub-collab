/**
 * Task 8 (backend): the batched grid read surfaces per-row CUSTOM recurring totals
 * (GridRowDto.recurring), owner/tenant split, cleaning/WiFi EXCLUDED (R9). Real local Postgres.
 * Run: from apps/api
 *   set -a; . ../../.env; set +a; RUN_INTEGRATION=1 npx vitest run \
 *     src/modules/bills-grid/__tests__/recurring-read.integration.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { getGridService } from "../service";
import { ensureChargeCategorySeeds } from "../../charge-categories/seed";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`Refusing non-local DB host: ${host}`);
}

const ORG = "cc500000-0000-4000-8000-000000000001";
const USER = "cc500000-0000-4000-8000-000000000002";
const PROP = "cc500000-0000-4000-8000-000000000003";
const APT = "cc500000-0000-4000-8000-000000000004";
const ROOM = "cc500000-0000-4000-8000-000000000005";
const OWNER_PARTY = "cc500000-0000-4000-8000-000000000006";
const TENANT_PARTY = "cc500000-0000-4000-8000-000000000007";
const TENANCY = "cc500000-0000-4000-8000-000000000008";
const PERIOD_STR = "2026-05-01";
const PERIOD = new Date(`${PERIOD_STR}T00:00:00.000Z`);
const session = { orgId: ORG, userId: USER, role: "manager" };

async function cleanup() {
  const db = getDb();
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
  await db.user.deleteMany({ where: { organizationId: ORG } });
  await db.party.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function seed() {
  const db = getDb();
  await db.organization.create({ data: { id: ORG, name: "RR", slug: "rr", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" } });
  await db.user.create({ data: { id: USER, organizationId: ORG, email: "rr@example.test", fullName: "RR", status: "active", role: "manager", userType: "operator" } });
  await db.property.create({ data: { id: PROP, organizationId: ORG, name: "P", propertyCode: "P-RR", propertyType: "residential", addressLine1: "1", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
  await db.party.create({ data: { id: OWNER_PARTY, organizationId: ORG, displayName: "Owner", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: TENANT_PARTY, organizationId: ORG, displayName: "Tenant", partyType: "individual", status: "active" } });
  await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "A-RR", listingMode: "WHOLE" } });
  await db.listing.create({ data: { id: ROOM, organizationId: ORG, apartmentId: APT, listingType: "whole_unit", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER_PARTY } });
  await db.tenancy.create({ data: { id: TENANCY, organizationId: ORG, propertyId: PROP, unitId: ROOM, tenantPartyId: TENANT_PARTY, tenancyCode: "T-RR", status: "active", billingStatus: "current", startDate: new Date("2026-01-01"), monthlyRentAmount: "2000.00", numberOfPax: 1 } });
  const entry = await db.unitBillsGridEntry.create({
    data: { organizationId: ORG, apartmentId: APT, periodMonth: PERIOD, createdBy: USER, cleaning: "100.00", wifi: "40.00", tnbPattern: "recharged", airPattern: "recharged", cleaningBearer: "owner", wifiBearer: "owner", maintenanceFeeBearer: "owner" },
  });
  await ensureChargeCategorySeeds(ORG);
  const ownerCat = await db.chargeCategory.findFirstOrThrow({ where: { organizationId: ORG, code: "recurring_other_owner" }, select: { id: true, name: true, family: true } });
  const tenantCat = await db.chargeCategory.findFirstOrThrow({ where: { organizationId: ORG, code: "recurring_other_tenant" }, select: { id: true, name: true, family: true } });
  const mkLine = (defId: string, amount: string, bearer: "owner" | "tenant", cat: { id: string; name: string; family: string }, name: string) =>
    db.gridEntryRecurringLine.create({
      data: {
        organizationId: ORG, gridEntryId: entry.id, definitionId: defId, revisionId: defId, name, amount, bearer,
        categoryId: cat.id, categoryCode: bearer === "owner" ? "recurring_other_owner" : "recurring_other_tenant", categoryName: cat.name, categoryFamily: cat.family,
        resolvedPartyId: bearer === "owner" ? OWNER_PARTY : TENANT_PARTY, resolvedTenancyId: bearer === "owner" ? null : TENANCY, resolvedUnitId: ROOM, effectiveMonth: PERIOD, kind: "CUSTOM",
      },
    });
  await mkLine("cc500000-0000-4000-8000-0000000000a1", "70.00", "owner", ownerCat, "Service fee");
  await mkLine("cc500000-0000-4000-8000-0000000000a2", "50.00", "owner", ownerCat, "Insurance");
  await mkLine("cc500000-0000-4000-8000-0000000000a3", "30.00", "tenant", tenantCat, "Late fee");
}

dn("bills-grid grid read — recurring totals (Task 8)", () => {
  beforeEach(async () => { await cleanup(); process.env.ENABLE_PHASE2_BILLING_DOCS = "true"; await seed(); });
  afterEach(async () => { delete process.env.ENABLE_PHASE2_BILLING_DOCS; await cleanup(); });

  it("GridRowDto.recurring carries owner total 120 (count 2) + tenant total 30 (count 1); cleaning/WiFi excluded", async () => {
    const r = await getGridService(session, { period: PERIOD_STR, months: 1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const row = r.data.rows.find((x) => x.apartmentId === APT);
    expect(row).toBeTruthy();
    expect(row!.recurring.owner.total).toBe("120.00"); // 70 + 50
    expect(row!.recurring.owner.count).toBe(2);
    expect(row!.recurring.tenant.total).toBe("30.00");
    expect(row!.recurring.tenant.count).toBe(1);
    // cleaning (100) + wifi (40) are NOT counted in the recurring totals (R9) — they have their
    // own columns. The recurring owner total is exactly the two CUSTOM lines, not 100+70+50.
    expect(row!.recurring.owner.total).not.toBe("220.00");
  });

  it("lock flags (R6 refined): enabled CLEANING def → cleaningRecurringLocked true; disabled WIFI def → wifiRecurringLocked false", async () => {
    const db = getDb();
    const cdef = await db.recurringChargeDefinition.create({ data: { organizationId: ORG, apartmentId: APT, kind: "CLEANING", code: "cleaning", name: "Cleaning", createdBy: USER } });
    await db.recurringChargeRevision.create({ data: { definitionId: cdef.id, amount: "100.00", bearer: "owner", categoryId: null, effectiveFromMonth: PERIOD, effectiveToMonth: null, enabled: true, createdBy: USER } });
    const wdef = await db.recurringChargeDefinition.create({ data: { organizationId: ORG, apartmentId: APT, kind: "WIFI", code: "wifi", name: "WiFi", createdBy: USER } });
    await db.recurringChargeRevision.create({ data: { definitionId: wdef.id, amount: "0.00", bearer: "owner", categoryId: null, effectiveFromMonth: PERIOD, effectiveToMonth: null, enabled: false, createdBy: USER } });

    const r = await getGridService(session, { period: PERIOD_STR, months: 1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const row = r.data.rows.find((x) => x.apartmentId === APT);
    expect(row!.cleaningRecurringLocked).toBe(true); // enabled def governs → read-only
    expect(row!.wifiRecurringLocked).toBe(false); // disabled def → editable per-month
    expect(row!.cleaningRecurringAmount).toBe("100.00"); // generated amount surfaced for display
    expect(row!.wifiRecurringAmount).toBeNull(); // ungoverned → no generated amount
  });

  it("an apartment-month with no recurring lines returns zero totals", async () => {
    const db = getDb();
    await db.gridEntryRecurringLine.deleteMany({ where: { organizationId: ORG } });
    const r = await getGridService(session, { period: PERIOD_STR, months: 1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const row = r.data.rows.find((x) => x.apartmentId === APT);
    expect(row!.recurring.owner).toEqual({ total: "0.00", count: 0 });
    expect(row!.recurring.tenant).toEqual({ total: "0.00", count: 0 });
  });
});
