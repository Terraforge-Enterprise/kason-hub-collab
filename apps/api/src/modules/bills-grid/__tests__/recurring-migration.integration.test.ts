/**
 * Task 9: idempotent backfill of CLEANING/WIFI recurring definitions from UnitBillsBearerConfig
 * (spec R10). Real local Postgres only.
 * Run: from apps/api
 *   set -a; . ../../.env; set +a; RUN_INTEGRATION=1 npx vitest run \
 *     src/modules/bills-grid/__tests__/recurring-migration.integration.test.ts
 *
 * Proves: per-apartment CLEANING def+revision (amount = config, effectiveFrom = org current
 * month) + a DISABLED WIFI def; existing entry.cleaning/wifi byte-unchanged; idempotent re-run;
 * cleaningRecurringAmount 0 → disabled revision.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { backfillRecurringDefs } from "../../../../../../packages/db/scripts/backfill-recurring-defs";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`Refusing non-local DB host: ${host}`);
}

const ORG = "cb500000-0000-4000-8000-000000000001";
const USER = "cb500000-0000-4000-8000-000000000002";
const PROP = "cb500000-0000-4000-8000-000000000003";
const APT1 = "cb500000-0000-4000-8000-000000000004"; // cleaningRecurringAmount 100
const APT2 = "cb500000-0000-4000-8000-000000000005"; // cleaningRecurringAmount 0 → disabled
const NOW = new Date("2026-07-15T02:00:00.000Z"); // KL = 2026-07-15 → current month 2026-07-01

async function cleanup() {
  const db = getDb();
  await db.recurringChargeRevision.deleteMany({ where: { definition: { organizationId: ORG } } });
  await db.recurringChargeDefinition.deleteMany({ where: { organizationId: ORG } });
  await db.unitBillsGridEntry.deleteMany({ where: { organizationId: ORG } });
  await db.unitBillsBearerConfig.deleteMany({ where: { organizationId: ORG } });
  await db.apartment.deleteMany({ where: { organizationId: ORG } });
  await db.property.deleteMany({ where: { organizationId: ORG } });
  await db.user.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function seed() {
  const db = getDb();
  await db.organization.create({ data: { id: ORG, name: "MG", slug: "mg", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" } });
  await db.user.create({ data: { id: USER, organizationId: ORG, email: "mg@example.test", fullName: "MG", status: "active", role: "manager", userType: "operator" } });
  await db.property.create({ data: { id: PROP, organizationId: ORG, name: "P", propertyCode: "P-MG", propertyType: "residential", addressLine1: "1", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
  await db.apartment.create({ data: { id: APT1, organizationId: ORG, propertyId: PROP, unitCode: "A-MG", listingMode: "WHOLE" } });
  await db.apartment.create({ data: { id: APT2, organizationId: ORG, propertyId: PROP, unitCode: "B-MG", listingMode: "WHOLE" } });
  await db.unitBillsBearerConfig.create({ data: { organizationId: ORG, apartmentId: APT1, cleaningRecurringAmount: "100.00", cleaningBearer: "owner", wifiBearer: "owner" } });
  await db.unitBillsBearerConfig.create({ data: { organizationId: ORG, apartmentId: APT2, cleaningRecurringAmount: "0.00", cleaningBearer: "tenant", wifiBearer: "owner" } });
  // A pre-existing billed entry with a specific cleaning value — MUST stay byte-identical.
  await db.unitBillsGridEntry.create({ data: { organizationId: ORG, apartmentId: APT1, periodMonth: new Date("2026-05-01T00:00:00.000Z"), createdBy: USER, cleaning: "77.00", wifi: "33.00", tnbPattern: "recharged", airPattern: "recharged", cleaningBearer: "owner", wifiBearer: "owner", maintenanceFeeBearer: "owner", billedAt: new Date() } });
}

dn("backfill CLEANING/WIFI recurring definitions (Task 9)", () => {
  beforeEach(async () => { await cleanup(); await seed(); });
  afterEach(async () => { await cleanup(); });

  it("creates CLEANING (amount=config, effectiveFrom=current month) + DISABLED WIFI per apartment; entry values byte-unchanged", async () => {
    const db = getDb();
    const r = await backfillRecurringDefs(db, { organizationId: ORG, now: NOW });
    expect(r.createdCleaning).toBe(2);
    expect(r.createdWifi).toBe(2);
    expect(r.skipped).toBe(0);

    // APT1 CLEANING — amount 100, enabled, effectiveFrom 2026-07-01, bearer owner.
    const c1 = await db.recurringChargeDefinition.findFirstOrThrow({ where: { organizationId: ORG, apartmentId: APT1, code: "cleaning" }, include: { revisions: true } });
    expect(c1.kind).toBe("CLEANING");
    expect(c1.revisions.length).toBe(1);
    expect(c1.revisions[0].amount.toString()).toBe("100");
    expect(c1.revisions[0].enabled).toBe(true);
    expect(c1.revisions[0].bearer).toBe("owner");
    expect(c1.revisions[0].effectiveFromMonth.toISOString().slice(0, 10)).toBe("2026-07-01");

    // APT1 WIFI — disabled at 0.
    const w1 = await db.recurringChargeDefinition.findFirstOrThrow({ where: { organizationId: ORG, apartmentId: APT1, code: "wifi" }, include: { revisions: true } });
    expect(w1.revisions[0].enabled).toBe(false);
    expect(w1.revisions[0].amount.toString()).toBe("0");

    // APT2 CLEANING — amount 0 → disabled.
    const c2 = await db.recurringChargeDefinition.findFirstOrThrow({ where: { organizationId: ORG, apartmentId: APT2, code: "cleaning" }, include: { revisions: true } });
    expect(c2.revisions[0].enabled).toBe(false);
    expect(c2.revisions[0].amount.toString()).toBe("0");

    // The pre-existing entry's cleaning/wifi are byte-identical (never read or written).
    const e = await db.unitBillsGridEntry.findFirstOrThrow({ where: { organizationId: ORG, apartmentId: APT1 } });
    expect(e.cleaning?.toString()).toBe("77");
    expect(e.wifi?.toString()).toBe("33");
  });

  it("idempotent: a second run creates nothing new (skips existing defs)", async () => {
    const db = getDb();
    await backfillRecurringDefs(db, { organizationId: ORG, now: NOW });
    const r2 = await backfillRecurringDefs(db, { organizationId: ORG, now: NOW });
    expect(r2.createdCleaning).toBe(0);
    expect(r2.createdWifi).toBe(0);
    expect(r2.skipped).toBe(4); // 2 apartments × 2 kinds
    // Exactly one def per (apartment, kind) — no duplicates.
    expect(await db.recurringChargeDefinition.count({ where: { organizationId: ORG } })).toBe(4);
  });
});
