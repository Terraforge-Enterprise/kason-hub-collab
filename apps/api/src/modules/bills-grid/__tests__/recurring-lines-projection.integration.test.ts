/**
 * Recurring dialog read (R9), unopened-period PROJECTION. listRecurringLinesService must show
 * the configured CUSTOM recurring line for a month whose grid entry does not exist yet — the
 * same line materialize-on-open (getOrCreateEntry) would write — WITHOUT creating the entry.
 * Before this feature the read returned [] whenever no entry existed, so the dialog looked
 * empty until an unrelated write (an expense edit) first opened the period.
 *
 * Self-isolated ORG (parallel-safe). Real local Postgres only. Run: from apps/api
 *   set -a; . ../../.env; set +a; RUN_INTEGRATION=1 npx vitest run \
 *     src/modules/bills-grid/__tests__/recurring-lines-projection.integration.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { getOrCreateEntry } from "../repository";
import { listRecurringLinesService } from "../recurring.service";
import { ensureChargeCategorySeeds } from "../../charge-categories/seed";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`Refusing non-local DB host: ${host}`);
}

const ORG = "c8510000-0000-4000-8000-000000000001";
const USER = "c8510000-0000-4000-8000-000000000002";
const PROP = "c8510000-0000-4000-8000-000000000003";
const APT = "c8510000-0000-4000-8000-000000000004"; // owner + active tenancy
const ROOM = "c8510000-0000-4000-8000-000000000005";
const OWNER_PARTY = "c8510000-0000-4000-8000-000000000006";
const TENANT_PARTY = "c8510000-0000-4000-8000-000000000007";
const TENANCY = "c8510000-0000-4000-8000-000000000008";
const APT_NOTEN = "c8510000-0000-4000-8000-000000000009"; // owner, NO active tenancy
const ROOM2 = "c8510000-0000-4000-8000-00000000000a";

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const strip = (l: { name: string; amount: string; bearer: string; categoryName: string }) => ({ name: l.name, amount: l.amount, bearer: l.bearer, categoryName: l.categoryName });

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
  await db.organization.create({ data: { id: ORG, name: "RM", slug: "rm-proj", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" } });
  await db.user.create({ data: { id: USER, organizationId: ORG, email: "rm-proj@example.test", fullName: "RM", status: "active", role: "manager", userType: "operator" } });
  await db.property.create({ data: { id: PROP, organizationId: ORG, name: "P", propertyCode: "P-RMP", propertyType: "residential", addressLine1: "1", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
  await db.party.create({ data: { id: OWNER_PARTY, organizationId: ORG, displayName: "Owner", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: TENANT_PARTY, organizationId: ORG, displayName: "Tenant", partyType: "individual", status: "active" } });
  await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "A-RMP", listingMode: "WHOLE" } });
  await db.listing.create({ data: { id: ROOM, organizationId: ORG, apartmentId: APT, listingType: "whole_unit", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER_PARTY } });
  await db.tenancy.create({ data: { id: TENANCY, organizationId: ORG, propertyId: PROP, unitId: ROOM, tenantPartyId: TENANT_PARTY, tenancyCode: "T-RMP", status: "active", billingStatus: "current", startDate: new Date("2026-01-01"), monthlyRentAmount: "2000.00", numberOfPax: 1 } });
  await db.apartment.create({ data: { id: APT_NOTEN, organizationId: ORG, propertyId: PROP, unitCode: "B-RMP", listingMode: "WHOLE" } });
  await db.listing.create({ data: { id: ROOM2, organizationId: ORG, apartmentId: APT_NOTEN, listingType: "whole_unit", occupancyStatus: "vacant", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER_PARTY } });
}

async function makeDef(kind: string, code: string, name: string, apartmentId = APT) {
  return getDb().recurringChargeDefinition.create({ data: { organizationId: ORG, apartmentId, kind, code, name, createdBy: USER } });
}
async function makeRev(definitionId: string, amount: string, bearer: string, from: string, to: string | null, enabled = true, categoryId: string | null = null) {
  return getDb().recurringChargeRevision.create({ data: { definitionId, amount, bearer, categoryId, effectiveFromMonth: d(from), effectiveToMonth: to ? d(to) : null, enabled, createdBy: USER } });
}
async function openPeriod(apartmentId: string, month: string) {
  return getDb().$transaction((tx) => getOrCreateEntry(tx, { orgId: ORG, apartmentId, periodMonth: d(month), actorUserId: USER }));
}
async function ownerCat() {
  await ensureChargeCategorySeeds(ORG);
  return getDb().chargeCategory.findFirstOrThrow({ where: { organizationId: ORG, code: "recurring_other_owner" }, select: { id: true, name: true } });
}
async function readLines(apartmentId: string, period: string) {
  const r = await listRecurringLinesService({ orgId: ORG }, apartmentId, period);
  if (!r.ok) throw new Error(`listRecurringLinesService failed: ${r.status} ${r.error}`);
  return r.data.lines;
}

dn("bills-grid recurring dialog read — unopened-period projection (R9)", () => {
  beforeEach(async () => {
    await cleanup();
    process.env.ENABLE_PHASE2_BILLING_DOCS = "true";
    await seedOrg();
  });
  afterEach(async () => {
    delete process.env.ENABLE_PHASE2_BILLING_DOCS;
    await cleanup();
  });

  it("no grid entry yet + enabled owner CUSTOM def → read PROJECTS the configured line and writes nothing", async () => {
    const db = getDb();
    const cat = await ownerCat();
    const def = await makeDef("CUSTOM", "custom-svc", "Service fee");
    await makeRev(def.id, "900.00", "owner", "2026-01-01", null, true, cat.id);

    expect(await db.unitBillsGridEntry.count({ where: { organizationId: ORG, apartmentId: APT } })).toBe(0);

    const lines = await readLines(APT, "2026-09-01");
    expect(lines.length).toBe(1);
    expect(lines[0].name).toBe("Service fee");
    expect(lines[0].amount).toBe("900.00");
    expect(lines[0].bearer).toBe("owner");
    expect(lines[0].categoryName).toBe(cat.name);

    // Read is side-effect free — it must NOT open the period.
    expect(await db.unitBillsGridEntry.count({ where: { organizationId: ORG, apartmentId: APT } })).toBe(0);
    expect(await db.gridEntryRecurringLine.count({ where: { organizationId: ORG } })).toBe(0);
  });

  it("projection == materialization: opening the period yields an identical single line (no drift, no double-count)", async () => {
    const cat = await ownerCat();
    const def = await makeDef("CUSTOM", "custom-svc", "Service fee");
    await makeRev(def.id, "900.00", "owner", "2026-01-01", null, true, cat.id);

    const projected = await readLines(APT, "2026-09-01");
    await openPeriod(APT, "2026-09-01"); // materialize-on-open
    const materialized = await readLines(APT, "2026-09-01");

    expect(materialized.length).toBe(1);
    expect(projected.map(strip)).toEqual(materialized.map(strip));
  });

  it("flag OFF → projection empty (byte-identical legacy: no recurring surfaced pre-open)", async () => {
    delete process.env.ENABLE_PHASE2_BILLING_DOCS;
    const cat = await ownerCat();
    const def = await makeDef("CUSTOM", "custom-svc", "Service fee");
    await makeRev(def.id, "900.00", "owner", "2026-01-01", null, true, cat.id);
    expect((await readLines(APT, "2026-09-01")).length).toBe(0);
  });

  it("tenant-borne CUSTOM with no active tenancy → projection empty (mirrors materialize fail-closed)", async () => {
    await ensureChargeCategorySeeds(ORG);
    const cat = await getDb().chargeCategory.findFirstOrThrow({ where: { organizationId: ORG, code: "recurring_other_tenant" }, select: { id: true } });
    const def = await makeDef("CUSTOM", "custom-tfee", "Tenant fee", APT_NOTEN);
    await makeRev(def.id, "30.00", "tenant", "2026-01-01", null, true, cat.id);
    expect((await readLines(APT_NOTEN, "2026-09-01")).length).toBe(0);
  });

  it("no recurring config → projection empty (genuine empty state preserved)", async () => {
    expect((await readLines(APT, "2026-09-01")).length).toBe(0);
  });

  it("disabled applicable revision → projection empty", async () => {
    const cat = await ownerCat();
    const def = await makeDef("CUSTOM", "custom-x", "X");
    await makeRev(def.id, "50.00", "owner", "2026-01-01", null, false, cat.id);
    expect((await readLines(APT, "2026-09-01")).length).toBe(0);
  });

  it("period BEFORE the earliest effectiveFrom → projection empty (no applicable revision)", async () => {
    const cat = await ownerCat();
    const def = await makeDef("CUSTOM", "custom-svc", "Service fee");
    await makeRev(def.id, "900.00", "owner", "2026-10-01", null, true, cat.id);
    expect((await readLines(APT, "2026-08-01")).length).toBe(0); // Aug < Oct
  });
});
