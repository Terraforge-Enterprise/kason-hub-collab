/**
 * Task 4: materialize-on-open. When getOrCreateEntry first creates a period entry (flag-on),
 * it materializes EVERY definition whose applicable revision has effectiveFromMonth <= period
 * and is enabled: CLEANING/WIFI into the scalar fields, CUSTOM into a GridEntryRecurringLine.
 * The applicable revision is chosen by effective range (spec R1/R4), not by "first touch".
 * A CUSTOM target that cannot resolve is NOT materialized (no line) — a fail-closed marker
 * billing later surfaces as a conflict (Task 5), never a silent wrong-party line.
 *
 * Real local Postgres only. Run: from apps/api
 *   set -a; . ../../.env; set +a; RUN_INTEGRATION=1 npx vitest run \
 *     src/modules/bills-grid/__tests__/recurring-materialize.integration.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { getOrCreateEntry, resolveBearerConfig } from "../repository";
import { ensureChargeCategorySeeds } from "../../charge-categories/seed";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`Refusing non-local DB host: ${host}`);
}

const ORG = "c8500000-0000-4000-8000-000000000001";
const USER = "c8500000-0000-4000-8000-000000000002";
const PROP = "c8500000-0000-4000-8000-000000000003";
const APT = "c8500000-0000-4000-8000-000000000004"; // owner + active tenancy
const ROOM = "c8500000-0000-4000-8000-000000000005";
const OWNER_PARTY = "c8500000-0000-4000-8000-000000000006";
const TENANT_PARTY = "c8500000-0000-4000-8000-000000000007";
const TENANCY = "c8500000-0000-4000-8000-000000000008";
const APT_NOTEN = "c8500000-0000-4000-8000-000000000009"; // owner, NO active tenancy
const ROOM2 = "c8500000-0000-4000-8000-00000000000a";

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
  await db.organization.create({ data: { id: ORG, name: "RM", slug: "rm", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" } });
  await db.user.create({ data: { id: USER, organizationId: ORG, email: "rm@example.test", fullName: "RM", status: "active", role: "manager", userType: "operator" } });
  await db.property.create({ data: { id: PROP, organizationId: ORG, name: "P", propertyCode: "P-RM", propertyType: "residential", addressLine1: "1", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
  await db.party.create({ data: { id: OWNER_PARTY, organizationId: ORG, displayName: "Owner", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: TENANT_PARTY, organizationId: ORG, displayName: "Tenant", partyType: "individual", status: "active" } });
  await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "A-RM", listingMode: "WHOLE" } });
  await db.listing.create({ data: { id: ROOM, organizationId: ORG, apartmentId: APT, listingType: "whole_unit", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER_PARTY } });
  await db.tenancy.create({ data: { id: TENANCY, organizationId: ORG, propertyId: PROP, unitId: ROOM, tenantPartyId: TENANT_PARTY, tenancyCode: "T-RM", status: "active", billingStatus: "current", startDate: new Date("2026-01-01"), monthlyRentAmount: "2000.00", numberOfPax: 1 } });
  await db.apartment.create({ data: { id: APT_NOTEN, organizationId: ORG, propertyId: PROP, unitCode: "B-RM", listingMode: "WHOLE" } });
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

dn("bills-grid materialize-on-open (Task 4)", () => {
  beforeEach(async () => {
    await cleanup();
    process.env.ENABLE_PHASE2_BILLING_DOCS = "true";
    await seedOrg();
  });
  afterEach(async () => {
    delete process.env.ENABLE_PHASE2_BILLING_DOCS;
    await cleanup();
  });

  it("CLEANING RM100 from Jan + RM120 from Oct → opening September materializes 100 (Jan revision governs)", async () => {
    const def = await makeDef("CLEANING", "cleaning", "Cleaning");
    await makeRev(def.id, "100.00", "owner", "2026-01-01", "2026-10-01");
    await makeRev(def.id, "120.00", "owner", "2026-10-01", null);

    const sep = await openPeriod(APT, "2026-09-01");
    expect(sep.cleaning?.toString()).toBe("100");
    // One writer per fact (2026-08-06): the revision governs the AMOUNT only; the bearer
    // comes from the unit's config (WHOLE-mode default = tenant), never the revision's
    // "owner" — a stale revision must not out-vote a saved bearer flip.
    expect(sep.cleaningBearer).toBe("tenant");

    const oct = await openPeriod(APT, "2026-10-01");
    expect(oct.cleaning?.toString()).toBe("120"); // Oct revision governs
  });

  it("a config bearer flip wins over a stale revision bearer when a new month opens", async () => {
    const db = getDb();
    const def = await makeDef("WIFI", "wifi", "WiFi");
    // Revision written back when WiFi was tenant-borne — the stale two-writer state.
    await makeRev(def.id, "89.00", "tenant", "2026-01-01", null);
    // Admin flips WiFi to owner in the Unit-setting drawer → the config row updates.
    await db.$transaction((tx) => resolveBearerConfig(tx, { orgId: ORG, apartmentId: APT }));
    await db.unitBillsBearerConfig.update({
      where: { organizationId_apartmentId: { organizationId: ORG, apartmentId: APT } },
      data: { wifiBearer: "owner" },
    });
    const nov = await openPeriod(APT, "2026-11-01");
    expect(nov.wifi?.toString()).toBe("89"); // amount still from the revision
    expect(nov.wifiBearer).toBe("owner"); // bearer from the config — the flip sticks
  });

  it("period BEFORE the earliest effectiveFrom falls back to the config seed (never rewrites earlier months)", async () => {
    const db = getDb();
    // Config seed cleaning defaults to 100; def only governs from Oct.
    const def = await makeDef("CLEANING", "cleaning", "Cleaning");
    await makeRev(def.id, "120.00", "owner", "2026-10-01", null);
    const aug = await openPeriod(APT, "2026-08-01");
    // No applicable revision for Aug → falls back to cfg.cleaningRecurringAmount (default 100).
    expect(aug.cleaning?.toString()).toBe("100");
    await db.unitBillsGridEntry.findMany({ where: { organizationId: ORG } }); // touch
  });

  it("owner-borne CUSTOM enabled → materializes one GridEntryRecurringLine resolved to the owner", async () => {
    const db = getDb();
    await ensureChargeCategorySeeds(ORG);
    const cat = await db.chargeCategory.findFirstOrThrow({ where: { organizationId: ORG, code: "recurring_other_owner" }, select: { id: true } });
    const def = await makeDef("CUSTOM", "custom-svc", "Service fee");
    await makeRev(def.id, "50.00", "owner", "2026-01-01", null, true, cat.id);

    const e = await openPeriod(APT, "2026-09-01");
    const lines = await db.gridEntryRecurringLine.findMany({ where: { gridEntryId: e.id } });
    expect(lines.length).toBe(1);
    expect(lines[0].amount.toString()).toBe("50");
    expect(lines[0].resolvedPartyId).toBe(OWNER_PARTY);
    expect(lines[0].resolvedTenancyId).toBeNull();
    expect(lines[0].categoryFamily).toBe("owner_income");
  });

  it("tenant-borne CUSTOM with NO active tenancy → NO line materialized (fail-closed marker, not a silent wrong line)", async () => {
    const db = getDb();
    await ensureChargeCategorySeeds(ORG);
    const cat = await db.chargeCategory.findFirstOrThrow({ where: { organizationId: ORG, code: "recurring_other_tenant" }, select: { id: true } });
    const def = await makeDef("CUSTOM", "custom-tfee", "Tenant fee", APT_NOTEN);
    await makeRev(def.id, "30.00", "tenant", "2026-01-01", null, true, cat.id);

    const e = await openPeriod(APT_NOTEN, "2026-09-01");
    const lines = await db.gridEntryRecurringLine.findMany({ where: { gridEntryId: e.id } });
    expect(lines.length).toBe(0); // unresolved → no line (billing surfaces the conflict, Task 5)
    // The definition is still enabled + applicable — the "marker" billing detects.
    const applicable = await db.recurringChargeDefinition.count({ where: { organizationId: ORG, apartmentId: APT_NOTEN, archivedAt: null } });
    expect(applicable).toBe(1);
  });

  it("disabled applicable revision → CLEANING scalar 0 and no CUSTOM line", async () => {
    const db = getDb();
    await ensureChargeCategorySeeds(ORG);
    const cat = await db.chargeCategory.findFirstOrThrow({ where: { organizationId: ORG, code: "recurring_other_owner" }, select: { id: true } });
    const cdef = await makeDef("CLEANING", "cleaning", "Cleaning");
    await makeRev(cdef.id, "0.00", "owner", "2026-01-01", null, false);
    const xdef = await makeDef("CUSTOM", "custom-x", "X");
    await makeRev(xdef.id, "50.00", "owner", "2026-01-01", null, false, cat.id);

    const e = await openPeriod(APT, "2026-09-01");
    expect(e.cleaning?.toString()).toBe("0"); // disabled → 0
    expect(await db.gridEntryRecurringLine.count({ where: { gridEntryId: e.id } })).toBe(0);
  });

  // 2026-08-06 client report: a MAINTENANCE recurring def saved BEFORE the month was
  // opened never landed — getOrCreateEntry seeded only cleaning/wifi from the resolver,
  // so entry.maintenanceFee stayed null and the fee was stored-but-never-billed for any
  // month opened after the save (applyRecurring only syncs entries that already exist).
  it("MAINTENANCE RM300 enabled → opening the month seeds entry.maintenanceFee 300", async () => {
    const def = await makeDef("MAINTENANCE", "maintenance", "Maintenance");
    await makeRev(def.id, "300.00", "owner", "2026-08-01", null);

    const aug = await openPeriod(APT, "2026-08-01");
    expect(aug.maintenanceFee?.toString()).toBe("300");
  });

  it("disabled MAINTENANCE revision → maintenanceFee stays null (never a fake 0.00)", async () => {
    const def = await makeDef("MAINTENANCE", "maintenance", "Maintenance");
    await makeRev(def.id, "300.00", "owner", "2026-08-01", null, false);

    const aug = await openPeriod(APT, "2026-08-01");
    expect(aug.maintenanceFee).toBeNull();
  });

  it("TNB fixed-monthly def → opening seeds tnbTotalRaw (same generic scalar path)", async () => {
    const def = await makeDef("TNB", "tnb", "TNB");
    await makeRev(def.id, "180.00", "owner", "2026-08-01", null);

    const aug = await openPeriod(APT, "2026-08-01");
    expect(aug.tnbTotalRaw?.toString()).toBe("180");
  });

  it("flag OFF → legacy single-scalar seed (no def read, cleaning = config seed)", async () => {
    delete process.env.ENABLE_PHASE2_BILLING_DOCS;
    const def = await makeDef("CLEANING", "cleaning", "Cleaning");
    await makeRev(def.id, "120.00", "owner", "2026-01-01", null);
    const e = await openPeriod(APT, "2026-09-01");
    // Flag off ⇒ materialize skipped ⇒ cleaning = cfg default (100), the def is ignored.
    expect(e.cleaning?.toString()).toBe("100");
  });
});
