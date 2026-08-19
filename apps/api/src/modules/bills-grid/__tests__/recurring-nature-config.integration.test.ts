/**
 * Task 7 (charge-nature-expense-profit-routing): the recurring-charge CONFIG write
 * path (recurring.service.ts) must accept `nature`, PERSIST it on the effective
 * RecurringChargeRevision, and SNAPSHOT it onto the per-period GridEntryRecurringLine
 * (which the Task 4 mint already reads). The read projections that surface recurring
 * lines/revisions must include `nature`.
 *
 * Additive + legacy-safe: a definition saved WITHOUT `nature` persists revision.nature
 * NULL and snapshot nature NULL, and the line still materializes exactly as before
 * (billing unchanged). Real local Postgres only.
 *
 * Run: from apps/api
 *   set -a; . ../../.env; set +a; RUN_INTEGRATION=1 npx vitest run \
 *     src/modules/bills-grid/__tests__/recurring-nature-config.integration.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { applyRecurringService, listRecurringLinesService, listRecurringService } from "../recurring.service";
import { ensureChargeCategorySeeds } from "../../charge-categories/seed";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`Refusing non-local DB host: ${host}`);
}

const ORG = "c7a00000-0000-4000-8000-000000000001";
const USER = "c7a00000-0000-4000-8000-000000000002";
const PROP = "c7a00000-0000-4000-8000-000000000003";
const APT = "c7a00000-0000-4000-8000-000000000004";
const ROOM = "c7a00000-0000-4000-8000-000000000005";
const OWNER_PARTY = "c7a00000-0000-4000-8000-000000000006";
const TENANT_PARTY = "c7a00000-0000-4000-8000-000000000007";
const TENANCY = "c7a00000-0000-4000-8000-000000000008";
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
  await db.auditLog.deleteMany({ where: { organizationId: ORG } });
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
  await db.organization.create({ data: { id: ORG, name: "RN7", slug: "rn7", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" } });
  await db.user.create({ data: { id: USER, organizationId: ORG, email: "rn7@example.test", fullName: "RN7", status: "active", role: "manager", userType: "operator" } });
  await db.property.create({ data: { id: PROP, organizationId: ORG, name: "P", propertyCode: "P-RN7", propertyType: "residential", addressLine1: "1", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
  await db.party.create({ data: { id: OWNER_PARTY, organizationId: ORG, displayName: "Owner", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: TENANT_PARTY, organizationId: ORG, displayName: "Tenant", partyType: "individual", status: "active" } });
  await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "A-RN7", listingMode: "WHOLE" } });
  await db.listing.create({ data: { id: ROOM, organizationId: ORG, apartmentId: APT, listingType: "whole_unit", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER_PARTY } });
  await db.tenancy.create({ data: { id: TENANCY, organizationId: ORG, propertyId: PROP, unitId: ROOM, tenantPartyId: TENANT_PARTY, tenancyCode: "T-RN7", status: "active", billingStatus: "current", startDate: new Date("2026-01-01"), monthlyRentAmount: "2000.00", numberOfPax: 1 } });
  // An OPEN grid entry at the period — writeSnapshot upserts a GridEntryRecurringLine onto it.
  await db.unitBillsGridEntry.create({
    data: { organizationId: ORG, apartmentId: APT, periodMonth: PERIOD, createdBy: USER, cleaning: "0.00", wifi: "0.00", tnbPattern: "recharged", airPattern: "recharged", cleaningBearer: "owner", wifiBearer: "owner", maintenanceFeeBearer: "owner" },
  });
  await ensureChargeCategorySeeds(ORG);
}

dn("bills-grid recurring config — accept + persist + snapshot nature (Task 7)", () => {
  beforeEach(async () => { await cleanup(); process.env.ENABLE_PHASE2_BILLING_DOCS = "true"; await seed(); });
  afterEach(async () => { delete process.env.ENABLE_PHASE2_BILLING_DOCS; await cleanup(); });

  it("save a CUSTOM definition with nature:'expense' → effective revision AND materialized snapshot both carry 'expense' (+ surfaced by reads)", async () => {
    const db = getDb();
    const r = await applyRecurringService(session, APT, {
      kind: "CUSTOM", name: "Aircon service", amount: "30.00", bearer: "owner",
      effectiveFromMonth: PERIOD_STR, enabled: true, confirm: true, nature: "expense",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.applied).toBe(1);

    // (a) the effective revision persists nature
    const rev = await db.recurringChargeRevision.findFirstOrThrow({ where: { definition: { organizationId: ORG } } });
    expect(rev.nature).toBe("expense");

    // (b) the per-period snapshot copies nature from the effective revision
    const line = await db.gridEntryRecurringLine.findFirstOrThrow({ where: { organizationId: ORG } });
    expect(line.nature).toBe("expense");
    expect(line.amount.toString()).toBe("30");

    // (c) read projections surface nature
    const list = await listRecurringService({ orgId: ORG }, APT);
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.data.definitions[0].revisions[0].nature).toBe("expense");

    const lines = await listRecurringLinesService({ orgId: ORG }, APT, PERIOD_STR);
    expect(lines.ok).toBe(true);
    if (!lines.ok) return;
    expect(lines.data.lines[0].nature).toBe("expense");
  });

  it("legacy: save WITHOUT nature → revision.nature NULL, snapshot.nature NULL, line still materializes (billing unchanged)", async () => {
    const db = getDb();
    const r = await applyRecurringService(session, APT, {
      kind: "CUSTOM", name: "Service fee", amount: "25.00", bearer: "owner",
      effectiveFromMonth: PERIOD_STR, enabled: true, confirm: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.applied).toBe(1);

    const rev = await db.recurringChargeRevision.findFirstOrThrow({ where: { definition: { organizationId: ORG } } });
    expect(rev.nature).toBeNull();

    const line = await db.gridEntryRecurringLine.findFirstOrThrow({ where: { organizationId: ORG } });
    expect(line.nature).toBeNull();
    expect(line.amount.toString()).toBe("25"); // materialization unchanged — line still created

    const list = await listRecurringService({ orgId: ORG }, APT);
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.data.definitions[0].revisions[0].nature).toBeNull();
  });
});
