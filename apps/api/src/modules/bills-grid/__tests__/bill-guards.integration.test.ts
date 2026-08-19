/**
 * Task 5: double-count guard (`already_invoiced`) + pax-gate confirmation.
 *
 * Money-critical. Mirrors bill-issuance.integration.test.ts: a dedicated,
 * fully-seeded org (never the shared dev seed), the ENABLE_PHASE2_BILLING_DOCS
 * flag toggled per-test, and an ordered cleanup in FK order.
 *
 * THE CRITICAL RULE (Task 4): the double-count guard runs PRE-LOCK. If it fires,
 * the entry's `billedAt` stays NULL and nothing is written (the entry stays
 * editable) — exactly like the pax gate. A guard that ran AFTER the lock would
 * strand the entry locked-but-uninvoiced (the bug Task 4 fixed). The load-bearing
 * assertion below is `billedAt` STILL NULL on an `already_invoiced` return.
 *
 * R7 predicate note: the guard fires ONLY for a LIVE SHARED-UTILITY bill from a
 * FOREIGN path — a live (`documentStatus:"ISSUED"`) `invoice`/`debit_note` anchored
 * on a LIVE `chargeType:"utility"` charge (`status` not credited/void) that is NOT
 * this entry's own. The meter/charge shared-utility path mints `chargeType:"utility"`
 * charges that route (CHARGE_TYPE_TO_CATEGORY_CODE → `utility_tnb`) to a `docType:
 * "debit_note"` DEP; the grid's own prior Bills issue IVTEN/IVOWN `invoice`s — both
 * caught. Rent/aircond/carpark/deposit docs and reversed charges are NOT — that
 * over-match (the original chargeType-blind guard) wrongly blocked nearly every real
 * grid Bill (review Findings 1–3).
 *
 * Real local Postgres only.
 * Run: from apps/api
 *   set -a; . ../../.env; set +a; RUN_INTEGRATION=1 npx vitest run \
 *     src/modules/bills-grid/__tests__/bill-guards.integration.test.ts
 *
 * Coverage (behavior-inventory):
 *  (a) double-count — an apartment-month that ALREADY has a live ISSUED meter-path
 *      utility document (a `utility` Charge, sourceGridEntryId null, + its issued
 *      DEP doc) → grid Bill returns `already_invoiced`, `billedAt` STILL NULL, no
 *      new Charge/BillingDocument minted. (True positive — must still fire.)
 *  (b) rent-DEP-does-not-block — a live meter-path RENT doc (no utility doc) → the
 *      grid Bill ISSUES (`invoiced`), NOT `already_invoiced` (Finding 1 — the
 *      chargeType-blind guard wrongly blocked this).
 *  (c) credited-utility-does-not-block — a meter-path `utility` charge REVERSED via
 *      the credit-note path (charge→`credited`, a live credit_note) → the grid Bill
 *      ISSUES, NOT `already_invoiced` (Finding 2).
 *  (d) inner-OR own-charge — a FRESH entry (invoicedAt NULL) whose only foreign
 *      candidate is its OWN sourceGridEntryId charge → guard does NOT fire (proves
 *      the inner OR exclusion, unmasked by the outer invoicedAt gate).
 *  (e) re-Bill exemption — an entry with `invoicedAt` set (its own prior issuance)
 *      does NOT trip `already_invoiced` (Task 6 supersede handles it).
 *  (f) pax-block-partial + whole-not-blocked — confirm Task 4's pax gate still
 *      behaves (a partitioned 0-pax active room → `pax_blocked`; a WHOLE unit at
 *      0 stored pax → issues, not `pax_blocked`).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { billService } from "../service";
import { issueDocumentsForChargesTx } from "../../billing-documents/issue.service";
import { creditPostedChargeTx } from "../../billing-documents/credit-notes.service";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`Refusing non-local DB host: ${host}`);
}

// Dedicated fixture ids — distinct namespace so cleanup is org-scoped + total.
const ORG = "b7500000-0000-4000-8000-000000000001";
const USER = "b7500000-0000-4000-8000-000000000002";
const PROP = "b7500000-0000-4000-8000-000000000003";
const APT = "b7500000-0000-4000-8000-000000000004";
const ROOM_A = "b7500000-0000-4000-8000-000000000005";
const ROOM_B = "b7500000-0000-4000-8000-000000000006";
const PARTY_A = "b7500000-0000-4000-8000-000000000007";
const PARTY_B = "b7500000-0000-4000-8000-000000000008";
const OWNER_PARTY = "b7500000-0000-4000-8000-000000000009";
const TEN_A = "b7500000-0000-4000-8000-00000000000a";
const TEN_B = "b7500000-0000-4000-8000-00000000000b";

const PERIOD_STR = "2026-06-01";
const PERIOD = new Date(`${PERIOD_STR}T00:00:00.000Z`);
const session = { orgId: ORG, userId: USER, role: "manager" };

async function cleanup() {
  const db = getDb();
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

/** Org skeleton shared by all fixtures. */
async function seedOrg() {
  const db = getDb();
  await db.organization.create({ data: { id: ORG, name: "BG5", slug: "bg5", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" } });
  await db.user.create({ data: { id: USER, organizationId: ORG, email: "bg5@example.test", fullName: "BG5 Operator", status: "active", role: "manager", userType: "operator" } });
  await db.property.create({ data: { id: PROP, organizationId: ORG, name: "P", propertyCode: "P-B5", propertyType: "residential", addressLine1: "1", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
}

/**
 * A PARTITIONED apartment with TWO occupied rooms (each its own tenancy/party,
 * pax 1) and an owner party — the standard billable partitioned fixture (mirrors
 * bill-issuance's seedPartitionedEntry). Returns the entry's concurrency token.
 */
async function seedPartitionedEntry(): Promise<{ expectedUpdatedAt: string }> {
  const db = getDb();
  await seedOrg();
  await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "A-B5", listingMode: "PARTITIONED" } });
  await db.party.create({ data: { id: PARTY_A, organizationId: ORG, displayName: "Tenant A", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: PARTY_B, organizationId: ORG, displayName: "Tenant B", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: OWNER_PARTY, organizationId: ORG, displayName: "Owner", partyType: "individual", status: "active" } });
  await db.listing.create({ data: { id: ROOM_A, organizationId: ORG, apartmentId: APT, listingType: "master_room", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER_PARTY } });
  await db.listing.create({ data: { id: ROOM_B, organizationId: ORG, apartmentId: APT, listingType: "middle_room", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER_PARTY } });
  await db.tenancy.create({ data: { id: TEN_A, organizationId: ORG, propertyId: PROP, unitId: ROOM_A, tenantPartyId: PARTY_A, tenancyCode: "T-A", status: "active", billingStatus: "current", startDate: new Date("2026-01-01"), monthlyRentAmount: "1000.00", numberOfPax: 1 } });
  await db.tenancy.create({ data: { id: TEN_B, organizationId: ORG, propertyId: PROP, unitId: ROOM_B, tenantPartyId: PARTY_B, tenancyCode: "T-B", status: "active", billingStatus: "current", startDate: new Date("2026-01-01"), monthlyRentAmount: "1000.00", numberOfPax: 1 } });

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

/**
 * Mint a LIVE meter-path utility document for (ROOM_A, PERIOD): a real
 * `chargeType: "utility"` Charge with `sourceGridEntryId: null` (NOT sourced by the
 * grid), then issue its BillingDocument via the SAME immutable core the meter path
 * uses (issueDocumentsForChargesTx). This charge routes utility→utility_tnb→DEP, so
 * the issued doc is a `debit_note` with `documentStatus: "ISSUED"`, `listingId:
 * ROOM_A`, `billingMonth: PERIOD` — exactly the shape the guard must catch. Returns
 * nothing; asserts an ISSUED doc now exists for the unit-month.
 */
async function seedLiveMeterPathDoc(): Promise<void> {
  const db = getDb();
  const charge = await db.charge.create({
    data: {
      organizationId: ORG,
      chargeNumber: `UTIL-METER-${ROOM_A}`,
      unitId: ROOM_A,
      partyId: PARTY_A,
      chargeType: "utility",
      status: "posted",
      postedAt: new Date(),
      description: "Meter-path TNB",
      dueDate: PERIOD,
      amount: "88.00",
      currency: "MYR",
      outstandingAmount: "88.00",
      billingMonth: PERIOD,
      sourceGridEntryId: null, // meter/charge path — NOT the grid
      attachmentKeys: [],
    },
    select: { id: true },
  });
  await db.$transaction((tx) => issueDocumentsForChargesTx(tx, [charge.id], USER));
  const doc = await db.billingDocument.findFirst({ where: { organizationId: ORG, documentStatus: "ISSUED", listingId: ROOM_A, billingMonth: PERIOD }, select: { id: true, docType: true } });
  if (!doc) throw new Error("fixture: meter-path doc was not issued");
}

/**
 * Mint a LIVE meter-path RENT document for (ROOM_A, PERIOD): a real
 * `chargeType: "rental"` Charge with `sourceGridEntryId: null`, then issue its DEP
 * document. Every occupied unit gets a rent doc for the month — the false-positive
 * that made the ORIGINAL (chargeType-blind) guard block nearly every real grid Bill.
 * After the fix (guard scoped to `chargeType: "utility"`), this must NOT block.
 * A `rental` charge routes rental→DEP, so the issued doc is `documentStatus: "ISSUED"`
 * on (ROOM_A, PERIOD) — same doc shape as a utility DEP, differing ONLY in chargeType.
 */
async function seedLiveMeterPathRentDoc(): Promise<void> {
  const db = getDb();
  const charge = await db.charge.create({
    data: {
      organizationId: ORG,
      chargeNumber: `RENT-METER-${ROOM_A}`,
      unitId: ROOM_A,
      tenancyId: TEN_A,
      partyId: PARTY_A,
      chargeType: "rental", // NOT a shared utility — must not anchor the guard
      status: "posted",
      postedAt: new Date(),
      description: "Meter-path rent",
      dueDate: PERIOD,
      amount: "1000.00",
      currency: "MYR",
      outstandingAmount: "1000.00",
      billingMonth: PERIOD,
      sourceGridEntryId: null, // meter/charge path — NOT the grid
      attachmentKeys: [],
    },
    select: { id: true },
  });
  await db.$transaction((tx) => issueDocumentsForChargesTx(tx, [charge.id], USER));
  const doc = await db.billingDocument.findFirst({ where: { organizationId: ORG, documentStatus: "ISSUED", listingId: ROOM_A, billingMonth: PERIOD }, select: { id: true } });
  if (!doc) throw new Error("fixture: meter-path rent doc was not issued");
}

/**
 * Mint a LIVE meter-path `utility` Charge + its issued DEP for (ROOM_A, PERIOD), then
 * REVERSE it via the credit-note path: the charge is set `status: "credited"` and a
 * live `docType: "credit_note"` document is issued carrying the SAME chargeId in its
 * line, while the ORIGINAL DEP keeps `documentStatus: "ISSUED"` (only the settlement
 * `status` moves to `offset`; only CANCEL_AND_REPLACE flips `documentStatus`). This is
 * the reversed-unit-month state (Finding 2). After the fix the guard must NOT fire:
 * the anchoring charge is dead (`credited`), and the only live doc referencing it is a
 * `credit_note` (a reversal, excluded). We reproduce the STATE directly (charge→credited
 * + a live credit_note) rather than wiring the full void path (heavy, and orthogonal).
 */
async function seedCreditedMeterPathUtility(): Promise<void> {
  const db = getDb();
  const charge = await db.charge.create({
    data: {
      organizationId: ORG,
      chargeNumber: `UTIL-CREDITED-${ROOM_A}`,
      unitId: ROOM_A,
      tenancyId: TEN_A,
      partyId: PARTY_A,
      chargeType: "utility",
      status: "posted",
      postedAt: new Date(),
      description: "Meter-path TNB (to be credited)",
      dueDate: PERIOD,
      amount: "88.00",
      currency: "MYR",
      outstandingAmount: "88.00",
      billingMonth: PERIOD,
      sourceGridEntryId: null,
      attachmentKeys: [],
    },
    select: { id: true },
  });
  // Issue the original DEP, then reverse it through the REAL credit-note core
  // (creditPostedChargeTx — the same path meter void uses): it issues a live
  // `credit_note` carrying the same chargeId, flips the charge → `credited`
  // (outstanding 0), and marks the original DEP's settlement status `offset` while
  // its `documentStatus` stays `ISSUED`. This is the exact reversed-unit-month state.
  await db.$transaction(async (tx) => {
    await issueDocumentsForChargesTx(tx, [charge.id], USER);
    const res = await creditPostedChargeTx(tx, { organizationId: ORG, chargeId: charge.id, reason: "test reversal", actorUserId: USER, actorRole: "manager" });
    if (res.kind !== "credit_note") throw new Error(`fixture: expected credit_note, got ${res.kind}`);
  });
  // Sanity: charge is dead (credited), a live credit_note references it, and the
  // original DEP is still documentStatus ISSUED (only its settlement status moved).
  const credited = await db.charge.findUniqueOrThrow({ where: { id: charge.id }, select: { status: true } });
  if (credited.status !== "credited") throw new Error(`fixture: charge status is ${credited.status}, expected credited`);
  const cn = await db.billingDocument.findFirst({ where: { organizationId: ORG, docType: "credit_note", documentStatus: "ISSUED", lines: { some: { chargeId: charge.id } } }, select: { id: true } });
  if (!cn) throw new Error("fixture: live credit_note referencing the credited charge was not issued");
  const origDep = await db.billingDocument.findFirst({ where: { organizationId: ORG, docType: "debit_note", documentStatus: "ISSUED", listingId: ROOM_A, billingMonth: PERIOD }, select: { id: true } });
  if (!origDep) throw new Error("fixture: original credited-utility DEP is not ISSUED as expected");
}

/**
 * A PARTITIONED apartment with ONE active room whose tenancy has `numberOfPax: 0`
 * (reachable via the M9 Excel import, which does not clamp) → buildBillRooms marks it
 * `blockedTenancyIds` → the row is `pax_blocked` (Task 4/5).
 */
async function seedZeroPaxPartitionedEntry(): Promise<{ expectedUpdatedAt: string }> {
  const db = getDb();
  await seedOrg();
  await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "A-B5", listingMode: "PARTITIONED" } });
  await db.party.create({ data: { id: PARTY_A, organizationId: ORG, displayName: "Tenant A", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: OWNER_PARTY, organizationId: ORG, displayName: "Owner", partyType: "individual", status: "active" } });
  await db.listing.create({ data: { id: ROOM_A, organizationId: ORG, apartmentId: APT, listingType: "master_room", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER_PARTY } });
  await db.tenancy.create({ data: { id: TEN_A, organizationId: ORG, propertyId: PROP, unitId: ROOM_A, tenantPartyId: PARTY_A, tenancyCode: "T-A", status: "active", billingStatus: "current", startDate: new Date("2026-01-01"), monthlyRentAmount: "1000.00", numberOfPax: 0 } });

  const entry = await db.unitBillsGridEntry.create({
    data: {
      organizationId: ORG, apartmentId: APT, periodMonth: PERIOD, createdBy: USER,
      tnbTotalRaw: "300.00", airSelangorRaw: "40.00", wifi: "120.00", wifiNature: "profit", cleaning: "0.00", // charge-nature gate: this scaffolding WiFi is not what the test measures; "profit" reproduces the pre-gate null behaviour (manager_revenue → IVTEN) exactly
      tnbPattern: "absorbed", airPattern: "recharged",
      cleaningBearer: "owner", wifiBearer: "tenant", maintenanceFeeBearer: "owner",
    },
  });
  await db.gridMeterReading.create({ data: { organizationId: ORG, entryId: entry.id, apartmentId: APT, periodMonth: PERIOD, listingId: ROOM_A, tenancyId: TEN_A, partyId: PARTY_A, amount: "0.00", createdBy: USER } });
  return { expectedUpdatedAt: entry.updatedAt.toISOString() };
}

/**
 * A WHOLE apartment (`listingMode: "WHOLE"`) with ONE active tenancy at stored pax 0.
 * A whole unit is EXEMPT from the pax gate (billed as 1 pax via the synthesized room),
 * so Bill must issue (not `pax_blocked`).
 */
async function seedWholeUnitZeroPaxEntry(): Promise<{ expectedUpdatedAt: string }> {
  const db = getDb();
  await seedOrg();
  await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "A-B5", listingMode: "WHOLE" } });
  await db.party.create({ data: { id: PARTY_A, organizationId: ORG, displayName: "Tenant A", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: OWNER_PARTY, organizationId: ORG, displayName: "Owner", partyType: "individual", status: "active" } });
  await db.listing.create({ data: { id: ROOM_A, organizationId: ORG, apartmentId: APT, listingType: "whole_unit", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER_PARTY } });
  // Stored pax 0 — a whole unit is exempt (billed as 1 pax), so this must NOT block.
  await db.tenancy.create({ data: { id: TEN_A, organizationId: ORG, propertyId: PROP, unitId: ROOM_A, tenantPartyId: PARTY_A, tenancyCode: "T-A", status: "active", billingStatus: "current", startDate: new Date("2026-01-01"), monthlyRentAmount: "2000.00", numberOfPax: 0 } });

  const entry = await db.unitBillsGridEntry.create({
    data: {
      organizationId: ORG, apartmentId: APT, periodMonth: PERIOD, createdBy: USER,
      tnbTotalRaw: "300.00", airSelangorRaw: "40.00", wifi: "120.00", wifiNature: "profit", cleaning: "0.00", // charge-nature gate: this scaffolding WiFi is not what the test measures; "profit" reproduces the pre-gate null behaviour (manager_revenue → IVTEN) exactly
      tnbPattern: "absorbed", airPattern: "recharged",
      cleaningBearer: "owner", wifiBearer: "tenant", maintenanceFeeBearer: "owner",
    },
  });
  await db.gridMeterReading.create({ data: { organizationId: ORG, entryId: entry.id, apartmentId: APT, periodMonth: PERIOD, listingId: ROOM_A, tenancyId: null, partyId: null, amount: "0.00", createdBy: USER } });
  return { expectedUpdatedAt: entry.updatedAt.toISOString() };
}

dn("bills-grid Bill → double-count guard + pax gate (Task 5)", () => {
  beforeEach(async () => {
    await cleanup();
  });
  afterEach(async () => {
    delete process.env.ENABLE_PHASE2_BILLING_DOCS;
    await cleanup();
  });

  it("double-count: an apartment-month with a live meter-path utility doc → conflicting_invoice, billedAt STILL NULL, no new doc", async () => {
    process.env.ENABLE_PHASE2_BILLING_DOCS = "true";
    const db = getDb();
    const { expectedUpdatedAt } = await seedPartitionedEntry();
    await seedLiveMeterPathDoc(); // one meter-path DEP for ROOM_A / PERIOD, sourceGridEntryId null

    const chargesBefore = await db.charge.count({ where: { organizationId: ORG } });
    const docsBefore = await db.billingDocument.count({ where: { organizationId: ORG } });
    expect(chargesBefore).toBe(1); // just the meter-path charge
    expect(docsBefore).toBe(1);    // just the meter-path doc

    const r = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.results[0].outcome).toBe("conflicting_invoice"); // meter path = non-grid provenance → fail closed

    // Load-bearing (PRE-LOCK): the guard fired BEFORE the lock — billedAt stays NULL,
    // the entry stays editable, and NOTHING new was minted.
    const entry = await db.unitBillsGridEntry.findUniqueOrThrow({ where: { organizationId_apartmentId_periodMonth: { organizationId: ORG, apartmentId: APT, periodMonth: PERIOD } } });
    expect(entry.billedAt).toBeNull();
    expect(entry.invoicedAt).toBeNull();
    expect(entry.ownerBorneTnb).toBeNull();
    expect(await db.charge.count({ where: { organizationId: ORG } })).toBe(chargesBefore); // no new charge
    expect(await db.billingDocument.count({ where: { organizationId: ORG } })).toBe(docsBefore); // no new doc
  });

  it("rent-DEP-does-not-block: a live meter-path RENT doc (no utility doc) → invoiced, NOT already_invoiced", async () => {
    // PRIMARY RED for Finding 1: the ORIGINAL chargeType-blind guard treated ANY
    // live-documented charge for the unit-month as "already utility-invoiced". A rent
    // DEP is posted for ~every occupied unit, so it fired on nearly every real Bill.
    // After scoping the guard to `chargeType: "utility"`, a rent-only unit-month must
    // Bill through (issue invoices), NOT return already_invoiced.
    process.env.ENABLE_PHASE2_BILLING_DOCS = "true";
    const db = getDb();
    const { expectedUpdatedAt } = await seedPartitionedEntry();
    await seedLiveMeterPathRentDoc(); // rent DEP for ROOM_A/PERIOD — NOT a shared utility

    const r = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.results[0].outcome).toBe("invoiced");
    expect(r.data.results[0].outcome).not.toBe("already_invoiced");

    // The Bill actually issued: the entry locked + stamped invoicedAt, and grid
    // (sourceGridEntryId != null) charges/docs were minted on top of the rent doc.
    const entry = await db.unitBillsGridEntry.findUniqueOrThrow({ where: { organizationId_apartmentId_periodMonth: { organizationId: ORG, apartmentId: APT, periodMonth: PERIOD } } });
    expect(entry.billedAt).not.toBeNull();
    expect(entry.invoicedAt).not.toBeNull();
    expect(await db.charge.count({ where: { organizationId: ORG, sourceGridEntryId: entry.id } })).toBeGreaterThan(0);
  });

  it("credited-utility-does-not-block: a meter-path utility charge REVERSED via credit note → invoiced, NOT already_invoiced", async () => {
    // Finding 2: a utility charge voided via the credit-note path stays
    // `status:"credited"` and its original DEP keeps `documentStatus:"ISSUED"`, while a
    // live credit_note carries the same chargeId. A reversed (un-billed) unit-month
    // must be re-billable — the guard must NOT anchor on the dead charge, and must NOT
    // treat the credit_note as a live bill.
    process.env.ENABLE_PHASE2_BILLING_DOCS = "true";
    const db = getDb();
    const { expectedUpdatedAt } = await seedPartitionedEntry();
    await seedCreditedMeterPathUtility(); // utility charge credited + live credit_note

    const r = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.results[0].outcome).toBe("invoiced");
    expect(r.data.results[0].outcome).not.toBe("already_invoiced");

    const entry = await db.unitBillsGridEntry.findUniqueOrThrow({ where: { organizationId_apartmentId_periodMonth: { organizationId: ORG, apartmentId: APT, periodMonth: PERIOD } } });
    expect(entry.invoicedAt).not.toBeNull();
  });

  it("inner-OR own-charge: a FRESH entry (invoicedAt null) whose only foreign candidate is its OWN sourceGridEntryId charge → guard does NOT fire", async () => {
    // Proves the INNER OR exclusion directly (the existing re-Bill-exemption test
    // masks it behind the OUTER invoicedAt gate). Here invoicedAt is NULL — the guard
    // RUNS — but the only live-doc'd utility charge for the unit-month carries
    // sourceGridEntryId == entry.id, so the OR's `{ sourceGridEntryId: { not: entry.id } }`
    // branch (and the null branch) exclude it → foreignCharges empty → no already_invoiced.
    process.env.ENABLE_PHASE2_BILLING_DOCS = "true";
    const db = getDb();
    await seedPartitionedEntry();
    const entry0 = await db.unitBillsGridEntry.findUniqueOrThrow({ where: { organizationId_apartmentId_periodMonth: { organizationId: ORG, apartmentId: APT, periodMonth: PERIOD } } });
    // A live utility charge + issued doc keyed to THIS entry (sourceGridEntryId = entry.id),
    // but the entry is left FRESH (invoicedAt NULL) so the guard is not short-circuited by
    // the outer gate — the inner OR is the ONLY thing that can prevent already_invoiced.
    const ownCharge = await db.charge.create({
      data: {
        organizationId: ORG, chargeNumber: `GRIDUTIL-OWNFRESH-${ROOM_A}`, unitId: ROOM_A, tenancyId: TEN_A, partyId: PARTY_A,
        chargeType: "utility", status: "posted", postedAt: new Date(), description: "Own fresh", dueDate: PERIOD,
        amount: "50.00", currency: "MYR", outstandingAmount: "50.00", billingMonth: PERIOD,
        sourceGridEntryId: entry0.id, attachmentKeys: [],
      },
      select: { id: true },
    });
    await db.$transaction((tx) => issueDocumentsForChargesTx(tx, [ownCharge.id], USER));
    const fresh = await db.unitBillsGridEntry.findUniqueOrThrow({ where: { id: entry0.id } });
    expect(fresh.invoicedAt).toBeNull(); // guard RUNS (not exempted by the outer gate)

    const r = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt: fresh.updatedAt.toISOString() }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.results[0].outcome).not.toBe("already_invoiced");
  });

  it("re-Bill exemption: an entry with its OWN prior issuance (invoicedAt set) does NOT trip already_invoiced", async () => {
    // A live doc keyed on THIS entry's own charge must NOT fire the guard — that is
    // Task 6's supersede path. We simulate the entry's own prior issuance by tagging
    // a live charge with sourceGridEntryId = the entry's id + setting invoicedAt.
    process.env.ENABLE_PHASE2_BILLING_DOCS = "true";
    const db = getDb();
    const { expectedUpdatedAt: _ignored } = await seedPartitionedEntry();
    const entry0 = await db.unitBillsGridEntry.findUniqueOrThrow({ where: { organizationId_apartmentId_periodMonth: { organizationId: ORG, apartmentId: APT, periodMonth: PERIOD } } });

    // The entry's OWN live charge + issued doc (sourceGridEntryId = entry.id).
    const ownCharge = await db.charge.create({
      data: {
        organizationId: ORG, chargeNumber: `GRIDUTIL-OWN-${ROOM_A}`, unitId: ROOM_A, tenancyId: TEN_A, partyId: PARTY_A,
        chargeType: "utility", status: "posted", postedAt: new Date(), description: "Own prior", dueDate: PERIOD,
        amount: "50.00", currency: "MYR", outstandingAmount: "50.00", billingMonth: PERIOD,
        sourceGridEntryId: entry0.id, attachmentKeys: [],
      },
      select: { id: true },
    });
    await db.$transaction((tx) => issueDocumentsForChargesTx(tx, [ownCharge.id], USER));
    // Mark the entry as already-invoiced (Task 4 stamps this on first issuance).
    await db.unitBillsGridEntry.update({ where: { id: entry0.id }, data: { invoicedAt: new Date() } });
    const fresh = await db.unitBillsGridEntry.findUniqueOrThrow({ where: { id: entry0.id } });

    const r = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt: fresh.updatedAt.toISOString() }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The guard must NOT fire for the entry's OWN prior issuance. Task 6 (supersede)
    // is not built yet, so the exact onward outcome is out of scope here — we only
    // assert the double-count guard did NOT short-circuit this entry.
    expect(r.data.results[0].outcome).not.toBe("already_invoiced");
  });

  it("pax-block-partial: a partitioned entry with a 0-pax active room → pax_blocked, billedAt STILL NULL, no charge/doc", async () => {
    process.env.ENABLE_PHASE2_BILLING_DOCS = "true";
    const db = getDb();
    const { expectedUpdatedAt } = await seedZeroPaxPartitionedEntry();

    const r = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.results[0].outcome).toBe("pax_blocked");

    const entry = await db.unitBillsGridEntry.findUniqueOrThrow({ where: { organizationId_apartmentId_periodMonth: { organizationId: ORG, apartmentId: APT, periodMonth: PERIOD } } });
    expect(entry.billedAt).toBeNull();
    expect(entry.invoicedAt).toBeNull();
    expect(await db.charge.count({ where: { organizationId: ORG } })).toBe(0);
    expect(await db.billingDocument.count({ where: { organizationId: ORG } })).toBe(0);
  });

  it("whole-not-blocked: a WHOLE unit at 0 stored pax issues (not pax_blocked)", async () => {
    process.env.ENABLE_PHASE2_BILLING_DOCS = "true";
    const db = getDb();
    const { expectedUpdatedAt } = await seedWholeUnitZeroPaxEntry();

    const r = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const res = r.data.results[0];
    expect(res.outcome).not.toBe("pax_blocked");
    expect(res.outcome).toBe("invoiced");

    const entry = await db.unitBillsGridEntry.findUniqueOrThrow({ where: { organizationId_apartmentId_periodMonth: { organizationId: ORG, apartmentId: APT, periodMonth: PERIOD } } });
    expect(entry.billedAt).not.toBeNull();
    expect(entry.invoicedAt).not.toBeNull();
  });
});
