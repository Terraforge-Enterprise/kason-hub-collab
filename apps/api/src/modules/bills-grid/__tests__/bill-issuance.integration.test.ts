/**
 * Task 4: bills-grid Bill → first-issuance of IVTEN/IVOWN invoices (flag-gated).
 *
 * Money-critical. Mirrors the proven charge→invoice pattern from
 * meter/__tests__/charge-bill-documents.integration.test.ts: a dedicated,
 * fully-seeded org (never the shared dev seed), the ENABLE_PHASE2_BILLING_DOCS
 * flag toggled per-test, and an ordered cleanup in FK order.
 *
 * Real local Postgres only.
 * Run: from apps/api
 *   set -a; . ../../.env; set +a; RUN_INTEGRATION=1 npx vitest run \
 *     src/modules/bills-grid/__tests__/bill-issuance.integration.test.ts
 *
 * Coverage (behavior-inventory):
 *  (a) partitioned-issues — flag ON, 2 occupied rooms + absorbed TNB (owner-borne>0)
 *      → 2 IVTEN + 1 IVOWN BillingDocument; each tenant doc scoped to its tenancy;
 *      charges tagged sourceGridEntryId; invoicedAt set; outcome "invoiced".
 *  (b) flag-off — no BillingDocument/Charge created, outcome "billed" (regression-free).
 *  (c) bad-category — a mis-configured owner category (wrong docType) → row "save_failed",
 *      nothing half-issued (Charge + BillingDocument both roll back).
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

// Dedicated fixture ids — distinct namespace so cleanup is org-scoped + total.
const ORG = "b7100000-0000-4000-8000-000000000001";
const USER = "b7100000-0000-4000-8000-000000000002";
const PROP = "b7100000-0000-4000-8000-000000000003";
const APT = "b7100000-0000-4000-8000-000000000004";
const ROOM_A = "b7100000-0000-4000-8000-000000000005";
const ROOM_B = "b7100000-0000-4000-8000-000000000006";
const PARTY_A = "b7100000-0000-4000-8000-000000000007";
const PARTY_B = "b7100000-0000-4000-8000-000000000008";
const OWNER_PARTY = "b7100000-0000-4000-8000-000000000009";
const TEN_A = "b7100000-0000-4000-8000-00000000000a";
const TEN_B = "b7100000-0000-4000-8000-00000000000b";

const PERIOD_STR = "2026-06-01";
const PERIOD = new Date(`${PERIOD_STR}T00:00:00.000Z`);
const session = { orgId: ORG, userId: USER, role: "manager" };

async function cleanup() {
  const db = getDb();
  // Money-doc layer first (BillingDocumentLine → Charge is a nullable ref; delete
  // lines then docs then charges). Then grid tables, then the org skeleton.
  await db.billingDocumentLine.deleteMany({ where: { document: { organizationId: ORG } } });
  await db.billingDocument.deleteMany({ where: { organizationId: ORG } });
  await db.chargeEvent.deleteMany({ where: { organizationId: ORG } });
  await db.charge.deleteMany({ where: { organizationId: ORG } });
  await db.gridMeterReading.deleteMany({ where: { organizationId: ORG } });
  await db.gridExpense.deleteMany({ where: { organizationId: ORG } });
  await db.gridAttachment.deleteMany({ where: { organizationId: ORG } });
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

/**
 * A PARTITIONED apartment with TWO occupied rooms (each its own tenancy/party,
 * pax 1) and an owner party. The entry is absorbed-TNB (owner-borne > 0) with a
 * recharged (tenant-borne) pool via wifi/cleaning so both an IVTEN split and an
 * IVOWN owner charge are produced. Returns the concurrency token for Bill.
 */
async function seedPartitionedEntry(): Promise<{ expectedUpdatedAt: string }> {
  const db = getDb();
  await db.organization.create({ data: { id: ORG, name: "BG4", slug: "bg4", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" } });
  await db.user.create({ data: { id: USER, organizationId: ORG, email: "bg4@example.test", fullName: "BG4 Operator", status: "active", role: "manager", userType: "operator" } });
  await db.property.create({ data: { id: PROP, organizationId: ORG, name: "P", propertyCode: "P-B4", propertyType: "residential", addressLine1: "1", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
  await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "A-B4", listingMode: "PARTITIONED" } });
  await db.party.create({ data: { id: PARTY_A, organizationId: ORG, displayName: "Tenant A", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: PARTY_B, organizationId: ORG, displayName: "Tenant B", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: OWNER_PARTY, organizationId: ORG, displayName: "Owner", partyType: "individual", status: "active" } });
  // Two rooms, both owned by OWNER_PARTY (findApartmentOwnerPartyId reads a room's ownerPartyId).
  await db.listing.create({ data: { id: ROOM_A, organizationId: ORG, apartmentId: APT, listingType: "master_room", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER_PARTY } });
  await db.listing.create({ data: { id: ROOM_B, organizationId: ORG, apartmentId: APT, listingType: "middle_room", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER_PARTY } });
  await db.tenancy.create({ data: { id: TEN_A, organizationId: ORG, propertyId: PROP, unitId: ROOM_A, tenantPartyId: PARTY_A, tenancyCode: "T-A", status: "active", billingStatus: "current", startDate: new Date("2026-01-01"), monthlyRentAmount: "1000.00", numberOfPax: 1 } });
  await db.tenancy.create({ data: { id: TEN_B, organizationId: ORG, propertyId: PROP, unitId: ROOM_B, tenantPartyId: PARTY_B, tenancyCode: "T-B", status: "active", billingStatus: "current", startDate: new Date("2026-01-01"), monthlyRentAmount: "1000.00", numberOfPax: 1 } });

  // The grid entry: absorbed TNB (owner-borne), recharged air, a tenant-borne
  // wifi pool so the per-room split is non-zero. tnbPattern absorbed => ownerBorneTnb
  // records the raw 300 (the IVOWN charge's amount).
  const entry = await db.unitBillsGridEntry.create({
    data: {
      organizationId: ORG, apartmentId: APT, periodMonth: PERIOD, createdBy: USER,
      tnbTotalRaw: "300.00", airSelangorRaw: "40.00", wifi: "120.00", cleaning: "0.00",
      tnbPattern: "absorbed", airPattern: "recharged",
      cleaningBearer: "owner", wifiBearer: "tenant", maintenanceFeeBearer: "owner",
    },
  });
  // Two occupied-room readings (tenancy + party snapshots), no submeter aircon.
  await db.gridMeterReading.create({ data: { organizationId: ORG, entryId: entry.id, apartmentId: APT, periodMonth: PERIOD, listingId: ROOM_A, tenancyId: TEN_A, partyId: PARTY_A, amount: "0.00", createdBy: USER } });
  await db.gridMeterReading.create({ data: { organizationId: ORG, entryId: entry.id, apartmentId: APT, periodMonth: PERIOD, listingId: ROOM_B, tenancyId: TEN_B, partyId: PARTY_B, amount: "0.00", createdBy: USER } });
  return { expectedUpdatedAt: entry.updatedAt.toISOString() };
}

/**
 * A PARTITIONED apartment with ONE active room whose tenancy has `numberOfPax: 0`
 * (reachable via the M9 Excel import, which does not clamp). buildBillRooms marks it
 * `blockedTenancyIds` → the row is `pax_blocked`. Used to prove the CHECK-THEN-LOCK
 * ordering (review fix #1): under the FIXED order the lock is NEVER taken (billedAt
 * stays NULL, the entry stays editable for a set-pax → re-Bill, spec R10); under the
 * OLD lock-then-check order billedAt was set and the owner-borne stranded uninvoiceable.
 */
async function seedZeroPaxPartitionedEntry(): Promise<{ expectedUpdatedAt: string }> {
  const db = getDb();
  await db.organization.create({ data: { id: ORG, name: "BG4", slug: "bg4", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" } });
  await db.user.create({ data: { id: USER, organizationId: ORG, email: "bg4@example.test", fullName: "BG4 Operator", status: "active", role: "manager", userType: "operator" } });
  await db.property.create({ data: { id: PROP, organizationId: ORG, name: "P", propertyCode: "P-B4", propertyType: "residential", addressLine1: "1", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
  await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "A-B4", listingMode: "PARTITIONED" } });
  await db.party.create({ data: { id: PARTY_A, organizationId: ORG, displayName: "Tenant A", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: OWNER_PARTY, organizationId: ORG, displayName: "Owner", partyType: "individual", status: "active" } });
  await db.listing.create({ data: { id: ROOM_A, organizationId: ORG, apartmentId: APT, listingType: "master_room", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER_PARTY } });
  // The one active tenancy has ZERO pax → buildBillRooms blocks it.
  await db.tenancy.create({ data: { id: TEN_A, organizationId: ORG, propertyId: PROP, unitId: ROOM_A, tenantPartyId: PARTY_A, tenancyCode: "T-A", status: "active", billingStatus: "current", startDate: new Date("2026-01-01"), monthlyRentAmount: "1000.00", numberOfPax: 0 } });

  // Absorbed TNB (owner-borne > 0) so the OLD lock-then-check order would have
  // stranded a lock with the owner-borne recorded but NO invoice ever issuable.
  const entry = await db.unitBillsGridEntry.create({
    data: {
      organizationId: ORG, apartmentId: APT, periodMonth: PERIOD, createdBy: USER,
      tnbTotalRaw: "300.00", airSelangorRaw: "40.00", wifi: "120.00", cleaning: "0.00",
      tnbPattern: "absorbed", airPattern: "recharged",
      cleaningBearer: "owner", wifiBearer: "tenant", maintenanceFeeBearer: "owner",
    },
  });
  await db.gridMeterReading.create({ data: { organizationId: ORG, entryId: entry.id, apartmentId: APT, periodMonth: PERIOD, listingId: ROOM_A, tenancyId: TEN_A, partyId: PARTY_A, amount: "0.00", createdBy: USER } });
  return { expectedUpdatedAt: entry.updatedAt.toISOString() };
}

/**
 * A WHOLE apartment (`listingMode: "WHOLE"`) with ONE active tenancy and owner-borne
 * TNB. Whole-unit readings carry `tenancyId: null` (as they do in prod); the service
 * resolves the single active tenancy and synthesizes ONE 1-pax occupied room, so the
 * whole tenant-borne pool is billed to that one tenancy. Exercises
 * resolveWholeUnitTenancy + buildBillRooms's whole-unit branch end-to-end (review fix
 * #3). A tenant-borne wifi pool + absorbed TNB (owner-borne) yields ONE IVTEN + one
 * IVOWN.
 */
async function seedWholeUnitEntry(): Promise<{ expectedUpdatedAt: string }> {
  const db = getDb();
  await db.organization.create({ data: { id: ORG, name: "BG4", slug: "bg4", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" } });
  await db.user.create({ data: { id: USER, organizationId: ORG, email: "bg4@example.test", fullName: "BG4 Operator", status: "active", role: "manager", userType: "operator" } });
  await db.property.create({ data: { id: PROP, organizationId: ORG, name: "P", propertyCode: "P-B4", propertyType: "residential", addressLine1: "1", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
  await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "A-B4", listingMode: "WHOLE" } });
  await db.party.create({ data: { id: PARTY_A, organizationId: ORG, displayName: "Tenant A", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: OWNER_PARTY, organizationId: ORG, displayName: "Owner", partyType: "individual", status: "active" } });
  // ONE whole-unit listing, owner-assigned. The tenancy's unitId = this listing.
  await db.listing.create({ data: { id: ROOM_A, organizationId: ORG, apartmentId: APT, listingType: "whole_unit", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER_PARTY } });
  await db.tenancy.create({ data: { id: TEN_A, organizationId: ORG, propertyId: PROP, unitId: ROOM_A, tenantPartyId: PARTY_A, tenancyCode: "T-A", status: "active", billingStatus: "current", startDate: new Date("2026-01-01"), monthlyRentAmount: "2000.00", numberOfPax: 2 } });

  const entry = await db.unitBillsGridEntry.create({
    data: {
      organizationId: ORG, apartmentId: APT, periodMonth: PERIOD, createdBy: USER,
      tnbTotalRaw: "300.00", airSelangorRaw: "40.00", wifi: "120.00", cleaning: "0.00",
      tnbPattern: "absorbed", airPattern: "recharged",
      cleaningBearer: "owner", wifiBearer: "tenant", maintenanceFeeBearer: "owner",
    },
  });
  // A whole-unit reading carries tenancyId: null (not partitioned to a room-tenancy).
  await db.gridMeterReading.create({ data: { organizationId: ORG, entryId: entry.id, apartmentId: APT, periodMonth: PERIOD, listingId: ROOM_A, tenancyId: null, partyId: null, amount: "0.00", createdBy: USER } });
  return { expectedUpdatedAt: entry.updatedAt.toISOString() };
}

dn("bills-grid Bill → issue IVTEN/IVOWN (Task 4)", () => {
  beforeEach(async () => {
    await cleanup();
  });
  afterEach(async () => {
    delete process.env.ENABLE_PHASE2_BILLING_DOCS;
    await cleanup();
  });

  it("partitioned-issues: Bill mints IVTEN per occupied room + IVOWN, outcome invoiced", async () => {
    process.env.ENABLE_PHASE2_BILLING_DOCS = "true";
    const db = getDb();
    const { expectedUpdatedAt } = await seedPartitionedEntry();

    const r = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const res = r.data.results[0];
    expect(res.outcome).toBe("invoiced");
    // Task 5 (itemized minting): each room's shared pool here is water (recharged
    // air, 20/room) + wifi (tenant-bearer, 60/room) = 2 non-zero components per
    // room (electricity is RM0 — absorbed TNB has no submeter aircon; sewerage
    // and cleaning are RM0 too — indah hardcoded 0, cleaning owner-borne at 0).
    // Task 6 (grouped issuance): issueGroupedGridInvoiceTx groups each room's
    // components into ONE itemized document per counterparty — 2 rooms yield 2
    // tenant documents (2 lines each), never 4 single-line documents.
    expect(res.tenantInvoiceIds).toHaveLength(2);
    expect(res.ownerInvoiceIds).toHaveLength(1);

    const docs = await db.billingDocument.findMany({ where: { organizationId: ORG, apartmentId: APT } });
    const tenantDocs = docs.filter((d) => d.counterpartyType === "tenant");
    const ownerDocs = docs.filter((d) => d.counterpartyType === "owner");
    expect(tenantDocs).toHaveLength(2);
    // Owner side: TNB absorbed (300) is the only non-zero owner component —
    // owner cleaning is RM0 (cleaning=0) — so still exactly 1 owner document.
    expect(ownerDocs).toHaveLength(1);
    for (const d of docs) expect(d.docType).toBe("invoice");
    // Each tenant doc is scoped to its own tenancy (1 doc each for TEN_A/TEN_B).
    expect(new Set(tenantDocs.map((d) => d.tenancyId))).toEqual(new Set([TEN_A, TEN_B]));
    // The owner doc is addressed to the owner party.
    expect(ownerDocs[0].partyId).toBe(OWNER_PARTY);
    // Each tenant document is itemized to its room's 2 components (water + wifi).
    for (const d of tenantDocs) {
      const lines = await db.billingDocumentLine.findMany({ where: { documentId: d.id } });
      expect(lines).toHaveLength(2);
    }

    // Every minted charge is tagged with the real entry id (FK-critical).
    const entry = await db.unitBillsGridEntry.findUniqueOrThrow({ where: { organizationId_apartmentId_periodMonth: { organizationId: ORG, apartmentId: APT, periodMonth: PERIOD } } });
    const charges = await db.charge.findMany({ where: { organizationId: ORG } });
    expect(charges.length).toBe(5); // (water+wifi) × 2 rooms + 1 owner electricity
    for (const c of charges) expect(c.sourceGridEntryId).toBe(entry.id);
    // The entry is marked invoiced (and stays billed).
    expect(entry.invoicedAt).not.toBeNull();
    expect(entry.billedAt).not.toBeNull();
  });

  it("flag-off: Bill records owner-borne + locks but issues NO Charge/BillingDocument, outcome billed", async () => {
    delete process.env.ENABLE_PHASE2_BILLING_DOCS;
    const db = getDb();
    const { expectedUpdatedAt } = await seedPartitionedEntry();

    const r = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.results[0].outcome).toBe("billed");

    expect(await db.charge.count({ where: { organizationId: ORG } })).toBe(0);
    expect(await db.billingDocument.count({ where: { organizationId: ORG } })).toBe(0);
    const entry = await db.unitBillsGridEntry.findUniqueOrThrow({ where: { organizationId_apartmentId_periodMonth: { organizationId: ORG, apartmentId: APT, periodMonth: PERIOD } } });
    expect(entry.billedAt).not.toBeNull();      // still locked
    expect(entry.invoicedAt).toBeNull();         // …but never invoiced
    expect(String(entry.ownerBorneTnb)).toBe("300"); // owner-borne still recorded (unchanged behaviour)
  });

  it("bad-category: a mis-configured owner category (wrong docType) → row save_failed, nothing half-issued", async () => {
    process.env.ENABLE_PHASE2_BILLING_DOCS = "true";
    const db = getDb();
    const { expectedUpdatedAt } = await seedPartitionedEntry();

    // Poison the owner category BEFORE Bill: pre-create the IVOWN
    // "electricity_owner" category routed to a credit_note. ensureChargeCategorySeeds
    // is create-only, so this row survives the in-tx re-seed; issueDocumentTx then
    // throws DOCUMENT_REFERENCE_REQUIRED (a CN needs originalDocumentId), aborting
    // the row. Task 5 (itemized minting) routes this fixture's owner-borne TNB
    // (absorbed) through `electricity_owner`, NOT the old `cleaning_owner`
    // placeholder — poisoning `cleaning_owner` no longer touches this scenario at
    // all (this fixture's owner cleaning component is RM0 and never minted), so
    // the poisoned category must follow the money to the one actually exercised.
    const ivown = await db.documentSeries.upsert({
      where: { organizationId_code: { organizationId: ORG, code: "IVOWN" } },
      update: {},
      create: { organizationId: ORG, code: "IVOWN", prefix: "IVOWN" },
    });
    await db.chargeCategory.create({
      data: {
        organizationId: ORG, code: "electricity_owner", name: "Electricity (poisoned)", family: "owner_income",
        docType: "credit_note", seriesId: ivown.id, defaultSstRate: "0", eInvoiceEligible: false,
        isSystem: true, active: true, sortOrder: 110,
      },
    });

    const r = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.results[0].outcome).toBe("save_failed");

    // The WHOLE row rolled back — no charge, no document, entry never marked invoiced.
    expect(await db.charge.count({ where: { organizationId: ORG } })).toBe(0);
    expect(await db.billingDocument.count({ where: { organizationId: ORG } })).toBe(0);
    const entry = await db.unitBillsGridEntry.findUniqueOrThrow({ where: { organizationId_apartmentId_periodMonth: { organizationId: ORG, apartmentId: APT, periodMonth: PERIOD } } });
    expect(entry.invoicedAt).toBeNull();
  });

  it("pax-blocked-does-not-lock: a zero-pax partitioned entry returns pax_blocked with billedAt STILL NULL and NO charge/doc (CHECK-THEN-LOCK, review fix #1)", async () => {
    // This is the RED→GREEN for the CRITICAL lock-ordering fix. Under the OLD
    // lock-then-check order the entry was LOCKED (billedAt set) with owner-borne
    // recorded but NO invoice, and a retry hit `already_billed` → the owner-borne
    // could NEVER be invoiced. Under the FIXED check-then-lock order the pax gate
    // runs BEFORE the lock, so a pax_blocked row writes NOTHING and stays editable.
    process.env.ENABLE_PHASE2_BILLING_DOCS = "true";
    const db = getDb();
    const { expectedUpdatedAt } = await seedZeroPaxPartitionedEntry();

    const r = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.results[0].outcome).toBe("pax_blocked");

    // The load-bearing assertion: the lock was NEVER taken. Under the old order
    // billedAt would be set here; under the fix it stays NULL and the entry is
    // editable for a set-pax → re-Bill (spec R10).
    const entry = await db.unitBillsGridEntry.findUniqueOrThrow({ where: { organizationId_apartmentId_periodMonth: { organizationId: ORG, apartmentId: APT, periodMonth: PERIOD } } });
    expect(entry.billedAt).toBeNull();      // NOT locked
    expect(entry.invoicedAt).toBeNull();     // NOT invoiced
    expect(entry.ownerBorneTnb).toBeNull();  // owner-borne NOT stranded on a locked row
    expect(await db.charge.count({ where: { organizationId: ORG } })).toBe(0);
    expect(await db.billingDocument.count({ where: { organizationId: ORG } })).toBe(0);
  });

  it("whole-unit-issues: a WHOLE apartment with one active tenancy mints ONE IVTEN (full tenant pool) + IVOWN, outcome invoiced (review fix #3)", async () => {
    process.env.ENABLE_PHASE2_BILLING_DOCS = "true";
    const db = getDb();
    const { expectedUpdatedAt } = await seedWholeUnitEntry();

    const r = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const res = r.data.results[0];
    expect(res.outcome).toBe("invoiced");
    // Task 5 (itemized minting): the single synthesized whole-unit room got 100%
    // of the pool — water (recharged air, 40) + wifi (tenant-bearer, 120) = 2
    // non-zero components (electricity RM0, same reasoning as partitioned-issues
    // above). Task 6 (grouped issuance): both components share the SAME
    // partyId/unitId/month, so they group into ONE itemized tenant document
    // (2 lines), not 2 single-line documents.
    expect(res.tenantInvoiceIds).toHaveLength(1);
    expect(res.ownerInvoiceIds).toHaveLength(1);

    const docs = await db.billingDocument.findMany({ where: { organizationId: ORG, apartmentId: APT } });
    const tenantDocs = docs.filter((d) => d.counterpartyType === "tenant");
    const ownerDocs = docs.filter((d) => d.counterpartyType === "owner");
    expect(tenantDocs).toHaveLength(1);
    expect(ownerDocs).toHaveLength(1);
    for (const d of docs) expect(d.docType).toBe("invoice");
    // The tenant doc is scoped to the whole-unit tenancy.
    expect(tenantDocs[0].tenancyId).toBe(TEN_A);
    expect(ownerDocs[0].partyId).toBe(OWNER_PARTY);
    const tenantLines = await db.billingDocumentLine.findMany({ where: { documentId: tenantDocs[0].id } });
    expect(tenantLines).toHaveLength(2);

    const entry = await db.unitBillsGridEntry.findUniqueOrThrow({ where: { organizationId_apartmentId_periodMonth: { organizationId: ORG, apartmentId: APT, periodMonth: PERIOD } } });
    const charges = await db.charge.findMany({ where: { organizationId: ORG } });
    expect(charges.length).toBe(3); // water + wifi (tenant) + electricity (owner)
    for (const c of charges) expect(c.sourceGridEntryId).toBe(entry.id);
    expect(entry.invoicedAt).not.toBeNull();
    expect(entry.billedAt).not.toBeNull();
  });
});
