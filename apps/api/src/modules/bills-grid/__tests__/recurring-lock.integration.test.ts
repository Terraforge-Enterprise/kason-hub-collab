/**
 * Task 6: backend write-protection (spec R6). Flag-ON, a grid Save carrying cleaning/wifi is
 * rejected with 409 recurring_charge_locked (they are recurring-settings-controlled, never a
 * grid cell) and the entry's scalar is unchanged. An unrelated Save (tnb/air only) still works.
 *
 * Real local Postgres only. Run: from apps/api
 *   set -a; . ../../.env; set +a; RUN_INTEGRATION=1 npx vitest run \
 *     src/modules/bills-grid/__tests__/recurring-lock.integration.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { saveEntryService } from "../service";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`Refusing non-local DB host: ${host}`);
}

const ORG = "ca500000-0000-4000-8000-000000000001";
const USER = "ca500000-0000-4000-8000-000000000002";
const PROP = "ca500000-0000-4000-8000-000000000003";
const APT = "ca500000-0000-4000-8000-000000000004";
const PERIOD_STR = "2026-05-01";
const PERIOD = new Date(`${PERIOD_STR}T00:00:00.000Z`);
const session = { orgId: ORG, userId: USER, role: "manager" };

async function cleanup() {
  const db = getDb();
  await db.recurringChargeRevision.deleteMany({ where: { definition: { organizationId: ORG } } });
  await db.recurringChargeDefinition.deleteMany({ where: { organizationId: ORG } });
  await db.unitBillsGridEntry.deleteMany({ where: { organizationId: ORG } });
  await db.unitBillsBearerConfig.deleteMany({ where: { organizationId: ORG } });
  await db.apartment.deleteMany({ where: { organizationId: ORG } });
  await db.property.deleteMany({ where: { organizationId: ORG } });
  await db.auditLog.deleteMany({ where: { organizationId: ORG } });
  await db.user.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function seedEntry(cleaning = "50.00", wifi = "20.00") {
  const db = getDb();
  await db.organization.create({ data: { id: ORG, name: "RL", slug: "rl", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" } });
  await db.user.create({ data: { id: USER, organizationId: ORG, email: "rl@example.test", fullName: "RL", status: "active", role: "manager", userType: "operator" } });
  await db.property.create({ data: { id: PROP, organizationId: ORG, name: "P", propertyCode: "P-RL", propertyType: "residential", addressLine1: "1", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
  await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "A-RL", listingMode: "WHOLE" } });
  const e = await db.unitBillsGridEntry.create({
    data: { organizationId: ORG, apartmentId: APT, periodMonth: PERIOD, createdBy: USER, cleaning, wifi, tnbTotalRaw: "0.00", airSelangorRaw: "0.00", tnbPattern: "recharged", airPattern: "recharged", cleaningBearer: "owner", wifiBearer: "owner", maintenanceFeeBearer: "owner" },
  });
  return e.updatedAt.toISOString();
}

/** Create a CLEANING/WIFI definition governing APT at PERIOD with the given enabled state. */
async function makeGoverningDef(kind: "CLEANING" | "WIFI", amount: string, enabled: boolean) {
  const db = getDb();
  const def = await db.recurringChargeDefinition.create({ data: { organizationId: ORG, apartmentId: APT, kind, code: kind.toLowerCase(), name: kind, createdBy: USER } });
  await db.recurringChargeRevision.create({ data: { definitionId: def.id, amount, bearer: "owner", categoryId: null, effectiveFromMonth: PERIOD, effectiveToMonth: null, enabled, createdBy: USER } });
}

dn("bills-grid recurring write-protection — governed vs editable (Task 6 refined)", () => {
  beforeEach(async () => { await cleanup(); process.env.ENABLE_PHASE2_BILLING_DOCS = "true"; });
  afterEach(async () => { delete process.env.ENABLE_PHASE2_BILLING_DOCS; await cleanup(); });

  it("GOVERNED cleaning (enabled def) + save cleaning → 409 recurring_charge_locked, entry.cleaning unchanged", async () => {
    const db = getDb();
    const token = await seedEntry("50.00");
    await makeGoverningDef("CLEANING", "50.00", true); // enabled → governs → locked
    const r = await saveEntryService(session, APT, { period: PERIOD_STR, cleaning: "999.00", expectedUpdatedAt: token });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(409);
    expect(r.error).toBe("recurring_charge_locked");
    const e = await db.unitBillsGridEntry.findFirstOrThrow({ where: { organizationId: ORG, apartmentId: APT } });
    expect(e.cleaning?.toString()).toBe("50"); // unchanged
  });

  it("GOVERNED wifi (enabled def) + save wifi → 409 recurring_charge_locked", async () => {
    const token = await seedEntry("50.00", "20.00");
    await makeGoverningDef("WIFI", "30.00", true);
    const r = await saveEntryService(session, APT, { period: PERIOD_STR, wifi: "77.00", expectedUpdatedAt: token });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("recurring_charge_locked");
  });

  it("UNGOVERNED cleaning (no def) + save cleaning → SUCCEEDS and persists it (per-month editable)", async () => {
    const db = getDb();
    const token = await seedEntry("50.00");
    // No cleaning def → not governed → the admin may type a per-month value directly.
    const r = await saveEntryService(session, APT, { period: PERIOD_STR, cleaning: "999.00", expectedUpdatedAt: token });
    expect(r.ok).toBe(true);
    const e = await db.unitBillsGridEntry.findFirstOrThrow({ where: { organizationId: ORG, apartmentId: APT } });
    expect(e.cleaning?.toString()).toBe("999"); // written
  });

  it("DISABLED wifi def (backfill default) + save wifi → SUCCEEDS (disabled ⇒ not governed ⇒ editable)", async () => {
    const db = getDb();
    const token = await seedEntry("50.00", "0.00");
    await makeGoverningDef("WIFI", "0.00", false); // disabled → NOT governed → editable
    const r = await saveEntryService(session, APT, { period: PERIOD_STR, wifi: "45.00", expectedUpdatedAt: token });
    expect(r.ok).toBe(true);
    const e = await db.unitBillsGridEntry.findFirstOrThrow({ where: { organizationId: ORG, apartmentId: APT } });
    expect(e.wifi?.toString()).toBe("45"); // written
  });

  it("flag-on + save with only tnb (no cleaning/wifi) → succeeds; a GOVERNED cleaning stays untouched", async () => {
    const db = getDb();
    const token = await seedEntry("50.00");
    await makeGoverningDef("CLEANING", "50.00", true);
    const r = await saveEntryService(session, APT, { period: PERIOD_STR, tnbTotal: "123.00", expectedUpdatedAt: token });
    expect(r.ok).toBe(true);
    const e = await db.unitBillsGridEntry.findFirstOrThrow({ where: { organizationId: ORG, apartmentId: APT } });
    expect(e.tnbTotalRaw?.toString()).toBe("123");
    expect(e.cleaning?.toString()).toBe("50"); // governed scalar not clobbered by an unrelated save
  });

  it("flag-off → legacy write: a save with cleaning succeeds even with a governing def", async () => {
    delete process.env.ENABLE_PHASE2_BILLING_DOCS;
    const db = getDb();
    const token = await seedEntry("50.00");
    await makeGoverningDef("CLEANING", "50.00", true);
    const r = await saveEntryService(session, APT, { period: PERIOD_STR, cleaning: "88.00", expectedUpdatedAt: token });
    expect(r.ok).toBe(true);
    const e = await db.unitBillsGridEntry.findFirstOrThrow({ where: { organizationId: ORG, apartmentId: APT } });
    expect(e.cleaning?.toString()).toBe("88"); // legacy path still writes it (guard is flag-gated)
  });
});
