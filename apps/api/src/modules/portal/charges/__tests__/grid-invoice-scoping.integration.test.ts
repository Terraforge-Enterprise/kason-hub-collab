/**
 * Task 12 (spec R6): grid-sourced invoices/charges are per-tenant scoped in the portal.
 *
 * The user's hard requirement — "for tenant side, they should only view the invoice that
 * IS RELATED to them SEPARATELY (if partitioned)." This CHARACTERIZES the EXISTING portal
 * charges read (`listCharges` / `getChargeDetail` in ../portal.charges.repository.ts), whose
 * `where` filters on `{ partyId: session.partyId, organizationId: session.orgId }`.
 *
 * Setup: a PARTITIONED apartment with 2 occupied rooms (2 tenants A/B, one owner). Bill it
 * FLAG-ON (ENABLE_PHASE2_BILLING_DOCS) so the Task-4 issuance path mints one grid-sourced
 * tenant `utility` charge PER OCCUPIED ROOM — room A's charge carries partyId=PARTY_A /
 * unitId=ROOM_A, room B's carries partyId=PARTY_B / unitId=ROOM_B — plus one owner charge
 * (partyId=OWNER_PARTY). Each tenant charge's chargeNumber is `GRIDUTIL-<ym>-<unitId>`, so
 * the room id is baked into the number and room-A vs room-B numbers differ.
 *
 * `listCharges` does NOT select partyId/unitId (see repository select), so this test asserts
 * scoping via the chargeNumber (room-specific) plus the ABSENCE of the sibling's number — and
 * cross-checks partyId/unitId at the DB layer to prove which chargeNumber belongs to whom.
 *
 * Behavior-inventory:
 *  • per-tenant-scope — PARTY_A's portal read returns EXACTLY room A's grid charge and NONE
 *    of room B's; symmetrically for PARTY_B. Each side sees its own, zero of the other's.
 *  • cross-tenant-detail-denied — getChargeDetail(PARTY_A, <B's chargeId>) returns null, so
 *    the detail path is scoped too (no cross-tenant document/charge leak by direct id).
 *
 * Characterization note: the behavior under test is ALREADY CORRECT, so there is no
 * meaningful RED against the current code. The test is load-bearing because it FAILS the
 * instant `partyId` is dropped from the `listCharges` where clause (demonstrated out-of-band;
 * see the report). Real local Postgres only.
 *
 * Run: from apps/api
 *   set -a; . ../../.env; set +a; RUN_INTEGRATION=1 npx vitest run \
 *     src/modules/portal/charges/__tests__/grid-invoice-scoping.integration.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { billService } from "../../../bills-grid/service";
import { getChargeDetail, listCharges } from "../portal.charges.repository";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`Refusing non-local DB host: ${host}`);
}

// Dedicated fixture ids — distinct namespace (b9900000) so cleanup is org-scoped + total,
// isolated from the bills-grid b8800000 fixtures.
const ORG = "b9900000-0000-4000-8000-000000000001";
const USER = "b9900000-0000-4000-8000-000000000002";
const PROP = "b9900000-0000-4000-8000-000000000003";
const APT = "b9900000-0000-4000-8000-000000000004";
const ROOM_A = "b9900000-0000-4000-8000-000000000005";
const ROOM_B = "b9900000-0000-4000-8000-000000000006";
const PARTY_A = "b9900000-0000-4000-8000-000000000007";
const PARTY_B = "b9900000-0000-4000-8000-000000000008";
const OWNER_PARTY = "b9900000-0000-4000-8000-000000000009";
const TEN_A = "b9900000-0000-4000-8000-00000000000a";
const TEN_B = "b9900000-0000-4000-8000-00000000000b";

const PERIOD_STR = "2026-06-01";
const PERIOD = new Date(`${PERIOD_STR}T00:00:00.000Z`);
const session = { orgId: ORG, userId: USER, role: "manager" };

async function cleanup() {
  const db = getDb();
  await db.paymentAllocationReversal.deleteMany({ where: { organizationId: ORG } });
  await db.paymentAllocation.deleteMany({ where: { organizationId: ORG } });
  await db.payment.deleteMany({ where: { organizationId: ORG } });
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

/** A PARTITIONED apartment: 2 occupied rooms (each own tenancy/party, pax 1) + owner.
 * Absorbed-TNB (owner-borne > 0) with tenant-borne wifi so a first Bill issues 2 IVTEN
 * + 1 IVOWN → one grid tenant charge per party + one owner charge. Returns the entry's
 * concurrency token. Mirrors grid-read-paid's seedPartitionedEntry. */
async function seedPartitionedEntry(): Promise<{ expectedUpdatedAt: string }> {
  const db = getDb();
  await db.organization.create({ data: { id: ORG, name: "BG9", slug: "bg9", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" } });
  await db.user.create({ data: { id: USER, organizationId: ORG, email: "bg9@example.test", fullName: "BG9 Operator", status: "active", role: "manager", userType: "operator" } });
  await db.property.create({ data: { id: PROP, organizationId: ORG, name: "P", propertyCode: "P-B9", propertyType: "residential", addressLine1: "1", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
  await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "A-B9", listingMode: "PARTITIONED" } });
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
      tnbTotalRaw: "300.00", airSelangorRaw: "40.00", wifi: "120.00", cleaning: "0.00",
      tnbPattern: "absorbed", airPattern: "recharged",
      cleaningBearer: "owner", wifiBearer: "tenant", maintenanceFeeBearer: "owner",
    },
  });
  await db.gridMeterReading.create({ data: { organizationId: ORG, entryId: entry.id, apartmentId: APT, periodMonth: PERIOD, listingId: ROOM_A, tenancyId: TEN_A, partyId: PARTY_A, amount: "0.00", createdBy: USER } });
  await db.gridMeterReading.create({ data: { organizationId: ORG, entryId: entry.id, apartmentId: APT, periodMonth: PERIOD, listingId: ROOM_B, tenancyId: TEN_B, partyId: PARTY_B, amount: "0.00", createdBy: USER } });
  return { expectedUpdatedAt: entry.updatedAt.toISOString() };
}

/** After billing, read back the grid-sourced (sourceGridEntryId set) tenant charges keyed
 * by partyId. Proves at the DB layer which chargeNumber belongs to which tenant, so the
 * portal-read assertions (which only see chargeNumber) rest on a verified mapping. */
async function gridChargesByParty() {
  const db = getDb();
  const charges = await db.charge.findMany({
    where: { organizationId: ORG, sourceGridEntryId: { not: null }, chargeType: "utility" },
    select: { id: true, chargeNumber: true, partyId: true, unitId: true },
  });
  const byParty = new Map(charges.map((c) => [c.partyId, c]));
  return { charges, byParty };
}

dn("portal charges: grid-sourced invoices are per-tenant scoped (Task 12, R6)", () => {
  beforeEach(async () => {
    await cleanup();
  });
  afterEach(async () => {
    delete process.env.ENABLE_PHASE2_BILLING_DOCS;
    await cleanup();
  });

  it("per-tenant-scope: each tenant's portal read returns ONLY their own grid charge, never the sibling's", async () => {
    process.env.ENABLE_PHASE2_BILLING_DOCS = "true";
    const { expectedUpdatedAt } = await seedPartitionedEntry();

    const bill = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt }] });
    expect(bill.ok).toBe(true);
    if (!bill.ok) return;
    expect(bill.data.results[0].outcome).toBe("invoiced");

    // DB truth: one grid tenant charge per party, mapped to the right room.
    const { byParty } = await gridChargesByParty();
    const chargeA = byParty.get(PARTY_A);
    const chargeB = byParty.get(PARTY_B);
    expect(chargeA).toBeTruthy();
    expect(chargeB).toBeTruthy();
    if (!chargeA || !chargeB) return;
    expect(chargeA.unitId).toBe(ROOM_A);
    expect(chargeB.unitId).toBe(ROOM_B);
    // Room id is baked into the chargeNumber, so the two numbers must differ.
    expect(chargeA.chargeNumber).not.toBe(chargeB.chargeNumber);
    expect(chargeA.chargeNumber).toContain("GRIDUTIL-");
    expect(chargeB.chargeNumber).toContain("GRIDUTIL-");

    // Tenant A's portal read: sees A's grid charge, and ZERO of B's.
    const readA = await listCharges({ partyId: PARTY_A, orgId: ORG }, 1, 50);
    const numbersA = readA.data.map((c) => c.chargeNumber);
    expect(numbersA).toContain(chargeA.chargeNumber);
    expect(numbersA).not.toContain(chargeB.chargeNumber);
    // Exactly one grid-sourced charge, and it is A's.
    const gridA = readA.data.filter((c) => c.chargeNumber.startsWith("GRIDUTIL-"));
    expect(gridA.map((c) => c.chargeNumber)).toEqual([chargeA.chargeNumber]);
    // No grid charge visible to A carries B's charge id.
    expect(readA.data.map((c) => c.id)).not.toContain(chargeB.id);

    // Tenant B's portal read: symmetric — sees B's grid charge, ZERO of A's.
    const readB = await listCharges({ partyId: PARTY_B, orgId: ORG }, 1, 50);
    const numbersB = readB.data.map((c) => c.chargeNumber);
    expect(numbersB).toContain(chargeB.chargeNumber);
    expect(numbersB).not.toContain(chargeA.chargeNumber);
    const gridB = readB.data.filter((c) => c.chargeNumber.startsWith("GRIDUTIL-"));
    expect(gridB.map((c) => c.chargeNumber)).toEqual([chargeB.chargeNumber]);
    expect(readB.data.map((c) => c.id)).not.toContain(chargeA.id);
  });

  it("cross-tenant-detail-denied: getChargeDetail cannot fetch the sibling tenant's grid charge", async () => {
    process.env.ENABLE_PHASE2_BILLING_DOCS = "true";
    const { expectedUpdatedAt } = await seedPartitionedEntry();

    const bill = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt }] });
    expect(bill.ok).toBe(true);
    if (!bill.ok) return;

    const { byParty } = await gridChargesByParty();
    const chargeA = byParty.get(PARTY_A);
    const chargeB = byParty.get(PARTY_B);
    expect(chargeA).toBeTruthy();
    expect(chargeB).toBeTruthy();
    if (!chargeA || !chargeB) return;

    // A fetching A's own charge → found (control: the happy path works).
    const ownDetail = await getChargeDetail({ partyId: PARTY_A, orgId: ORG }, chargeA.id);
    expect(ownDetail).not.toBeNull();
    expect(ownDetail?.chargeNumber).toBe(chargeA.chargeNumber);

    // A fetching B's charge by direct id → denied (partyId scoping on the detail path).
    const crossDetail = await getChargeDetail({ partyId: PARTY_A, orgId: ORG }, chargeB.id);
    expect(crossDetail).toBeNull();

    // Symmetric: B fetching A's charge → denied.
    const crossDetailB = await getChargeDetail({ partyId: PARTY_B, orgId: ORG }, chargeA.id);
    expect(crossDetailB).toBeNull();
  });
});
