/**
 * R1 follow-up — closed-period write guard wired into the BILLS-GRID owner-charge
 * mint (`mintItemizedCharges`, reached via `billService`), end-to-end
 * (integration, RUN_INTEGRATION=1).
 *
 * MONEY: a grid Bill mints an OWNER-borne utility charge dated into the entry's
 * period month. If that owner-statement month is FROZEN, the owner-ledger sync-hook's
 * void-only forward-reversal silently drops the impact — so the owner-charge mint MUST
 * be rejected AT CREATION, in-tx, before the owner `tx.charge.create`. billService is
 * a bulk, per-row, non-atomic manifest: a thrown ClosedPeriodError rolls the row's
 * $transaction back and surfaces as that row's `save_failed` (nothing half-issued).
 *
 * The guard is SCOPED to the owner charge: a tenant-only entry (no owner-borne
 * component) is NEVER blocked (BG4).
 *
 * Run: from apps/api
 *   set -a; . /Users/cadistan/Documents/Github/Kason-Hub/.env; set +a
 *   RUN_INTEGRATION=1 ENABLE_PHASE2_OWNER_BILLING=1 \
 *     ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER=1 \
 *     npx vitest run src/modules/bills-grid/__tests__/closed-period-guard.integration.test.ts --no-coverage
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { billService } from "../service";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`Refusing non-local DB host: ${host}`);
}

const LEDGER = "ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER";

// Dedicated fixture ids (prefix b730 — unused by any other suite).
const ORG = "b7300000-0000-4000-8000-000000000001";
const USER = "b7300000-0000-4000-8000-000000000002";
const PROP = "b7300000-0000-4000-8000-000000000003";
const APT = "b7300000-0000-4000-8000-000000000004";
const ROOM_A = "b7300000-0000-4000-8000-000000000005";
const ROOM_B = "b7300000-0000-4000-8000-000000000006";
const PARTY_A = "b7300000-0000-4000-8000-000000000007";
const PARTY_B = "b7300000-0000-4000-8000-000000000008";
const OWNER_PARTY = "b7300000-0000-4000-8000-000000000009";
const TEN_A = "b7300000-0000-4000-8000-00000000000a";
const TEN_B = "b7300000-0000-4000-8000-00000000000b";

const PERIOD_STR = "2026-06-01";
const PERIOD = new Date(`${PERIOD_STR}T00:00:00.000Z`);
const session = { orgId: ORG, userId: USER, role: "manager" };

async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  await db.billingDocumentLine.deleteMany({ where: { document: org } });
  await db.billingDocument.deleteMany({ where: org });
  await db.ownerStatementPeriod.deleteMany({ where: org });
  await db.unitMonthLedger.deleteMany({ where: org });
  await db.ownerLedgerEntry.deleteMany({ where: org });
  await db.chargeEvent.deleteMany({ where: org });
  await db.charge.deleteMany({ where: org });
  await db.gridMeterReading.deleteMany({ where: org });
  await db.gridExpense.deleteMany({ where: org });
  await db.gridAttachment.deleteMany({ where: org });
  await db.unitBillsGridEntry.deleteMany({ where: org });
  await db.unitBillsBearerConfig.deleteMany({ where: org });
  await db.tenancy.deleteMany({ where: org });
  await db.listing.deleteMany({ where: org });
  await db.apartment.deleteMany({ where: org });
  await db.property.deleteMany({ where: org });
  await db.chargeCategory.deleteMany({ where: org });
  await db.documentSeries.deleteMany({ where: org });
  await db.referenceSequence.deleteMany({ where: org });
  await db.auditLog.deleteMany({ where: org });
  await db.user.deleteMany({ where: org });
  await db.party.deleteMany({ where: org });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function seedBase() {
  const db = getDb();
  await db.organization.create({ data: { id: ORG, name: "BG730", slug: "bg730", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" } });
  await db.user.create({ data: { id: USER, organizationId: ORG, email: "bg730@example.test", fullName: "BG730 Operator", status: "active", role: "manager", userType: "operator" } });
  await db.property.create({ data: { id: PROP, organizationId: ORG, name: "P", propertyCode: "P-B730", propertyType: "residential", addressLine1: "1", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
  await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "A-B730", listingMode: "PARTITIONED" } });
  await db.party.create({ data: { id: PARTY_A, organizationId: ORG, displayName: "Tenant A", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: PARTY_B, organizationId: ORG, displayName: "Tenant B", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: OWNER_PARTY, organizationId: ORG, displayName: "Owner", partyType: "individual", status: "active" } });
  await db.listing.create({ data: { id: ROOM_A, organizationId: ORG, apartmentId: APT, listingType: "master_room", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER_PARTY } });
  await db.listing.create({ data: { id: ROOM_B, organizationId: ORG, apartmentId: APT, listingType: "middle_room", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER_PARTY } });
  await db.tenancy.create({ data: { id: TEN_A, organizationId: ORG, propertyId: PROP, unitId: ROOM_A, tenantPartyId: PARTY_A, tenancyCode: "T-A730", status: "active", billingStatus: "current", startDate: new Date("2026-01-01"), monthlyRentAmount: "1000.00", numberOfPax: 1 } });
  await db.tenancy.create({ data: { id: TEN_B, organizationId: ORG, propertyId: PROP, unitId: ROOM_B, tenantPartyId: PARTY_B, tenancyCode: "T-B730", status: "active", billingStatus: "current", startDate: new Date("2026-01-01"), monthlyRentAmount: "1000.00", numberOfPax: 1 } });
}

/** Partitioned entry with absorbed TNB (owner-borne 300 → an owner electricity
 *  charge is minted for OWNER_PARTY). Mirrors bill-issuance's seedPartitionedEntry. */
async function seedOwnerBorneEntry(): Promise<{ expectedUpdatedAt: string }> {
  const db = getDb();
  await seedBase();
  const entry = await db.unitBillsGridEntry.create({
    data: {
      organizationId: ORG, apartmentId: APT, periodMonth: PERIOD, createdBy: USER,
      tnbTotalRaw: "300.00", airSelangorRaw: "40.00", wifi: "120.00", wifiNature: "profit", cleaning: "0.00", // charge-nature gate: this scaffolding WiFi is not what the test measures; "profit" reproduces the pre-gate null behaviour (manager_revenue → IVTEN) exactly
      tnbPattern: "absorbed", airPattern: "recharged",
      cleaningBearer: "owner", wifiBearer: "tenant", maintenanceFeeBearer: "owner",
    },
  });
  await db.gridMeterReading.create({ data: { organizationId: ORG, entryId: entry.id, apartmentId: APT, periodMonth: PERIOD, listingId: ROOM_A, tenancyId: TEN_A, partyId: PARTY_A, amount: "0.00", createdBy: USER } });
  await db.gridMeterReading.create({ data: { organizationId: ORG, entryId: entry.id, apartmentId: APT, periodMonth: PERIOD, listingId: ROOM_B, tenancyId: TEN_B, partyId: PARTY_B, amount: "0.00", createdBy: USER } });
  return { expectedUpdatedAt: entry.updatedAt.toISOString() };
}

/** Tenant-only entry: recharged TNB/air + tenant-bearer wifi ⇒ ownerBorne = 0, so
 *  NO owner charge is minted and the closed-period guard is never reached. */
async function seedTenantOnlyEntry(): Promise<{ expectedUpdatedAt: string }> {
  const db = getDb();
  await seedBase();
  const entry = await db.unitBillsGridEntry.create({
    data: {
      organizationId: ORG, apartmentId: APT, periodMonth: PERIOD, createdBy: USER,
      tnbTotalRaw: "300.00", airSelangorRaw: "40.00", wifi: "120.00", wifiNature: "profit", cleaning: "0.00", // charge-nature gate: this scaffolding WiFi is not what the test measures; "profit" reproduces the pre-gate null behaviour (manager_revenue → IVTEN) exactly
      tnbPattern: "recharged", airPattern: "recharged",
      cleaningBearer: "tenant", wifiBearer: "tenant", maintenanceFeeBearer: "tenant",
    },
  });
  await db.gridMeterReading.create({ data: { organizationId: ORG, entryId: entry.id, apartmentId: APT, periodMonth: PERIOD, listingId: ROOM_A, tenancyId: TEN_A, partyId: PARTY_A, amount: "0.00", createdBy: USER } });
  await db.gridMeterReading.create({ data: { organizationId: ORG, entryId: entry.id, apartmentId: APT, periodMonth: PERIOD, listingId: ROOM_B, tenancyId: TEN_B, partyId: PARTY_B, amount: "0.00", createdBy: USER } });
  return { expectedUpdatedAt: entry.updatedAt.toISOString() };
}

async function seedFrozenPeriod() {
  await getDb().ownerStatementPeriod.create({
    data: {
      organizationId: ORG,
      ownerPartyId: OWNER_PARTY,
      apartmentId: null, // combined scope = the freeze unit
      periodMonth: PERIOD,
      status: "frozen",
      idempotencyKey: `ownerstmt:${OWNER_PARTY}:${PERIOD.toISOString().slice(0, 7)}`,
      sourceMaxUpdatedAt: new Date(),
    },
  });
}

const ownerChargeCount = () =>
  getDb().charge.count({ where: { organizationId: ORG, partyId: OWNER_PARTY } });
const totalChargeCount = () => getDb().charge.count({ where: { organizationId: ORG } });
const loadEntry = () =>
  getDb().unitBillsGridEntry.findUniqueOrThrow({
    where: { organizationId_apartmentId_periodMonth: { organizationId: ORG, apartmentId: APT, periodMonth: PERIOD } },
  });

function setLedgerFlag(on: boolean) {
  if (on) process.env[LEDGER] = "1";
  else delete process.env[LEDGER];
}

dn("bills-grid owner-charge mint — closed-period guard (integration)", () => {
  let savedLedger: string | undefined;
  beforeEach(async () => {
    savedLedger = process.env[LEDGER];
    process.env.ENABLE_PHASE2_BILLING_DOCS = "true"; // the grid→money issuance seam
    setLedgerFlag(true); // default flag ON; the flag-off test overrides + restores
    await cleanup();
  });
  afterEach(async () => {
    delete process.env.ENABLE_PHASE2_BILLING_DOCS;
    if (savedLedger === undefined) delete process.env[LEDGER];
    else process.env[LEDGER] = savedLedger;
    await cleanup();
  });

  it("BG1: frozen owner-month + flag ON → owner-charge mint rejected (row save_failed); NO charge persisted; entry not billed/invoiced", async () => {
    const { expectedUpdatedAt } = await seedOwnerBorneEntry();
    await seedFrozenPeriod();

    const r = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The guard throws ClosedPeriodError inside mintItemizedCharges → the row's
    // $transaction rolls back → billService's catch-all surfaces `save_failed`.
    expect(r.data.results[0].outcome).toBe("save_failed");
    // Nothing half-written: no owner charge, no tenant charge, no document; the
    // lock (billedAt) + invoicedAt stamp are rolled back with the tx.
    expect(await ownerChargeCount()).toBe(0);
    expect(await totalChargeCount()).toBe(0);
    expect(await getDb().billingDocument.count({ where: { organizationId: ORG } })).toBe(0);
    const entry = await loadEntry();
    expect(entry.billedAt).toBeNull();
    expect(entry.invoicedAt).toBeNull();
  });

  it("BG2: open owner-month + flag ON → owner charge minted, outcome invoiced", async () => {
    const { expectedUpdatedAt } = await seedOwnerBorneEntry();
    // No frozen period ⇒ the owner-month is open.
    const r = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.results[0].outcome).toBe("invoiced");
    expect(await ownerChargeCount()).toBe(1); // the GRIDOWN electricity owner charge
    const entry = await loadEntry();
    expect(entry.invoicedAt).not.toBeNull();
  });

  it("BG3: flag OFF into a frozen owner-month → owner charge still minted (byte-identical)", async () => {
    const { expectedUpdatedAt } = await seedOwnerBorneEntry();
    await seedFrozenPeriod();
    setLedgerFlag(false);
    try {
      const r = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt }] });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.data.results[0].outcome).toBe("invoiced");
      expect(await ownerChargeCount()).toBe(1);
    } finally {
      setLedgerFlag(true);
    }
  });

  it("BG4: frozen owner-month + tenant-only entry (ownerBorne=0) → tenant charges still succeed (guard scoped to the owner charge, never blocks tenant-only)", async () => {
    const { expectedUpdatedAt } = await seedTenantOnlyEntry();
    await seedFrozenPeriod();

    const r = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.results[0].outcome).toBe("invoiced");
    // No owner charge (ownerBorne 0), but the tenant split IS billed — the frozen
    // owner period never blocks a tenant-only entry.
    expect(await ownerChargeCount()).toBe(0);
    expect(await totalChargeCount()).toBeGreaterThan(0);
  });
});
