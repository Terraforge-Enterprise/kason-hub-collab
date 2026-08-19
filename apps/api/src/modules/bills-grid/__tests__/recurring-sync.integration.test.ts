/**
 * Task 3: recurring definition/revision service + effective-month sync (preview + atomic
 * block-all apply). Money-critical, spec R1/R3/R5/R8.
 *
 * Real local Postgres only, dedicated org fixture (never the shared dev seed), FK-ordered
 * cleanup — mirrors bill-guards.integration.test.ts.
 * Run: from apps/api
 *   set -a; . ../../.env; set +a; RUN_INTEGRATION=1 npx vitest run \
 *     src/modules/bills-grid/__tests__/recurring-sync.integration.test.ts
 *
 * Coverage (acceptance mini-table, plan Task 3):
 *  (a) preview: 4 open + 2 billed periods >= effectiveFrom → 4 willUpdate + 2 excluded and
 *      writes NOTHING (row counts + scalars byte-unchanged).
 *  (b) apply (confirm, no conflict): all 4 open periods' snapshots update in ONE tx; the 2
 *      billed periods are byte-unchanged.
 *  (c) conflict-blocks-all: a tenant-borne def on an apartment with no active tenancy →
 *      apply confirmed returns 409 with conflicts and NO period is written.
 *  (d) excluded-frozen: an owner-statement-frozen period >= effectiveFrom is excluded
 *      (reason "frozen") and unchanged.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import {
  applyRecurringService,
  previewRecurringService,
  listRecurringService,
} from "../recurring.service";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`Refusing non-local DB host: ${host}`);
}

const ORG = "c7500000-0000-4000-8000-000000000001";
const USER = "c7500000-0000-4000-8000-000000000002";
const PROP = "c7500000-0000-4000-8000-000000000003";
const APT = "c7500000-0000-4000-8000-000000000004"; // whole unit, owner + active tenancy
const ROOM = "c7500000-0000-4000-8000-000000000005";
const OWNER_PARTY = "c7500000-0000-4000-8000-000000000006";
const TENANT_PARTY = "c7500000-0000-4000-8000-000000000007";
const TENANCY = "c7500000-0000-4000-8000-000000000008";
const APT_NOTEN = "c7500000-0000-4000-8000-000000000009"; // owner but NO active tenancy
const ROOM2 = "c7500000-0000-4000-8000-00000000000a";

const session = { orgId: ORG, userId: USER, role: "manager" };
const MONTHS = ["2026-02-01", "2026-03-01", "2026-04-01", "2026-05-01", "2026-06-01", "2026-07-01"];
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

async function cleanup() {
  const db = getDb();
  await db.gridEntryRecurringLine.deleteMany({ where: { organizationId: ORG } });
  await db.recurringChargeRevision.deleteMany({ where: { definition: { organizationId: ORG } } });
  await db.recurringChargeDefinition.deleteMany({ where: { organizationId: ORG } });
  await db.ownerStatementPeriod.deleteMany({ where: { organizationId: ORG } });
  await db.unitBillsGridEntry.deleteMany({ where: { organizationId: ORG } });
  await db.unitBillsBearerConfig.deleteMany({ where: { organizationId: ORG } });
  await db.tenancy.deleteMany({ where: { organizationId: ORG } });
  await db.listing.deleteMany({ where: { organizationId: ORG } });
  await db.apartment.deleteMany({ where: { organizationId: ORG } });
  await db.property.deleteMany({ where: { organizationId: ORG } });
  await db.chargeCategory.deleteMany({ where: { organizationId: ORG } });
  await db.auditLog.deleteMany({ where: { organizationId: ORG } });
  await db.user.deleteMany({ where: { organizationId: ORG } });
  await db.party.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function seedOrg() {
  const db = getDb();
  await db.organization.create({ data: { id: ORG, name: "RC", slug: "rc", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" } });
  await db.user.create({ data: { id: USER, organizationId: ORG, email: "rc@example.test", fullName: "RC Operator", status: "active", role: "manager", userType: "operator" } });
  await db.property.create({ data: { id: PROP, organizationId: ORG, name: "P", propertyCode: "P-RC", propertyType: "residential", addressLine1: "1", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
  await db.party.create({ data: { id: OWNER_PARTY, organizationId: ORG, displayName: "Owner", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: TENANT_PARTY, organizationId: ORG, displayName: "Tenant", partyType: "individual", status: "active" } });
}

/** WHOLE apartment with an owner + one active tenancy, and 6 monthly grid entries; the last
 * two (2026-06, 2026-07) are BILLED (billedAt set). Returns the entry ids by month. */
async function seedApartmentWith6Entries(): Promise<Record<string, { id: string; updatedAt: string }>> {
  const db = getDb();
  await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "A-RC", listingMode: "WHOLE" } });
  await db.listing.create({ data: { id: ROOM, organizationId: ORG, apartmentId: APT, listingType: "whole_unit", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER_PARTY } });
  await db.tenancy.create({ data: { id: TENANCY, organizationId: ORG, propertyId: PROP, unitId: ROOM, tenantPartyId: TENANT_PARTY, tenancyCode: "T-RC", status: "active", billingStatus: "current", startDate: new Date("2026-01-01"), monthlyRentAmount: "2000.00", numberOfPax: 1 } });

  const out: Record<string, { id: string; updatedAt: string }> = {};
  for (const m of MONTHS) {
    const billed = m === "2026-06-01" || m === "2026-07-01";
    const e = await db.unitBillsGridEntry.create({
      data: {
        organizationId: ORG, apartmentId: APT, periodMonth: d(m), createdBy: USER,
        tnbPattern: "recharged", airPattern: "recharged",
        cleaningBearer: "owner", wifiBearer: "owner", maintenanceFeeBearer: "owner",
        cleaning: "0.00", wifi: "0.00",
        ...(billed ? { billedAt: new Date() } : {}),
      },
    });
    out[m] = { id: e.id, updatedAt: e.updatedAt.toISOString() };
  }
  return out;
}

/** A second apartment with an owner but NO active tenancy, plus 2 open entries. */
async function seedApartmentNoTenancy(): Promise<Record<string, { id: string; updatedAt: string }>> {
  const db = getDb();
  await db.apartment.create({ data: { id: APT_NOTEN, organizationId: ORG, propertyId: PROP, unitCode: "B-RC", listingMode: "WHOLE" } });
  await db.listing.create({ data: { id: ROOM2, organizationId: ORG, apartmentId: APT_NOTEN, listingType: "whole_unit", occupancyStatus: "vacant", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER_PARTY } });
  const out: Record<string, { id: string; updatedAt: string }> = {};
  for (const m of ["2026-04-01", "2026-05-01"]) {
    const e = await db.unitBillsGridEntry.create({
      data: {
        organizationId: ORG, apartmentId: APT_NOTEN, periodMonth: d(m), createdBy: USER,
        tnbPattern: "recharged", airPattern: "recharged",
        cleaningBearer: "owner", wifiBearer: "owner", maintenanceFeeBearer: "owner",
        cleaning: "0.00", wifi: "0.00",
      },
    });
    out[m] = { id: e.id, updatedAt: e.updatedAt.toISOString() };
  }
  return out;
}

dn("bills-grid recurring sync — preview + atomic block-all apply (Task 3)", () => {
  beforeEach(async () => {
    await cleanup();
    process.env.ENABLE_PHASE2_BILLING_DOCS = "true";
    await seedOrg();
  });
  afterEach(async () => {
    delete process.env.ENABLE_PHASE2_BILLING_DOCS;
    await cleanup();
  });

  it("preview: 4 open + 2 billed >= effectiveFrom → 4 willUpdate + 2 excluded, writes NOTHING", async () => {
    const db = getDb();
    await seedApartmentWith6Entries();

    const before = await db.gridEntryRecurringLine.count({ where: { organizationId: ORG } });
    const r = await previewRecurringService(session, APT, {
      kind: "CUSTOM", name: "Service fee", amount: "50.00", bearer: "owner", effectiveFromMonth: "2026-02-01", enabled: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.willUpdate.length).toBe(4);
    expect(r.data.excluded.length).toBe(2);
    expect(r.data.excluded.every((e) => e.reason === "billed")).toBe(true);
    expect(r.data.conflicts.length).toBe(0);
    // No write happened.
    expect(await db.gridEntryRecurringLine.count({ where: { organizationId: ORG } })).toBe(before);
    expect(await db.recurringChargeDefinition.count({ where: { organizationId: ORG } })).toBe(0);
  });

  it("apply (confirm, no conflict): 4 open periods' CUSTOM snapshots created in ONE tx; 2 billed untouched", async () => {
    const db = getDb();
    const entries = await seedApartmentWith6Entries();

    const r = await applyRecurringService(session, APT, {
      kind: "CUSTOM", name: "Service fee", amount: "50.00", bearer: "owner", effectiveFromMonth: "2026-02-01", enabled: true, confirm: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.applied).toBe(4);
    expect(r.data.conflicts.length).toBe(0);

    const lines = await db.gridEntryRecurringLine.findMany({ where: { organizationId: ORG } });
    expect(lines.length).toBe(4);
    // Each open entry got exactly one owner-borne line at 50.00, resolved to the owner party.
    for (const m of ["2026-02-01", "2026-03-01", "2026-04-01", "2026-05-01"]) {
      const ln = lines.find((l) => l.gridEntryId === entries[m].id);
      expect(ln, `line for ${m}`).toBeTruthy();
      expect(ln!.amount.toString()).toBe("50");
      expect(ln!.bearer).toBe("owner");
      expect(ln!.resolvedPartyId).toBe(OWNER_PARTY);
      expect(ln!.resolvedTenancyId).toBeNull();
      expect(ln!.categoryFamily).toBe("owner_income");
    }
    // Billed periods got NO line.
    for (const m of ["2026-06-01", "2026-07-01"]) {
      expect(lines.find((l) => l.gridEntryId === entries[m].id)).toBeFalsy();
    }
    // Exactly one definition + one revision persisted.
    expect(await db.recurringChargeDefinition.count({ where: { organizationId: ORG } })).toBe(1);
    expect(await db.recurringChargeRevision.count({ where: { definition: { organizationId: ORG } } })).toBe(1);
  });

  it("apply CLEANING scalar: open entries' entry.cleaning set; billed untouched", async () => {
    const db = getDb();
    const entries = await seedApartmentWith6Entries();

    const r = await applyRecurringService(session, APT, {
      kind: "CLEANING", name: "Cleaning", amount: "100.00", bearer: "owner", effectiveFromMonth: "2026-02-01", enabled: true, confirm: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.applied).toBe(4);

    for (const m of ["2026-02-01", "2026-03-01", "2026-04-01", "2026-05-01"]) {
      const e = await db.unitBillsGridEntry.findUniqueOrThrow({ where: { id: entries[m].id } });
      expect(e.cleaning?.toString()).toBe("100");
      expect(e.cleaningBearer).toBe("owner");
    }
    for (const m of ["2026-06-01", "2026-07-01"]) {
      const e = await db.unitBillsGridEntry.findUniqueOrThrow({ where: { id: entries[m].id } });
      expect(e.cleaning?.toString()).toBe("0"); // billed → untouched
    }
    // CLEANING creates no child line.
    expect(await db.gridEntryRecurringLine.count({ where: { organizationId: ORG } })).toBe(0);
  });

  it("conflict-blocks-all: tenant-borne def on an apartment with no active tenancy → 409, nothing written", async () => {
    const db = getDb();
    await seedApartmentNoTenancy();

    const r = await applyRecurringService(session, APT_NOTEN, {
      kind: "CUSTOM", name: "Tenant fee", amount: "30.00", bearer: "tenant", effectiveFromMonth: "2026-04-01", enabled: true, confirm: true,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(409);
    // Block-all: NO line, and the definition/revision were rolled back too.
    expect(await db.gridEntryRecurringLine.count({ where: { organizationId: ORG } })).toBe(0);
    expect(await db.recurringChargeDefinition.count({ where: { organizationId: ORG } })).toBe(0);
    expect(await db.recurringChargeRevision.count({ where: { definition: { organizationId: ORG } } })).toBe(0);
  });

  it("excluded-frozen: an owner-statement-frozen open period is excluded (reason frozen) and not synced", async () => {
    const db = getDb();
    const entries = await seedApartmentWith6Entries();
    // Freeze the owner statement for 2026-03 (per-unit scope).
    await db.ownerStatementPeriod.create({
      data: {
        organizationId: ORG, ownerPartyId: OWNER_PARTY, apartmentId: APT, periodMonth: d("2026-03-01"),
        status: "frozen", idempotencyKey: `ownerstmt:${OWNER_PARTY}:2026-03:${APT}`, sourceMaxUpdatedAt: new Date(),
      },
    });

    const preview = await previewRecurringService(session, APT, {
      kind: "CUSTOM", name: "Service fee", amount: "50.00", bearer: "owner", effectiveFromMonth: "2026-02-01", enabled: true,
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    // 3 open (02,04,05) + 1 frozen (03) + 2 billed (06,07)
    expect(preview.data.willUpdate.length).toBe(3);
    expect(preview.data.excluded.filter((e) => e.reason === "frozen").length).toBe(1);
    expect(preview.data.excluded.filter((e) => e.reason === "billed").length).toBe(2);

    const r = await applyRecurringService(session, APT, {
      kind: "CUSTOM", name: "Service fee", amount: "50.00", bearer: "owner", effectiveFromMonth: "2026-02-01", enabled: true, confirm: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.applied).toBe(3);
    // The frozen period got no line.
    expect(await db.gridEntryRecurringLine.count({ where: { gridEntryId: entries["2026-03-01"].id } })).toBe(0);
  });

  it("list: after apply, listRecurringService returns the definition with its revision", async () => {
    await seedApartmentWith6Entries();
    await applyRecurringService(session, APT, {
      kind: "CUSTOM", name: "Service fee", amount: "50.00", bearer: "owner", effectiveFromMonth: "2026-02-01", enabled: true, confirm: true,
    });
    const r = await listRecurringService(session, APT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.definitions.length).toBe(1);
    expect(r.data.definitions[0].kind).toBe("CUSTOM");
    expect(r.data.definitions[0].revisions.length).toBe(1);
    expect(r.data.definitions[0].revisions[0].amount).toBe("50.00");
  });
});
