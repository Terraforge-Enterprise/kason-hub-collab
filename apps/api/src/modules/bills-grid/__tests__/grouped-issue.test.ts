/**
 * Task 6 (bills-grid grid-scoped grouped invoice issuance): `issueGroupedGridInvoiceTx`
 * groups the charges `mintItemizedCharges` (Task 5) mints — one Charge per non-zero
 * utility component — into ONE itemized BillingDocument PER COUNTERPARTY, replacing
 * the interim per-charge `issueDocumentsForChargesTx` issuance (one document per
 * charge). Grouping key: (partyId, unitId, billingMonth, docType-from-category).
 *
 * MONEY-CRITICAL. Tests call `issueGroupedGridInvoiceTx` directly against
 * hand-created Charge fixtures (real ChargeCategory rows via
 * `ensureChargeCategorySeeds`, mirroring itemized-mint.test.ts's directness) —
 * not the full `billService` — so grouping/idempotency/counterparty-isolation
 * are exercised in isolation from Task 5's allocation math.
 *
 * Real local Postgres only (mirrors itemized-mint.test.ts's RUN_INTEGRATION +
 * host-guard convention).
 *
 * Run:
 *   set -a; source ./.env; set +a; RUN_INTEGRATION=1 npx vitest run \
 *     apps/api/src/modules/bills-grid/__tests__/grouped-issue.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { issueGroupedGridInvoiceTx } from "../issue-grouped";
import { ensureChargeCategorySeeds } from "../../charge-categories/seed";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`Refusing non-local DB host: ${host}`);
}

const ORG = "b7900000-0000-4000-8000-000000000001";
const USER = "b7900000-0000-4000-8000-000000000002";
const PROP = "b7900000-0000-4000-8000-000000000003";
const APT = "b7900000-0000-4000-8000-000000000004";
const ROOM_A = "b7900000-0000-4000-8000-000000000005";
const ROOM_B = "b7900000-0000-4000-8000-000000000006";
const PARTY_A = "b7900000-0000-4000-8000-000000000007";
const PARTY_B = "b7900000-0000-4000-8000-000000000008";
const OWNER_PARTY = "b7900000-0000-4000-8000-000000000009";
const TEN_A = "b7900000-0000-4000-8000-00000000000a";
const TEN_B = "b7900000-0000-4000-8000-00000000000b";

const PERIOD = new Date("2026-06-01T00:00:00.000Z");
const session = { orgId: ORG, userId: USER, role: "manager" };

async function cleanup() {
  const db = getDb();
  await db.billingDocumentLine.deleteMany({ where: { document: { organizationId: ORG } } });
  await db.billingDocument.deleteMany({ where: { organizationId: ORG } });
  await db.chargeEvent.deleteMany({ where: { organizationId: ORG } });
  await db.charge.deleteMany({ where: { organizationId: ORG } });
  await db.tenancy.deleteMany({ where: { organizationId: ORG } });
  await db.listing.deleteMany({ where: { organizationId: ORG } });
  await db.apartment.deleteMany({ where: { organizationId: ORG } });
  await db.property.deleteMany({ where: { organizationId: ORG } });
  await db.chargeCategory.deleteMany({ where: { organizationId: ORG } });
  await db.documentSeries.deleteMany({ where: { organizationId: ORG } });
  await db.referenceSequence.deleteMany({ where: { organizationId: ORG } });
  await db.auditLog.deleteMany({ where: { organizationId: ORG } });
  await db.party.deleteMany({ where: { organizationId: ORG } });
  await db.user.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

/** A PARTITIONED apartment, 2 occupied rooms (own tenancy/party each), owner-assigned
 * to ROOM_A (so the owner's designated listingId deliberately COLLIDES with a
 * tenant room's unitId — B3b's same-unit-different-party isolation proof). */
async function seedOrgAndApartment() {
  const db = getDb();
  await db.organization.create({ data: { id: ORG, name: "BG9", slug: "bg9", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" } });
  await db.user.create({ data: { id: USER, organizationId: ORG, email: "bg9@example.test", fullName: "BG9 Operator", status: "active", role: "manager", userType: "operator" } });
  await db.property.create({ data: { id: PROP, organizationId: ORG, name: "P", propertyCode: "P-BG9", propertyType: "residential", addressLine1: "1", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
  await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "A-BG9", listingMode: "PARTITIONED" } });
  await db.party.create({ data: { id: PARTY_A, organizationId: ORG, displayName: "Tenant A", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: PARTY_B, organizationId: ORG, displayName: "Tenant B", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: OWNER_PARTY, organizationId: ORG, displayName: "Owner", partyType: "individual", status: "active" } });
  await db.listing.create({ data: { id: ROOM_A, organizationId: ORG, apartmentId: APT, listingType: "master_room", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER_PARTY } });
  await db.listing.create({ data: { id: ROOM_B, organizationId: ORG, apartmentId: APT, listingType: "middle_room", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER_PARTY } });
  await db.tenancy.create({ data: { id: TEN_A, organizationId: ORG, propertyId: PROP, unitId: ROOM_A, tenantPartyId: PARTY_A, tenancyCode: "T-A", status: "active", billingStatus: "current", startDate: new Date("2026-01-01"), monthlyRentAmount: "1000.00", numberOfPax: 1 } });
  await db.tenancy.create({ data: { id: TEN_B, organizationId: ORG, propertyId: PROP, unitId: ROOM_B, tenantPartyId: PARTY_B, tenancyCode: "T-B", status: "active", billingStatus: "current", startDate: new Date("2026-01-01"), monthlyRentAmount: "1000.00", numberOfPax: 1 } });

  await ensureChargeCategorySeeds(ORG);
  const cats = await db.chargeCategory.findMany({
    where: {
      organizationId: ORG,
      code: {
        in: [
          "electricity_tenant", "water_tenant", "sewerage_tenant", "wifi_tenant", "cleaning_tenant", "subsidy_tenant",
          "electricity_owner", "water_owner", "sewerage_owner", "wifi_owner", "cleaning_owner",
        ],
      },
    },
    select: { id: true, code: true },
  });
  return Object.fromEntries(cats.map((c) => [c.code, c.id])) as Record<string, string>;
}

let chargeSeq = 0;
/** Hand-created Charge fixture — mirrors mintItemizedCharges' field shape exactly
 * (chargeType "utility", status "posted", outstandingAmount === amount) so the
 * grouped issuer sees realistic input regardless of the allocation math that
 * would normally produce it. */
async function makeCharge(opts: {
  partyId: string;
  unitId: string | null;
  tenancyId?: string | null;
  categoryId: string;
  amount: string;
  description: string;
  billingMonth?: Date;
}) {
  const db = getDb();
  chargeSeq += 1;
  return db.charge.create({
    data: {
      organizationId: ORG,
      chargeNumber: `GRPTEST-${chargeSeq}`,
      tenancyId: opts.tenancyId ?? null,
      unitId: opts.unitId,
      partyId: opts.partyId,
      categoryId: opts.categoryId,
      chargeType: "utility",
      status: "posted",
      postedAt: new Date(),
      description: opts.description,
      dueDate: opts.billingMonth ?? PERIOD,
      amount: opts.amount,
      currency: "MYR",
      outstandingAmount: opts.amount,
      billingMonth: opts.billingMonth ?? PERIOD,
      attachmentKeys: [],
    },
    select: { id: true },
  });
}

dn("issueGroupedGridInvoiceTx (Task 6)", () => {
  beforeEach(async () => {
    await cleanup();
  });
  afterEach(async () => {
    await cleanup();
  });

  it("groups 4 same-room tenant component charges into ONE IVTEN document with 4 lines", async () => {
    const db = getDb();
    const cats = await seedOrgAndApartment();
    const c1 = await makeCharge({ partyId: PARTY_A, unitId: ROOM_A, tenancyId: TEN_A, categoryId: cats.electricity_tenant, amount: "100.00", description: "Electricity (TNB) 202606" });
    const c2 = await makeCharge({ partyId: PARTY_A, unitId: ROOM_A, tenancyId: TEN_A, categoryId: cats.water_tenant, amount: "50.00", description: "Water (Air Selangor) 202606" });
    const c3 = await makeCharge({ partyId: PARTY_A, unitId: ROOM_A, tenancyId: TEN_A, categoryId: cats.wifi_tenant, amount: "40.00", description: "WiFi 202606" });
    const c4 = await makeCharge({ partyId: PARTY_A, unitId: ROOM_A, tenancyId: TEN_A, categoryId: cats.cleaning_tenant, amount: "30.00", description: "Cleaning 202606" });

    const result = await db.$transaction((tx) =>
      issueGroupedGridInvoiceTx(tx, [c1.id, c2.id, c3.id, c4.id], USER),
    );

    expect(result.tenantInvoiceIds).toHaveLength(1);
    expect(result.ownerInvoiceIds).toEqual([]);

    const doc = await db.billingDocument.findUniqueOrThrow({ where: { id: result.tenantInvoiceIds[0] } });
    expect(doc.counterpartyType).toBe("tenant");
    expect(doc.documentNumber.startsWith("IVTEN-")).toBe(true);
    expect(doc.tenancyId).toBe(TEN_A);
    expect(doc.partyId).toBe(PARTY_A);
    expect(Number(doc.subtotal.toString())).toBe(220);
    expect(Number(doc.total.toString())).toBe(220);

    const lines = await db.billingDocumentLine.findMany({ where: { documentId: doc.id } });
    expect(lines).toHaveLength(4);
    expect(new Set(lines.map((l) => l.chargeId))).toEqual(new Set([c1.id, c2.id, c3.id, c4.id]));
  });

  it("issues TWO documents (IVTEN + IVOWN) when a tenant room and an owner charge are issued together, each itemized to its own counterparty", async () => {
    const db = getDb();
    const cats = await seedOrgAndApartment();
    const tenantElectricity = await makeCharge({ partyId: PARTY_A, unitId: ROOM_A, tenancyId: TEN_A, categoryId: cats.wifi_tenant, amount: "40.00", description: "WiFi 202606" });
    const tenantWater = await makeCharge({ partyId: PARTY_A, unitId: ROOM_A, tenancyId: TEN_A, categoryId: cats.water_tenant, amount: "20.00", description: "Water 202606" });
    // Owner side: ROOM_A is the apartment's owner-assigned listing (owner.listingId),
    // so this owner charge deliberately shares unitId=ROOM_A with the tenant charges
    // above — partyId is the ONLY thing distinguishing them.
    const ownerElectricity = await makeCharge({ partyId: OWNER_PARTY, unitId: ROOM_A, tenancyId: null, categoryId: cats.electricity_owner, amount: "300.00", description: "Electricity (owner) 202606" });

    const result = await db.$transaction((tx) =>
      issueGroupedGridInvoiceTx(tx, [tenantElectricity.id, tenantWater.id, ownerElectricity.id], USER),
    );

    expect(result.tenantInvoiceIds).toHaveLength(1);
    expect(result.ownerInvoiceIds).toHaveLength(1);
    expect(result.ownerInvoiceIds[0]).not.toBe(result.tenantInvoiceIds[0]);

    const tenantDoc = await db.billingDocument.findUniqueOrThrow({ where: { id: result.tenantInvoiceIds[0] } });
    const ownerDoc = await db.billingDocument.findUniqueOrThrow({ where: { id: result.ownerInvoiceIds![0] } });
    expect(tenantDoc.counterpartyType).toBe("tenant");
    expect(tenantDoc.partyId).toBe(PARTY_A);
    expect(Number(tenantDoc.subtotal.toString())).toBe(60);
    expect(ownerDoc.counterpartyType).toBe("owner");
    expect(ownerDoc.partyId).toBe(OWNER_PARTY);
    expect(ownerDoc.documentNumber.startsWith("IVOWN-")).toBe(true);
    expect(Number(ownerDoc.subtotal.toString())).toBe(300);

    const tenantLines = await db.billingDocumentLine.findMany({ where: { documentId: tenantDoc.id } });
    const ownerLines = await db.billingDocumentLine.findMany({ where: { documentId: ownerDoc.id } });
    expect(tenantLines).toHaveLength(2);
    expect(ownerLines).toHaveLength(1);
  });

  // MONEY-CRITICAL — the owner-occupier seam (money-routing review finding). Tenant
  // AND owner utility categories are BOTH docType:"invoice" (see electricity_tenant /
  // electricity_owner in packages/shared/src/constants/seed-categories.ts), so before
  // the counterparty-family grouping-key fix, partyId was the ONLY thing separating a
  // tenant group from an owner group. If the SAME party is charged BOTH a tenant-family
  // and an owner-family utility component for the SAME unit/month (an owner-occupier —
  // not a current KAEN scenario, but not prevented by any code guard), the OLD grouping
  // key (partyId:unitId:month:docType) collides and silently merges the owner-borne
  // charge onto the tenant's IVTEN — no IVOWN is issued, ownerInvoiceIds stays empty. This
  // proves the fix: TWO documents, one IVTEN (tenant family) + one IVOWN (owner family),
  // each correctly attributed to its own counterparty — never one merged invoice.
  it("issues TWO documents (not one merged invoice) when a tenant charge and an owner charge share the SAME partyId + unitId + billingMonth + docType (owner-occupier collision)", async () => {
    const db = getDb();
    const cats = await seedOrgAndApartment();
    // SAME partyId (PARTY_A) and SAME unitId (ROOM_A) for both charges — simulates an
    // owner-occupier. electricity_tenant's family is "tenant_income" (!== "owner_income");
    // electricity_owner's family IS "owner_income" — but both categories are
    // docType:"invoice", so partyId+unitId+month+docType are IDENTICAL between the two
    // charges below, exactly the collision the old grouping key could not separate.
    const tenantElectricity = await makeCharge({ partyId: PARTY_A, unitId: ROOM_A, tenancyId: TEN_A, categoryId: cats.electricity_tenant, amount: "100.00", description: "Electricity (tenant) 202606" });
    const ownerElectricity = await makeCharge({ partyId: PARTY_A, unitId: ROOM_A, tenancyId: null, categoryId: cats.electricity_owner, amount: "300.00", description: "Electricity (owner) 202606" });

    const result = await db.$transaction((tx) =>
      issueGroupedGridInvoiceTx(tx, [tenantElectricity.id, ownerElectricity.id], USER),
    );

    expect(result.tenantInvoiceIds).toHaveLength(1);
    expect(result.ownerInvoiceIds).toHaveLength(1);
    // Never the SAME document id — a merged/aliased document is exactly the bug.
    expect(result.ownerInvoiceIds[0]).not.toBe(result.tenantInvoiceIds[0]);
    expect(await db.billingDocument.count({ where: { organizationId: ORG } })).toBe(2);

    const tenantDoc = await db.billingDocument.findUniqueOrThrow({ where: { id: result.tenantInvoiceIds[0] } });
    const ownerDoc = await db.billingDocument.findUniqueOrThrow({ where: { id: result.ownerInvoiceIds![0] } });
    expect(tenantDoc.counterpartyType).toBe("tenant");
    expect(tenantDoc.partyId).toBe(PARTY_A);
    expect(tenantDoc.documentNumber.startsWith("IVTEN-")).toBe(true);
    expect(Number(tenantDoc.subtotal.toString())).toBe(100);
    expect(ownerDoc.counterpartyType).toBe("owner");
    expect(ownerDoc.partyId).toBe(PARTY_A);
    expect(ownerDoc.documentNumber.startsWith("IVOWN-")).toBe(true);
    expect(Number(ownerDoc.subtotal.toString())).toBe(300);

    const tenantLines = await db.billingDocumentLine.findMany({ where: { documentId: tenantDoc.id } });
    const ownerLines = await db.billingDocumentLine.findMany({ where: { documentId: ownerDoc.id } });
    expect(tenantLines).toHaveLength(1);
    expect(ownerLines).toHaveLength(1);
  });

  it("never merges two different tenants' charges into one invoice (counterparty isolation across rooms)", async () => {
    const db = getDb();
    const cats = await seedOrgAndApartment();
    const roomAElectricity = await makeCharge({ partyId: PARTY_A, unitId: ROOM_A, tenancyId: TEN_A, categoryId: cats.electricity_tenant, amount: "100.00", description: "Electricity 202606" });
    const roomAWater = await makeCharge({ partyId: PARTY_A, unitId: ROOM_A, tenancyId: TEN_A, categoryId: cats.water_tenant, amount: "20.00", description: "Water 202606" });
    const roomBWifi = await makeCharge({ partyId: PARTY_B, unitId: ROOM_B, tenancyId: TEN_B, categoryId: cats.wifi_tenant, amount: "40.00", description: "WiFi 202606" });

    const result = await db.$transaction((tx) =>
      issueGroupedGridInvoiceTx(tx, [roomAElectricity.id, roomAWater.id, roomBWifi.id], USER),
    );

    // TWO separate tenant documents — never one merged invoice for both tenants.
    expect(result.tenantInvoiceIds).toHaveLength(2);
    expect(result.ownerInvoiceIds).toEqual([]);

    const docs = await db.billingDocument.findMany({ where: { id: { in: result.tenantInvoiceIds } } });
    const roomADoc = docs.find((d) => d.partyId === PARTY_A)!;
    const roomBDoc = docs.find((d) => d.partyId === PARTY_B)!;
    expect(roomADoc).toBeTruthy();
    expect(roomBDoc).toBeTruthy();
    expect(roomADoc.id).not.toBe(roomBDoc.id);
    expect(roomADoc.tenancyId).toBe(TEN_A);
    expect(roomBDoc.tenancyId).toBe(TEN_B);
    expect(Number(roomADoc.subtotal.toString())).toBe(120);
    expect(Number(roomBDoc.subtotal.toString())).toBe(40);

    const roomALines = await db.billingDocumentLine.findMany({ where: { documentId: roomADoc.id } });
    const roomBLines = await db.billingDocumentLine.findMany({ where: { documentId: roomBDoc.id } });
    expect(roomALines).toHaveLength(2);
    expect(roomBLines).toHaveLength(1);
    // No cross-contamination: Room B's charge never lands as a line on Room A's doc.
    expect(roomALines.map((l) => l.chargeId)).not.toContain(roomBWifi.id);
  });

  // Proves unitId is independently load-bearing in the grouping key, not merely
  // redundant with partyId: the SAME party occupying TWO rooms (an edge case —
  // e.g. a double-booking) must still get two separate room invoices, never one
  // invoice silently combining both rooms' charges under one partyId match.
  it("keeps two different ROOMS separate even when the SAME party occupies both (unitId is independently load-bearing, not redundant with partyId)", async () => {
    const db = getDb();
    const cats = await seedOrgAndApartment();
    const roomACharge = await makeCharge({ partyId: PARTY_A, unitId: ROOM_A, tenancyId: TEN_A, categoryId: cats.electricity_tenant, amount: "100.00", description: "Electricity 202606" });
    // Same party, DIFFERENT room (ROOM_B) — tenancyId omitted deliberately (not tied
    // to TEN_B, which belongs to PARTY_B) to isolate the unitId variable alone.
    const roomBCharge = await makeCharge({ partyId: PARTY_A, unitId: ROOM_B, tenancyId: null, categoryId: cats.wifi_tenant, amount: "40.00", description: "WiFi 202606" });

    const result = await db.$transaction((tx) =>
      issueGroupedGridInvoiceTx(tx, [roomACharge.id, roomBCharge.id], USER),
    );

    expect(result.tenantInvoiceIds).toHaveLength(2);
    const docs = await db.billingDocument.findMany({ where: { id: { in: result.tenantInvoiceIds } } });
    expect(docs.every((d) => d.partyId === PARTY_A)).toBe(true);
    const roomADoc = docs.find((d) => d.listingId === ROOM_A)!;
    const roomBDoc = docs.find((d) => d.listingId === ROOM_B)!;
    expect(roomADoc).toBeTruthy();
    expect(roomBDoc).toBeTruthy();
    expect(roomADoc.id).not.toBe(roomBDoc.id);
    const roomALines = await db.billingDocumentLine.findMany({ where: { documentId: roomADoc.id } });
    const roomBLines = await db.billingDocumentLine.findMany({ where: { documentId: roomBDoc.id } });
    expect(roomALines).toHaveLength(1);
    expect(roomBLines).toHaveLength(1);
  });

  // MONEY-CRITICAL — the Part-A/Part-B seam. A subsidy component is a genuinely
  // NEGATIVE Charge.amount (mintItemizedCharges: `-a.subsidyDeduction`). Before
  // the toCents negative-amount fix (Part A), issueDocumentTx's per-line
  // `toCents(l.amount, ...)` throws on this exact input and the whole issuance
  // rolls back. This proves the fix and the grouped issuer compose end-to-end:
  // a mixed-sign group (2 positive components + 1 negative subsidy) issues as
  // ONE document whose subtotal/total correctly NET the negative line.
  it("issues a mixed-sign group end-to-end: a negative subsidy line nets the document's subtotal/total correctly", async () => {
    const db = getDb();
    const cats = await seedOrgAndApartment();
    const electricity = await makeCharge({ partyId: PARTY_A, unitId: ROOM_A, tenancyId: TEN_A, categoryId: cats.electricity_tenant, amount: "380.00", description: "Electricity (TNB) 202606" });
    const water = await makeCharge({ partyId: PARTY_A, unitId: ROOM_A, tenancyId: TEN_A, categoryId: cats.water_tenant, amount: "70.00", description: "Water (Air Selangor) 202606" });
    const wifi = await makeCharge({ partyId: PARTY_A, unitId: ROOM_A, tenancyId: TEN_A, categoryId: cats.wifi_tenant, amount: "40.00", description: "WiFi 202606" });
    const cleaning = await makeCharge({ partyId: PARTY_A, unitId: ROOM_A, tenancyId: TEN_A, categoryId: cats.cleaning_tenant, amount: "30.00", description: "Cleaning 202606" });
    // The subsidy line — a genuinely negative Charge.amount, exactly mirroring
    // mintItemizedCharges' `amount: (-a.subsidyDeduction).toFixed(2)`.
    const subsidy = await makeCharge({ partyId: PARTY_A, unitId: ROOM_A, tenancyId: TEN_A, categoryId: cats.subsidy_tenant, amount: "-60.00", description: "Subsidy 202606" });

    const result = await db.$transaction((tx) =>
      issueGroupedGridInvoiceTx(tx, [electricity.id, water.id, wifi.id, cleaning.id, subsidy.id], USER),
    );

    expect(result.tenantInvoiceIds).toHaveLength(1);
    const doc = await db.billingDocument.findUniqueOrThrow({ where: { id: result.tenantInvoiceIds[0] } });
    // 380 + 70 + 40 + 30 - 60 = 460 (matches itemized-mint.test.ts's own worked example).
    // .toFixed(2), not .toString() — Prisma's Decimal.toString() strips trailing
    // zeros for whole-number values (e.g. renders "460", not "460.00"); the
    // codebase's established pattern for exact 2dp assertions is .toFixed(2)
    // (itemized-mint.test.ts's `subsidyCharge?.amount.toFixed(2)`).
    expect(doc.subtotal.toFixed(2)).toBe("460.00");
    expect(doc.sstAmount.toFixed(2)).toBe("0.00");
    expect(doc.total.toFixed(2)).toBe("460.00");

    const lines = await db.billingDocumentLine.findMany({ where: { documentId: doc.id } });
    expect(lines).toHaveLength(5);
    const subsidyLine = lines.find((l) => l.chargeId === subsidy.id)!;
    expect(subsidyLine.amount.toFixed(2)).toBe("-60.00");
  });

  it("returns a no-op {tenantInvoiceIds: [], ownerInvoiceIds: []} for an empty chargeIds array, creating no document", async () => {
    const db = getDb();
    await seedOrgAndApartment();

    const result = await db.$transaction((tx) => issueGroupedGridInvoiceTx(tx, [], USER));

    expect(result).toEqual({ tenantInvoiceIds: [], ownerInvoiceIds: [] });
    expect(await db.billingDocument.count({ where: { organizationId: ORG } })).toBe(0);
  });

  it("is idempotent: re-running on the SAME chargeIds + revision returns the SAME document, never a duplicate", async () => {
    const db = getDb();
    const cats = await seedOrgAndApartment();
    const c1 = await makeCharge({ partyId: PARTY_A, unitId: ROOM_A, tenancyId: TEN_A, categoryId: cats.electricity_tenant, amount: "100.00", description: "Electricity 202606" });
    const c2 = await makeCharge({ partyId: PARTY_A, unitId: ROOM_A, tenancyId: TEN_A, categoryId: cats.water_tenant, amount: "20.00", description: "Water 202606" });

    const first = await db.$transaction((tx) => issueGroupedGridInvoiceTx(tx, [c1.id, c2.id], USER));
    const second = await db.$transaction((tx) => issueGroupedGridInvoiceTx(tx, [c1.id, c2.id], USER));

    expect(second.tenantInvoiceIds).toEqual(first.tenantInvoiceIds);
    expect(await db.billingDocument.count({ where: { organizationId: ORG } })).toBe(1);
    expect(await db.billingDocumentLine.count({ where: { document: { organizationId: ORG } } })).toBe(2);
  });

  // The revision suffix is REQUIRED — issueDocumentTx dedupes on
  // {organizationId, idempotencyKey} with NO documentStatus filter (issue.service.ts
  // 82-87), so it returns ANY existing doc for that key, including a CANCELLED one.
  // Without the `:r${revision}` suffix, a Task-8 re-Bill (revision > 0) reusing the
  // SAME group key would find the prior attempt's now-CANCELLED document and mint
  // NOTHING fresh — this proves both halves: (a) a same-revision replay against a
  // CANCELLED doc IS swallowed (demonstrating the underlying issueDocumentTx
  // behavior this guards against), and (b) bumping the revision correctly mints a
  // genuinely NEW document instead.
  it("a revision>0 call uses a different idempotencyKey, so it is NOT swallowed by a cancelled revision-0 document for the same group", async () => {
    const db = getDb();
    const cats = await seedOrgAndApartment();
    const c1 = await makeCharge({ partyId: PARTY_A, unitId: ROOM_A, tenancyId: TEN_A, categoryId: cats.electricity_tenant, amount: "100.00", description: "Electricity 202606" });

    const revision0 = await db.$transaction((tx) => issueGroupedGridInvoiceTx(tx, [c1.id], USER, 0));
    const doc0Id = revision0.tenantInvoiceIds[0];
    await db.billingDocument.update({ where: { id: doc0Id }, data: { documentStatus: "CANCELLED" } });

    // (a) Demonstrate the underlying hazard: replaying revision 0 (SAME key) after
    // the doc was cancelled returns the STALE cancelled doc, not a fresh one —
    // issueDocumentTx's dedupe is status-blind. This is exactly why re-Bill needs
    // the revision bump, not a workaround this module implements itself.
    const replaySameRevision = await db.$transaction((tx) => issueGroupedGridInvoiceTx(tx, [c1.id], USER, 0));
    expect(replaySameRevision.tenantInvoiceIds[0]).toBe(doc0Id);
    const staleDoc = await db.billingDocument.findUniqueOrThrow({ where: { id: doc0Id } });
    expect(staleDoc.documentStatus).toBe("CANCELLED"); // confirms it's the SAME stale row, not a fresh ISSUED one

    // (b) A genuine re-Bill mints fresh charges (new ids, revision 1) and calls
    // with revision=1 — a DIFFERENT idempotencyKey, so a NEW document is minted
    // rather than resurrecting/reusing the cancelled one.
    const c1Rebill = await makeCharge({ partyId: PARTY_A, unitId: ROOM_A, tenancyId: TEN_A, categoryId: cats.electricity_tenant, amount: "110.00", description: "Electricity 202606 (re-bill)" });
    const revision1 = await db.$transaction((tx) => issueGroupedGridInvoiceTx(tx, [c1Rebill.id], USER, 1));
    const doc1Id = revision1.tenantInvoiceIds[0];
    expect(doc1Id).not.toBe(doc0Id);
    const doc1 = await db.billingDocument.findUniqueOrThrow({ where: { id: doc1Id } });
    expect(doc1.documentStatus).toBe("ISSUED");
    expect(doc1.idempotencyKey).not.toBe(staleDoc.idempotencyKey);
    expect(doc1.idempotencyKey?.endsWith(":r1")).toBe(true);
  });

  it("throws fail-closed when a charge has no resolvable category, issuing nothing partial", async () => {
    const db = getDb();
    await seedOrgAndApartment();
    // A charge whose categoryId points at nothing (simulates a deleted/never-set
    // category slipping through) — unreachable via mintItemizedCharges in practice,
    // but the issuer must never guess a category or silently drop the line.
    const orphan = await db.charge.create({
      data: {
        organizationId: ORG, chargeNumber: "GRPTEST-ORPHAN", unitId: ROOM_A, tenancyId: TEN_A,
        partyId: PARTY_A, categoryId: null, chargeType: "utility", status: "posted", postedAt: new Date(),
        description: "Orphan", dueDate: PERIOD, amount: "10.00", currency: "MYR",
        outstandingAmount: "10.00", billingMonth: PERIOD, attachmentKeys: [],
      },
      select: { id: true },
    });

    await expect(
      db.$transaction((tx) => issueGroupedGridInvoiceTx(tx, [orphan.id], USER)),
    ).rejects.toMatchObject({ code: "CATEGORY_UNRESOLVED" });
    expect(await db.billingDocument.count({ where: { organizationId: ORG } })).toBe(0);
  });

  // Defensive hardening: unreachable via billService in practice (mintItemizedCharges
  // always mints FRESH, unique-per-component charge ids, so tenantChargeIds/
  // ownerChargeIds can never contain a repeat), but a duplicate id in the input array
  // must never double-count that charge's amount as two lines on the same invoice.
  it("de-duplicates a repeated chargeId in the input array — never double-counts one charge as two lines", async () => {
    const db = getDb();
    const cats = await seedOrgAndApartment();
    const c1 = await makeCharge({ partyId: PARTY_A, unitId: ROOM_A, tenancyId: TEN_A, categoryId: cats.electricity_tenant, amount: "100.00", description: "Electricity 202606" });

    const result = await db.$transaction((tx) => issueGroupedGridInvoiceTx(tx, [c1.id, c1.id], USER));

    expect(result.tenantInvoiceIds).toHaveLength(1);
    const doc = await db.billingDocument.findUniqueOrThrow({ where: { id: result.tenantInvoiceIds[0] } });
    expect(Number(doc.subtotal.toString())).toBe(100); // NOT 200
    const lines = await db.billingDocumentLine.findMany({ where: { documentId: doc.id } });
    expect(lines).toHaveLength(1); // NOT 2
  });
});
