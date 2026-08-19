/**
 * Task 7b: materialize-on-open carries `nature`. getOrCreateEntry's materialize path is the
 * COMMON way a GridEntryRecurringLine snapshot is first written (a period opened for the first
 * time). Task 7 only wired `nature` into the OTHER writer (recurring.service.ts writeSnapshot,
 * the explicit re-apply path), so a line configured nature:"expense" but materialized on-open
 * used to snapshot nature:null and route as profit. This test pins the gap closed: a CUSTOM
 * revision with nature:"expense" must materialize a snapshot row with nature:"expense", while a
 * legacy (no-nature) revision must still materialize nature:null (additive, legacy unchanged).
 *
 * Real local Postgres only. Run: from apps/api
 *   set -a; . ../../.env; set +a; RUN_INTEGRATION=1 npx vitest run \
 *     src/modules/bills-grid/__tests__/recurring-materialize-nature.integration.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { getOrCreateEntry } from "../repository";
import { ensureChargeCategorySeeds } from "../../charge-categories/seed";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`Refusing non-local DB host: ${host}`);
}

const ORG = "c8500000-0000-4000-8000-0000000000b1";
const USER = "c8500000-0000-4000-8000-0000000000b2";
const PROP = "c8500000-0000-4000-8000-0000000000b3";
const APT = "c8500000-0000-4000-8000-0000000000b4"; // owner + active tenancy
const ROOM = "c8500000-0000-4000-8000-0000000000b5";
const OWNER_PARTY = "c8500000-0000-4000-8000-0000000000b6";
const TENANT_PARTY = "c8500000-0000-4000-8000-0000000000b7";
const TENANCY = "c8500000-0000-4000-8000-0000000000b8";

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

async function cleanup() {
  const db = getDb();
  await db.gridEntryRecurringLine.deleteMany({ where: { organizationId: ORG } });
  await db.recurringChargeRevision.deleteMany({ where: { definition: { organizationId: ORG } } });
  await db.recurringChargeDefinition.deleteMany({ where: { organizationId: ORG } });
  await db.unitBillsGridEntry.deleteMany({ where: { organizationId: ORG } });
  await db.unitBillsBearerConfig.deleteMany({ where: { organizationId: ORG } });
  await db.tenancy.deleteMany({ where: { organizationId: ORG } });
  await db.listing.deleteMany({ where: { organizationId: ORG } });
  await db.apartment.deleteMany({ where: { organizationId: ORG } });
  await db.property.deleteMany({ where: { organizationId: ORG } });
  await db.chargeCategory.deleteMany({ where: { organizationId: ORG } });
  await db.party.deleteMany({ where: { organizationId: ORG } });
  await db.user.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function seedOrg() {
  const db = getDb();
  await db.organization.create({ data: { id: ORG, name: "RN", slug: "rn", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" } });
  await db.user.create({ data: { id: USER, organizationId: ORG, email: "rn@example.test", fullName: "RN", status: "active", role: "manager", userType: "operator" } });
  await db.property.create({ data: { id: PROP, organizationId: ORG, name: "P", propertyCode: "P-RN", propertyType: "residential", addressLine1: "1", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
  await db.party.create({ data: { id: OWNER_PARTY, organizationId: ORG, displayName: "Owner", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: TENANT_PARTY, organizationId: ORG, displayName: "Tenant", partyType: "individual", status: "active" } });
  await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "A-RN", listingMode: "WHOLE" } });
  await db.listing.create({ data: { id: ROOM, organizationId: ORG, apartmentId: APT, listingType: "whole_unit", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER_PARTY } });
  await db.tenancy.create({ data: { id: TENANCY, organizationId: ORG, propertyId: PROP, unitId: ROOM, tenantPartyId: TENANT_PARTY, tenancyCode: "T-RN", status: "active", billingStatus: "current", startDate: new Date("2026-01-01"), monthlyRentAmount: "2000.00", numberOfPax: 1 } });
}

async function makeDef(kind: string, code: string, name: string, apartmentId = APT) {
  return getDb().recurringChargeDefinition.create({ data: { organizationId: ORG, apartmentId, kind, code, name, createdBy: USER } });
}
async function makeRev(
  definitionId: string,
  amount: string,
  bearer: string,
  from: string,
  to: string | null,
  enabled = true,
  categoryId: string | null = null,
  nature: string | null = null,
) {
  return getDb().recurringChargeRevision.create({ data: { definitionId, amount, bearer, categoryId, nature, effectiveFromMonth: d(from), effectiveToMonth: to ? d(to) : null, enabled, createdBy: USER } });
}
async function openPeriod(apartmentId: string, month: string) {
  return getDb().$transaction((tx) => getOrCreateEntry(tx, { orgId: ORG, apartmentId, periodMonth: d(month), actorUserId: USER }));
}

dn("bills-grid materialize-on-open carries nature (Task 7b)", () => {
  beforeEach(async () => {
    await cleanup();
    process.env.ENABLE_PHASE2_BILLING_DOCS = "true";
    await seedOrg();
  });
  afterEach(async () => {
    delete process.env.ENABLE_PHASE2_BILLING_DOCS;
    await cleanup();
  });

  it('owner-borne CUSTOM nature:"expense" → materialized GridEntryRecurringLine snapshots nature:"expense"', async () => {
    const db = getDb();
    await ensureChargeCategorySeeds(ORG);
    const cat = await db.chargeCategory.findFirstOrThrow({ where: { organizationId: ORG, code: "recurring_other_owner" }, select: { id: true } });
    const def = await makeDef("CUSTOM", "custom-exp", "Expense svc");
    await makeRev(def.id, "50.00", "owner", "2026-01-01", null, true, cat.id, "expense");

    const e = await openPeriod(APT, "2026-09-01");
    const lines = await db.gridEntryRecurringLine.findMany({ where: { gridEntryId: e.id } });
    expect(lines.length).toBe(1);
    expect(lines[0].nature).toBe("expense"); // was null before Task 7b (materialize dropped nature)
  });

  it("legacy CUSTOM with NO nature → materialized snapshot keeps nature:null (additive, unchanged)", async () => {
    const db = getDb();
    await ensureChargeCategorySeeds(ORG);
    const cat = await db.chargeCategory.findFirstOrThrow({ where: { organizationId: ORG, code: "recurring_other_owner" }, select: { id: true } });
    const def = await makeDef("CUSTOM", "custom-leg", "Legacy svc");
    await makeRev(def.id, "40.00", "owner", "2026-01-01", null, true, cat.id, null);

    const e = await openPeriod(APT, "2026-09-01");
    const lines = await db.gridEntryRecurringLine.findMany({ where: { gridEntryId: e.id } });
    expect(lines.length).toBe(1);
    expect(lines[0].nature).toBeNull();
  });
});
