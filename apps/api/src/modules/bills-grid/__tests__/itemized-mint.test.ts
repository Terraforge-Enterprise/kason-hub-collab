/**
 * Task 5 (agency billing itemization, spec R5): `mintItemizedCharges` — one
 * Charge per non-zero utility component, replacing the single lump
 * "Shared utilities"/"Owner-borne utilities" mint.
 *
 * MONEY-CRITICAL. Tests call `mintItemizedCharges` directly (not the full
 * `billService`) — per the brief's scope boundary, this task's tests assert
 * the CHARGES (count, per-utility category, stamped economics, Σ-invariant,
 * RM0/tenant_direct skip), not the grouped-invoice shape (Task 6).
 *
 * Real local Postgres only (mirrors bill-issuance.integration.test.ts /
 * grid-utility-categories.test.ts's RUN_INTEGRATION + host-guard convention).
 *
 * Run:
 *   set -a; source ./.env; set +a; RUN_INTEGRATION=1 npx vitest run \
 *     apps/api/src/modules/bills-grid/__tests__/itemized-mint.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb, Prisma } from "@kason/db";
import { mintItemizedCharges } from "../service";
import { ensureChargeCategorySeeds } from "../../charge-categories/seed";
import { computeAllocation, type ComputeResult, type RoomInput } from "../../meter/compute";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`Refusing non-local DB host: ${host}`);
}

const ORG = "17e00000-0000-4000-8000-000000000001";
const USER = "17e00000-0000-4000-8000-000000000002";
const PROP = "17e00000-0000-4000-8000-000000000003";
const APT = "17e00000-0000-4000-8000-000000000004";
const ROOM_A = "17e00000-0000-4000-8000-000000000005";
const ROOM_B = "17e00000-0000-4000-8000-000000000006";
const PARTY_A = "17e00000-0000-4000-8000-000000000007";
const PARTY_B = "17e00000-0000-4000-8000-000000000008";
const OWNER_PARTY = "17e00000-0000-4000-8000-000000000009";
const TEN_A = "17e00000-0000-4000-8000-00000000000a";
const TEN_B = "17e00000-0000-4000-8000-00000000000b";

const PERIOD = new Date("2026-06-01T00:00:00.000Z");
const YM = "202606";
const session = { orgId: ORG, userId: USER, role: "manager" };

async function cleanup() {
  const db = getDb();
  await db.chargeEvent.deleteMany({ where: { organizationId: ORG } });
  await db.charge.deleteMany({ where: { organizationId: ORG } });
  await db.unitBillsGridEntry.deleteMany({ where: { organizationId: ORG } });
  await db.tenancy.deleteMany({ where: { organizationId: ORG } });
  await db.listing.deleteMany({ where: { organizationId: ORG } });
  await db.apartment.deleteMany({ where: { organizationId: ORG } });
  await db.property.deleteMany({ where: { organizationId: ORG } });
  await db.chargeCategory.deleteMany({ where: { organizationId: ORG } });
  await db.documentSeries.deleteMany({ where: { organizationId: ORG } });
  await db.party.deleteMany({ where: { organizationId: ORG } });
  await db.user.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

/** A PARTITIONED apartment, 2 occupied rooms (own tenancy/party each), owner-assigned. */
async function seedOrgAndApartment() {
  const db = getDb();
  await db.organization.create({ data: { id: ORG, name: "IM5", slug: "im5", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" } });
  await db.user.create({ data: { id: USER, organizationId: ORG, email: "im5@example.test", fullName: "IM5 Operator", status: "active", role: "manager", userType: "operator" } });
  await db.property.create({ data: { id: PROP, organizationId: ORG, name: "P", propertyCode: "P-IM5", propertyType: "residential", addressLine1: "1", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
  await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "A-IM5", listingMode: "PARTITIONED" } });
  await db.party.create({ data: { id: PARTY_A, organizationId: ORG, displayName: "Tenant A", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: PARTY_B, organizationId: ORG, displayName: "Tenant B", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: OWNER_PARTY, organizationId: ORG, displayName: "Owner", partyType: "individual", status: "active" } });
  await db.listing.create({ data: { id: ROOM_A, organizationId: ORG, apartmentId: APT, listingType: "master_room", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER_PARTY } });
  await db.listing.create({ data: { id: ROOM_B, organizationId: ORG, apartmentId: APT, listingType: "middle_room", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER_PARTY } });
  await db.tenancy.create({ data: { id: TEN_A, organizationId: ORG, propertyId: PROP, unitId: ROOM_A, tenantPartyId: PARTY_A, tenancyCode: "T-A", status: "active", billingStatus: "current", startDate: new Date("2026-01-01"), monthlyRentAmount: "1000.00", numberOfPax: 1 } });
  await db.tenancy.create({ data: { id: TEN_B, organizationId: ORG, propertyId: PROP, unitId: ROOM_B, tenantPartyId: PARTY_B, tenancyCode: "T-B", status: "active", billingStatus: "current", startDate: new Date("2026-01-01"), monthlyRentAmount: "1000.00", numberOfPax: 1 } });
}

/** A minimal UnitBillsGridEntry — mintItemizedCharges reads only its raw/pattern
 * columns (never its own ownerBorneTnb/ownerBorneAir — those may be stale/unset
 * at mint time in the real caller, so the mint independently re-derives them). */
async function seedEntry(overrides: Partial<Prisma.UnitBillsGridEntryUncheckedCreateInput> = {}) {
  const db = getDb();
  return db.unitBillsGridEntry.create({
    data: {
      organizationId: ORG, apartmentId: APT, periodMonth: PERIOD, createdBy: USER,
      tnbPattern: "recharged", airPattern: "recharged",
      cleaningBearer: "tenant", wifiBearer: "tenant", maintenanceFeeBearer: "owner",
      ...overrides,
    },
  });
}

/** Build a synthetic ComputeResult with the given allocations — hand-constructed
 * (not run through computeAllocation) so each test controls the exact shares. */
function alloc(allocations: ComputeResult["allocations"]): ComputeResult {
  return {
    allocations, totalAircond: 0, leftoverTnb: 0, sharedPool: 0, totalPax: allocations.length,
    subsidyCovered: 0, ownerAttributableAircond: 0, ownerBorneUtilities: 0, roundingResidual: 0,
    ownerBorneUtilitiesTotal: 0,
  };
}

const line = (over: Partial<ComputeResult["allocations"][number]>): ComputeResult["allocations"][number] => ({
  unitId: ROOM_A, tenancyId: TEN_A, partyId: PARTY_A, pax: 1,
  tnbShare: 0, airSelangorShare: 0, indahShare: 0, wifiShare: 0, cleaningShare: 0, maintenanceShare: 0,
  grossShareTotal: 0, subsidyDeduction: 0, computedAmount: 0, unitCode: null, listingType: null,
  ...over,
});

dn("mintItemizedCharges (Task 5)", () => {
  beforeEach(async () => {
    await cleanup();
    await seedOrgAndApartment();
  });
  afterEach(async () => {
    await cleanup();
  });

  it("mints one charge per non-zero tenant component, omits RM0 sewerage", async () => {
    const db = getDb();
    const entry = await seedEntry();
    const a = alloc([
      line({ tnbShare: 380, airSelangorShare: 70, indahShare: 0, wifiShare: 40, cleaningShare: 30, grossShareTotal: 520, computedAmount: 520 }),
    ]);

    const result = await db.$transaction((tx) => mintItemizedCharges(tx, session, entry, a, 0, YM, 0, []));

    expect(result.tenantChargeIds).toHaveLength(4);
    expect(result.ownerChargeIds).toHaveLength(0);

    const charges = await db.charge.findMany({ where: { organizationId: ORG }, orderBy: { chargeNumber: "asc" } });
    expect(charges).toHaveLength(4);
    const sum = charges.reduce((s, c) => s + Number(c.amount.toString()), 0);
    expect(Math.round(sum * 100) / 100).toBe(520);
    expect(charges.some((c) => c.chargeNumber.includes("SEWERAGE"))).toBe(false);
  });

  // REGRESSION (2026-07-28): making maintenance billable folded maintenanceShare into
  // computeAllocation's grossShareTotal -> computedAmount, but the mint's tenant candidate
  // list still had no maintenance entry. componentSum came up short by exactly the
  // maintenance share, the Σ-invariant threw SUM_INVARIANT, and the whole row failed as
  // save_failed ("couldn't issue the invoice") on the first re-Bill after that change.
  it("mints a tenant-borne maintenance component; Σ still equals computedAmount", async () => {
    const db = getDb();
    const entry = await seedEntry();
    const a = alloc([
      line({ tnbShare: 300, airSelangorShare: 50, indahShare: 0, wifiShare: 40, cleaningShare: 30, maintenanceShare: 80, grossShareTotal: 500, computedAmount: 500 }),
    ]);

    // Before the fix this threw IssuanceError("SUM_INVARIANT") and wrote nothing.
    const result = await db.$transaction((tx) => mintItemizedCharges(tx, session, entry, a, 0, YM, 0, []));

    expect(result.tenantChargeIds).toHaveLength(5);
    const charges = await db.charge.findMany({ where: { organizationId: ORG } });
    const sum = charges.reduce((s, c) => s + Number(c.amount.toString()), 0);
    expect(Math.round(sum * 100) / 100).toBe(500);
    expect(charges.some((c) => c.chargeNumber.includes("MAINTENANCE"))).toBe(true);
  });

  it("mints a negative subsidy charge; sum still equals computedAmount", async () => {
    const db = getDb();
    const entry = await seedEntry();
    // Same gross as above (520) but a 60 subsidy knocks computedAmount to 460.
    const a = alloc([
      line({ tnbShare: 380, airSelangorShare: 70, indahShare: 0, wifiShare: 40, cleaningShare: 30, grossShareTotal: 520, subsidyDeduction: 60, computedAmount: 460 }),
    ]);

    const result = await db.$transaction((tx) => mintItemizedCharges(tx, session, entry, a, 0, YM, 0, []));

    expect(result.tenantChargeIds).toHaveLength(5); // 4 utility + 1 subsidy
    const charges = await db.charge.findMany({ where: { organizationId: ORG } });
    const subsidyCharge = charges.find((c) => c.chargeNumber.includes("SUBSIDY"));
    expect(subsidyCharge?.amount.toFixed(2)).toBe("-60.00");
    const sum = charges.reduce((s, c) => s + Number(c.amount.toString()), 0);
    expect(Math.round(sum * 100) / 100).toBe(460);
  });

  it("throws SUM_INVARIANT when tenant components do not sum to computedAmount, minting nothing", async () => {
    const db = getDb();
    const entry = await seedEntry();
    // Shares sum to 520 but computedAmount claims 521 (forced 1.00 drift) — a
    // money guard against exactly the class of rounding-drift bug the acceptance
    // table describes.
    const a = alloc([
      line({ tnbShare: 380, airSelangorShare: 70, indahShare: 0, wifiShare: 40, cleaningShare: 30, grossShareTotal: 521, computedAmount: 521 }),
    ]);

    await expect(db.$transaction((tx) => mintItemizedCharges(tx, session, entry, a, 0, YM, 0, []))).rejects.toMatchObject({ code: "SUM_INVARIANT" });

    // Nothing persisted — the whole tx rolled back.
    expect(await db.charge.count({ where: { organizationId: ORG } })).toBe(0);
  });

  it("mints one charge per non-zero owner component (electricity absorbed + owner cleaning)", async () => {
    const db = getDb();
    const entry = await seedEntry({
      tnbPattern: "absorbed", tnbTotalRaw: "300.00",
      airPattern: "recharged", // no owner water component
      cleaningBearer: "owner", cleaning: "30.00",
      wifiBearer: "tenant", // no owner wifi component
    });
    // No occupied rooms needed for this owner-only assertion.
    const a = alloc([]);

    const result = await db.$transaction((tx) => mintItemizedCharges(tx, session, entry, a, 330, YM, 0, []));

    expect(result.tenantChargeIds).toHaveLength(0);
    expect(result.ownerChargeIds).toHaveLength(2);

    const charges = await db.charge.findMany({ where: { organizationId: ORG }, orderBy: { chargeNumber: "asc" } });
    expect(charges).toHaveLength(2);
    expect(charges.every((c) => c.chargeNumber.startsWith(`GRIDOWN-${YM}-${APT}-`))).toBe(true);
    expect(charges.every((c) => c.partyId === OWNER_PARTY)).toBe(true);
    const sum = charges.reduce((s, c) => s + Number(c.amount.toString()), 0);
    expect(Math.round(sum * 100) / 100).toBe(330);
    // chargeNumber = GRIDOWN-${ym}-${apartmentId}-${CODE} — apartmentId is a UUID
    // (itself dash-separated), so extract the CODE by prefix-stripping, not split("-").
    const prefix = `GRIDOWN-${YM}-${APT}-`;
    const codes = charges.map((c) => c.chargeNumber.slice(prefix.length)).sort();
    expect(codes).toEqual(["CLEANING", "ELECTRICITY"]);
  });

  // REGRESSION (2026-07-28, reported as A-01 "couldn't issue the invoice"): 69fc262f added
  // `maintenance` to the Utility union and to every money path, but classify-utility.ts kept
  // its bucket membership in Utility[] ARRAY LITERALS (PASSTHROUGH/SERVICE), which TypeScript
  // does not check for exhaustiveness. maintenance was in neither, so it fell through to
  // ClassificationError("UNKNOWN_UTILITY") — thrown INSIDE the Bill tx, rolling the whole row
  // back (taking the tenant invoice with it) and surfacing as an uncoded `save_failed`.
  //
  // The sibling tenant-loop case is covered above; this pins the OWNER loop, which is the
  // path the reported failure actually took (service.ts ownerCandidates, not the tenant one).
  it("mints an owner-borne maintenance component (never a ClassificationError)", async () => {
    const db = getDb();
    const entry = await seedEntry({ maintenanceFeeBearer: "owner", maintenanceFee: "300.00" });
    const a = alloc([]);

    const result = await db.$transaction((tx) => mintItemizedCharges(tx, session, entry, a, 300, YM, 0, []));

    expect(result.tenantChargeIds).toHaveLength(0);
    expect(result.ownerChargeIds).toHaveLength(1);

    const charges = await db.charge.findMany({ where: { organizationId: ORG } });
    expect(charges).toHaveLength(1);
    expect(charges[0].chargeNumber).toBe(`GRIDOWN-${YM}-${APT}-MAINTENANCE`);
    expect(charges[0].partyId).toBe(OWNER_PARTY);
    expect(Number(charges[0].amount.toString())).toBe(300);
  });

  it("throws SUM_INVARIANT when owner components do not sum to ownerBorne, minting nothing", async () => {
    const db = getDb();
    const entry = await seedEntry({ tnbPattern: "absorbed", tnbTotalRaw: "300.00" });
    const a = alloc([]);

    // Re-derived owner components sum to 300 (electricity only), but the caller
    // claims ownerBorne=330 — a genuine caller/mint drift the invariant must catch.
    await expect(db.$transaction((tx) => mintItemizedCharges(tx, session, entry, a, 330, YM, 0, []))).rejects.toMatchObject({ code: "SUM_INVARIANT" });

    expect(await db.charge.count({ where: { organizationId: ORG } })).toBe(0);
  });

  // Adversarial-audit finding #3: B4 only exercised 2-of-4 owner candidates
  // (both nonzero). This adds a 3rd (wifi, owner-bearer) that is INDEPENDENTLY
  // zero, proving partial omission — not just all-or-nothing — works.
  it("omits an independently-zero owner component while still minting the other non-zero ones", async () => {
    const db = getDb();
    const entry = await seedEntry({
      tnbPattern: "absorbed", tnbTotalRaw: "300.00",
      cleaningBearer: "owner", cleaning: "30.00",
      wifiBearer: "owner", wifi: "0.00", // owner-bearer, but genuinely RM0
    });
    const a = alloc([]);

    const result = await db.$transaction((tx) => mintItemizedCharges(tx, session, entry, a, 330, YM, 0, []));

    expect(result.ownerChargeIds).toHaveLength(2); // electricity + cleaning only, wifi omitted
    const charges = await db.charge.findMany({ where: { organizationId: ORG } });
    expect(charges.some((c) => c.chargeNumber.endsWith("-WIFI"))).toBe(false);
    const sum = charges.reduce((s, c) => s + Number(c.amount.toString()), 0);
    expect(Math.round(sum * 100) / 100).toBe(330);
  });

  // Adversarial-audit finding #4: pin the boundary pair explicitly — a room
  // whose subsidy fully offsets its gross to EXACTLY 0 mints nothing (existing
  // room-level RM0 guard), while one cent short (0.01) mints the near-full
  // components AND the almost-equal negative subsidy, netting to 0.01.
  it("mints nothing for a fully-subsidised (RM0) room", async () => {
    const db = getDb();
    const entry = await seedEntry();
    const a = alloc([
      line({ tnbShare: 60, grossShareTotal: 60, subsidyDeduction: 60, computedAmount: 0 }),
    ]);

    const result = await db.$transaction((tx) => mintItemizedCharges(tx, session, entry, a, 0, YM, 0, []));

    expect(result.tenantChargeIds).toHaveLength(0);
    expect(await db.charge.count({ where: { organizationId: ORG } })).toBe(0);
  });

  it("mints the near-full components + subsidy for a room one cent short of fully subsidised", async () => {
    const db = getDb();
    const entry = await seedEntry();
    const a = alloc([
      line({ tnbShare: 60, grossShareTotal: 60, subsidyDeduction: 59.99, computedAmount: 0.01 }),
    ]);

    const result = await db.$transaction((tx) => mintItemizedCharges(tx, session, entry, a, 0, YM, 0, []));

    expect(result.tenantChargeIds).toHaveLength(2); // electricity (60) + subsidy (-59.99)
    const charges = await db.charge.findMany({ where: { organizationId: ORG } });
    const sum = charges.reduce((s, c) => s + Number(c.amount.toString()), 0);
    expect(Math.round(sum * 100) / 100).toBe(0.01);
  });

  // Adversarial-audit finding #5: B1/B4 only ever asserted TOTALS. A
  // shared-accumulator or off-by-one bug swapping two rooms' tenancyId/partyId/
  // unitId would pass every prior test — this asserts per-room IDENTITY.
  it("keeps each room's charges scoped to its own tenancyId/partyId/unitId (no cross-room contamination)", async () => {
    const db = getDb();
    const entry = await seedEntry();
    const a = alloc([
      line({ unitId: ROOM_A, tenancyId: TEN_A, partyId: PARTY_A, tnbShare: 100, grossShareTotal: 100, computedAmount: 100 }),
      line({ unitId: ROOM_B, tenancyId: TEN_B, partyId: PARTY_B, wifiShare: 40, grossShareTotal: 40, computedAmount: 40 }),
    ]);

    await db.$transaction((tx) => mintItemizedCharges(tx, session, entry, a, 0, YM, 0, []));

    const roomACharges = await db.charge.findMany({ where: { organizationId: ORG, unitId: ROOM_A } });
    const roomBCharges = await db.charge.findMany({ where: { organizationId: ORG, unitId: ROOM_B } });
    expect(roomACharges).toHaveLength(1);
    expect(roomBCharges).toHaveLength(1);
    expect(roomACharges[0]).toMatchObject({ tenancyId: TEN_A, partyId: PARTY_A, unitId: ROOM_A });
    expect(roomBCharges[0]).toMatchObject({ tenancyId: TEN_B, partyId: PARTY_B, unitId: ROOM_B });
    expect(roomACharges[0].chargeNumber.includes(ROOM_A)).toBe(true);
    expect(roomBCharges[0].chargeNumber.includes(ROOM_B)).toBe(true);
  });

  it("skips a tenant_direct utility (realistic zero share) without minting or throwing", async () => {
    const db = getDb();
    // tnbPattern tenant_direct means the tenant pays TNB directly — with the
    // shape.ts fix (contract 2) tnbShare is realistically already 0 by the
    // time it reaches the mint. computedAmount reflects only the OTHER
    // (non-tenant_direct) components.
    const entry = await seedEntry({ tnbPattern: "tenant_direct" });
    const a = alloc([
      line({ tnbShare: 0, airSelangorShare: 70, wifiShare: 40, cleaningShare: 30, grossShareTotal: 140, computedAmount: 140 }),
    ]);

    const result = await db.$transaction((tx) => mintItemizedCharges(tx, session, entry, a, 0, YM, 0, []));

    expect(result.tenantChargeIds).toHaveLength(3); // water + wifi + cleaning; no electricity
    const charges = await db.charge.findMany({ where: { organizationId: ORG } });
    expect(charges.some((c) => c.chargeNumber.includes("ELECTRICITY"))).toBe(false);
    const sum = charges.reduce((s, c) => s + Number(c.amount.toString()), 0);
    expect(Math.round(sum * 100) / 100).toBe(140);
  });

  // Adversarial-audit-motivated (proves contract 3's ORDERING, not just its
  // net effect): simulates a hypothetical shape.ts regression where a
  // tenant_direct utility's share is (wrongly) non-zero. The skip must drop it
  // BEFORE classifyUtilityCharge is called — classifying a pass-through utility
  // funded tenant_direct with no markup THROWS ClassificationError
  // ("PASSTHROUGH_FUNDING", see classify-utility.test.ts). Proving the mint
  // throws IssuanceError("SUM_INVARIANT") instead (never a ClassificationError)
  // demonstrates the skip runs first — the Σ-invariant safety net, not an
  // uncaught classifier throw, is what catches this "impossible in practice"
  // input.
  it("drops a tenant_direct component before classifying, never a ClassificationError", async () => {
    const db = getDb();
    const entry = await seedEntry({ tnbPattern: "tenant_direct" });
    // computedAmount is internally consistent with a FULL (un-zeroed) tnbShare —
    // i.e. what compute.ts would produce if shape.ts had NOT zeroed the pool.
    const a = alloc([
      line({ tnbShare: 380, airSelangorShare: 70, grossShareTotal: 450, computedAmount: 450 }),
    ]);

    const thrown = await db.$transaction((tx) => mintItemizedCharges(tx, session, entry, a, 0, YM, 0, [])).catch((e: unknown) => e);
    expect(thrown).toMatchObject({ name: "IssuanceError", code: "SUM_INVARIANT" });
    expect((thrown as Error).name).not.toBe("ClassificationError");
    expect(await db.charge.count({ where: { organizationId: ORG } })).toBe(0);
  });

  it("stamps classifier economics + supplier + category per component", async () => {
    const db = getDb();
    // manager_advanced electricity -> fundedBy "manager" -> recovery_of_advance
    // (per classify-utility.ts's PASSTHROUGH branch, no markup since
    // actualCost=chargedAmount always here).
    const entry = await seedEntry({ tnbPattern: "manager_advanced", cleaningBearer: "tenant" });
    const a = alloc([
      line({ tnbShare: 380, cleaningShare: 30, grossShareTotal: 410, computedAmount: 410 }),
    ]);

    await db.$transaction((tx) => mintItemizedCharges(tx, session, entry, a, 0, YM, 0, []));

    const electricity = await db.charge.findFirst({ where: { organizationId: ORG, chargeNumber: { endsWith: "-ELECTRICITY" } } });
    expect(electricity).toMatchObject({
      fundedBy: "manager", revenueRecognition: "recovery_of_advance", settlementRecipient: "manager",
      taxTreatment: "out_of_scope_disbursement", sourceSupplier: "TNB", chargeType: "utility",
      sourceGridEntryId: entry.id,
    });
    expect(electricity?.markupAmount?.toString()).toBe("0");

    // cleaning bearer "tenant" -> fundedByForUtility "manager" -> manager_revenue/taxable_service.
    const cleaning = await db.charge.findFirst({ where: { organizationId: ORG, chargeNumber: { endsWith: "-CLEANING" } } });
    expect(cleaning).toMatchObject({
      fundedBy: "manager", revenueRecognition: "manager_revenue", settlementRecipient: "manager",
      taxTreatment: "taxable_service", sourceSupplier: null, chargeType: "utility",
    });

    const cats = await db.chargeCategory.findMany({ where: { organizationId: ORG, code: { in: ["electricity_tenant", "cleaning_tenant"] } } });
    expect(electricity?.categoryId).toBe(cats.find((c) => c.code === "electricity_tenant")?.id);
    expect(cleaning?.categoryId).toBe(cats.find((c) => c.code === "cleaning_tenant")?.id);
  });

  it("suffixes chargeNumber with -r{revision} only when revision > 0 (tenant + owner)", async () => {
    const db = getDb();
    const entry = await seedEntry({ tnbPattern: "absorbed", tnbTotalRaw: "300.00" });
    const a = alloc([line({ tnbShare: 100, grossShareTotal: 100, computedAmount: 100 })]);

    const r0 = await db.$transaction((tx) => mintItemizedCharges(tx, session, entry, a, 300, YM, 0, []));
    const zeroCharges = await db.charge.findMany({ where: { id: { in: [...r0.tenantChargeIds, ...r0.ownerChargeIds] } } });
    expect(zeroCharges.every((c) => !c.chargeNumber.includes("-r"))).toBe(true);
    expect(zeroCharges.some((c) => c.chargeNumber === `GRIDUTIL-${YM}-${ROOM_A}-ELECTRICITY`)).toBe(true);
    expect(zeroCharges.some((c) => c.chargeNumber === `GRIDOWN-${YM}-${APT}-ELECTRICITY`)).toBe(true);

    // Retire the revision-0 charges (mirrors the real re-Bill's credit-first
    // step) so the revision-1 mint's chargeNumbers don't collide under
    // @@unique([organizationId, chargeNumber]).
    await db.charge.updateMany({ where: { id: { in: [...r0.tenantChargeIds, ...r0.ownerChargeIds] } }, data: { status: "credited" } });

    const r1 = await db.$transaction((tx) => mintItemizedCharges(tx, session, entry, a, 300, YM, 1, []));
    const oneCharges = await db.charge.findMany({ where: { id: { in: [...r1.tenantChargeIds, ...r1.ownerChargeIds] } } });
    expect(oneCharges.every((c) => c.chargeNumber.endsWith("-r1"))).toBe(true);
    expect(oneCharges.some((c) => c.chargeNumber === `GRIDUTIL-${YM}-${ROOM_A}-ELECTRICITY-r1`)).toBe(true);
    expect(oneCharges.some((c) => c.chargeNumber === `GRIDOWN-${YM}-${APT}-ELECTRICITY-r1`)).toBe(true);
  });

  it("throws CATEGORY_UNRESOLVED when a required category can never be seeded (name collision), minting nothing", async () => {
    const db = getDb();
    const entry = await seedEntry();
    const a = alloc([line({ tnbShare: 100, grossShareTotal: 100, computedAmount: 100 })]);

    // Force the seeder into the documented "colliding name" gap (Task 3
    // out-of-scope observation #2): pre-seed normally, delete
    // electricity_tenant, then plant a DIFFERENT-code row with the SAME name —
    // ensureChargeCategorySeeds is create-only and P2002-skips on (org,name),
    // so electricity_tenant can never be (re)created for this org.
    await ensureChargeCategorySeeds(ORG);
    const ivten = await db.documentSeries.findFirstOrThrow({ where: { organizationId: ORG, code: "IVTEN" } });
    await db.chargeCategory.deleteMany({ where: { organizationId: ORG, code: "electricity_tenant" } });
    await db.chargeCategory.create({
      data: { organizationId: ORG, code: "electricity_tenant_poison", name: "Electricity (tenant)", family: "tenant_income", docType: "invoice", seriesId: ivten.id, defaultSstRate: "0" },
    });

    await expect(db.$transaction((tx) => mintItemizedCharges(tx, session, entry, a, 0, YM, 0, []))).rejects.toMatchObject({ code: "CATEGORY_UNRESOLVED" });
    expect(await db.charge.count({ where: { organizationId: ORG } })).toBe(0);
  });

  it("throws OWNER_UNRESOLVED when ownerBorne > 0 and no apartment owner is assigned", async () => {
    const db = getDb();
    // Un-assign the owner on both rooms (mintItemizedCharges' resolveApartmentOwner
    // finds no listing with a non-null ownerPartyId).
    await db.listing.updateMany({ where: { organizationId: ORG, apartmentId: APT }, data: { ownerPartyId: null } });
    const entry = await seedEntry({ tnbPattern: "absorbed", tnbTotalRaw: "300.00" });
    const a = alloc([]);

    await expect(db.$transaction((tx) => mintItemizedCharges(tx, session, entry, a, 300, YM, 0, []))).rejects.toMatchObject({ code: "OWNER_UNRESOLVED" });
    expect(await db.charge.count({ where: { organizationId: ORG } })).toBe(0);
  });

  // ── Private submeter electricity (regression) ──────────────────────────────
  //
  // THE PRODUCTION BUG, reproduced against the REAL engine (not a hand-built alloc):
  // a PARTITIONED apartment whose rooms' submeters total MORE than the master TNB bill.
  // compute.ts clamps `leftoverTnb` to 0, so every pooled electricity share is 0 — and
  // before this fix the per-room aircond was never minted either, so the tenants' entire
  // electricity bill (RM60 + RM87) reached NO invoice. Observed live as an IVTEN carrying
  // only a water line.
  describe("private submeter electricity (GRIDAC-)", () => {
    const ROOMS: RoomInput[] = [
      { unitId: ROOM_A, tenancyId: TEN_A, partyId: PARTY_A, pax: 1, airconCharge: 60 },
      { unitId: ROOM_B, tenancyId: TEN_B, partyId: PARTY_B, pax: 2, airconCharge: 87 },
    ];
    // TNB 100 < Σaircond 147, water 20 — the exact live numbers.
    const realAlloc = () =>
      computeAllocation(
        "no_subsidy", 0,
        { tnbTotal: 100, airSelangor: 20, indahWater: 0, wifi: 0, cleaning: 0, maintenance: 0 },
        ROOMS,
        { indahWater: "owner", cleaning: "owner", wifi: "owner", maintenance: "owner" },
        true, // PARTITIONED ⇒ privateAircond
      );

    it("bills each room its OWN metered consumption even when the pooled share clamps to 0", async () => {
      const db = getDb();
      const entry = await seedEntry({ tnbTotalRaw: "100.00", airSelangorRaw: "20.00", cleaningBearer: "owner", wifiBearer: "owner" });
      const a = realAlloc();
      // Precondition: the clamp really did wipe the pooled electricity out.
      expect(a.leftoverTnb).toBe(0);
      expect(a.allocations.every((x) => x.tnbShare === 0)).toBe(true);

      await db.$transaction((tx) => mintItemizedCharges(tx, session, entry, a, 0, YM, 0, ROOMS));

      const ac = await db.charge.findMany({ where: { organizationId: ORG, chargeType: "aircond" }, orderBy: { chargeNumber: "asc" } });
      expect(ac).toHaveLength(2);
      expect(ac.map((c) => Number(c.amount.toString()))).toEqual([60, 87]);
      // Billed to the ROOM'S OWN tenant — never pooled, never per-pax.
      expect(ac.map((c) => [c.unitId, c.partyId, c.tenancyId])).toEqual([
        [ROOM_A, PARTY_A, TEN_A],
        [ROOM_B, PARTY_B, TEN_B],
      ]);
      expect(ac.map((c) => c.chargeNumber)).toEqual([`GRIDAC-${YM}-${ROOM_A}`, `GRIDAC-${YM}-${ROOM_B}`]);
      expect(ac.every((c) => c.sourceGridEntryId === entry.id)).toBe(true);
    });

    it('stamps chargeType "aircond" so the owner ledger books it as aircond_income, not utility_income', async () => {
      const db = getDb();
      const entry = await seedEntry({ tnbTotalRaw: "100.00", airSelangorRaw: "20.00", cleaningBearer: "owner", wifiBearer: "owner" });

      await db.$transaction((tx) => mintItemizedCharges(tx, session, entry, realAlloc(), 0, YM, 0, ROOMS));

      // owner-ledger.sync.ts Source 4 discriminates on EXACTLY this literal:
      //   sourceType = chargeType === "aircond" ? "tenant_aircond" : "tenant_utility"
      //   category   = chargeType === "aircond" ? "aircond_income" : "utility_income"
      // Paired with the TNB expense Source 3 books, this is what nets the owner's spread.
      const ac = await db.charge.findMany({ where: { organizationId: ORG, chargeNumber: { startsWith: "GRIDAC-" } } });
      expect(ac).toHaveLength(2);
      expect(new Set(ac.map((c) => c.chargeType))).toEqual(new Set(["aircond"]));
      // Routed to the tenant invoice (IVTEN), NOT the Expense Bill.
      const cat = await db.chargeCategory.findFirstOrThrow({ where: { organizationId: ORG, code: "electricity_tenant" } });
      expect(ac.every((c) => c.categoryId === cat.id)).toBe(true);
      expect(ac.every((c) => c.nature === null)).toBe(true);
    });

    it("never bills a VACANT room's aircond to a tenant (it is owner-attributable)", async () => {
      const db = getDb();
      const entry = await seedEntry({ tnbTotalRaw: "100.00", airSelangorRaw: "20.00", cleaningBearer: "owner", wifiBearer: "owner" });
      // ROOM_B vacant: no tenancy/party ⇒ compute's partition() drops it from `occupied`,
      // and its aircond becomes ownerAttributableAircond.
      const rooms: RoomInput[] = [
        { unitId: ROOM_A, tenancyId: TEN_A, partyId: PARTY_A, pax: 1, airconCharge: 60 },
        { unitId: ROOM_B, tenancyId: null, partyId: null, pax: 0, airconCharge: 87 },
      ];
      const a = computeAllocation(
        "no_subsidy", 0,
        { tnbTotal: 100, airSelangor: 20, indahWater: 0, wifi: 0, cleaning: 0, maintenance: 0 },
        rooms,
        { indahWater: "owner", cleaning: "owner", wifi: "owner", maintenance: "owner" },
        true,
      );
      expect(a.ownerAttributableAircond).toBe(87);

      await db.$transaction((tx) => mintItemizedCharges(tx, session, entry, a, 0, YM, 0, rooms));

      const ac = await db.charge.findMany({ where: { organizationId: ORG, chargeType: "aircond" } });
      expect(ac).toHaveLength(1);
      expect(ac[0].unitId).toBe(ROOM_A);
      expect(Number(ac[0].amount.toString())).toBe(60);
    });

    it("mints nothing when a room has no submeter reading (RM0 aircond)", async () => {
      const db = getDb();
      const entry = await seedEntry({ tnbTotalRaw: "100.00", airSelangorRaw: "20.00", cleaningBearer: "owner", wifiBearer: "owner" });
      const rooms: RoomInput[] = [
        { unitId: ROOM_A, tenancyId: TEN_A, partyId: PARTY_A, pax: 1, airconCharge: 0 },
        { unitId: ROOM_B, tenancyId: TEN_B, partyId: PARTY_B, pax: 2, airconCharge: 0 },
      ];
      const a = computeAllocation(
        "no_subsidy", 0,
        { tnbTotal: 100, airSelangor: 20, indahWater: 0, wifi: 0, cleaning: 0, maintenance: 0 },
        rooms,
        { indahWater: "owner", cleaning: "owner", wifi: "owner", maintenance: "owner" },
        true,
      );
      await db.$transaction((tx) => mintItemizedCharges(tx, session, entry, a, 0, YM, 0, rooms));
      expect(await db.charge.count({ where: { organizationId: ORG, chargeType: "aircond" } })).toBe(0);
      // ...and the pooled utilities still mint normally (TNB 100 − 0 aircond = 100 leftover).
      expect(await db.charge.count({ where: { organizationId: ORG, chargeType: "utility" } })).toBeGreaterThan(0);
    });
  });
  // ── Partial re-Bill: skipIdentities (slice 2 Task 2) ───────────────────────
  //
  // A partial re-Bill must NOT re-mint a component the tenant has already paid — that
  // charge is still live and would be duplicated. Withholding it lowers the room's
  // component sum, so the Σ-invariant is RESTATED to account for the withheld amount
  // rather than relaxed. These tests pin both halves: the skip works, AND the guard is
  // still live in both modes.
  describe("skipIdentities", () => {
    it("withholds exactly the skipped component and mints every other one", async () => {
      const db = getDb();
      const entry = await seedEntry();
      const a = alloc([
        line({ tnbShare: 300, airSelangorShare: 50, wifiShare: 40, cleaningShare: 30, grossShareTotal: 420, computedAmount: 420 }),
      ]);

      const result = await db.$transaction((tx) =>
        mintItemizedCharges(tx, session, entry, a, 0, YM, 0, [], new Set([`GRIDUTIL-${YM}-${ROOM_A}-ELECTRICITY`])),
      );

      // 4 components, 1 withheld.
      expect(result.tenantChargeIds).toHaveLength(3);
      const charges = await db.charge.findMany({ where: { organizationId: ORG } });
      expect(charges.some((c) => c.chargeNumber.includes("ELECTRICITY"))).toBe(false);
      // The rest are untouched — and crucially the RM300 is simply absent, not
      // redistributed onto the remaining lines.
      const sum = charges.reduce((s, c) => s + Number(c.amount.toString()), 0);
      expect(Math.round(sum * 100) / 100).toBe(120);
    });

    it("STILL throws SUM_INVARIANT when the components do not account for computedAmount", async () => {
      // The strength proof. computedAmount says 500 but the shares only total 420, and
      // nothing is skipped — the guard must fire exactly as it always did. If the
      // restatement had accidentally disabled the assertion, this passes silently and a
      // room is under-billed by RM80 with no error anywhere.
      const db = getDb();
      const entry = await seedEntry();
      const a = alloc([
        line({ tnbShare: 300, airSelangorShare: 50, wifiShare: 40, cleaningShare: 30, grossShareTotal: 420, computedAmount: 500 }),
      ]);

      await expect(
        db.$transaction((tx) => mintItemizedCharges(tx, session, entry, a, 0, YM, 0, [])),
      ).rejects.toThrow("SUM_INVARIANT");
      expect(await db.charge.count({ where: { organizationId: ORG } })).toBe(0);
    });

    it("STILL throws when a skip set is present but does not explain the shortfall", async () => {
      // The dangerous middle case: a skip set that withholds RM300 while computedAmount is
      // short by RM380. Accounting for only what was deliberately skipped must leave the
      // remaining RM80 gap visible.
      const db = getDb();
      const entry = await seedEntry();
      const a = alloc([
        line({ tnbShare: 300, airSelangorShare: 50, wifiShare: 40, cleaningShare: 30, grossShareTotal: 420, computedAmount: 500 }),
      ]);

      await expect(
        db.$transaction((tx) =>
          mintItemizedCharges(tx, session, entry, a, 0, YM, 0, [], new Set([`GRIDUTIL-${YM}-${ROOM_A}-ELECTRICITY`])),
        ),
      ).rejects.toThrow("SUM_INVARIANT");
      expect(await db.charge.count({ where: { organizationId: ORG } })).toBe(0);
    });

    it("an identity that matches nothing changes neither the mint nor the invariant", async () => {
      // Fail-safe direction: a stale identity (e.g. a component that no longer exists this
      // month) must not silently suppress a real line or trip the guard.
      const db = getDb();
      const entry = await seedEntry();
      const a = alloc([
        line({ tnbShare: 300, airSelangorShare: 50, wifiShare: 40, cleaningShare: 30, grossShareTotal: 420, computedAmount: 420 }),
      ]);

      const result = await db.$transaction((tx) =>
        mintItemizedCharges(tx, session, entry, a, 0, YM, 0, [], new Set(["GRIDUTIL-999999-nope-ELECTRICITY"])),
      );
      expect(result.tenantChargeIds).toHaveLength(4);
    });

    it("an EMPTY skip set is byte-identical to not passing one", async () => {
      // Guards the default: first issuance and every flag-off re-Bill go through this path.
      const db = getDb();
      const entry = await seedEntry();
      const a = alloc([
        line({ tnbShare: 300, airSelangorShare: 50, wifiShare: 40, cleaningShare: 30, grossShareTotal: 420, computedAmount: 420 }),
      ]);

      const result = await db.$transaction((tx) =>
        mintItemizedCharges(tx, session, entry, a, 0, YM, 0, [], new Set()),
      );
      expect(result.tenantChargeIds).toHaveLength(4);
      const charges = await db.charge.findMany({ where: { organizationId: ORG } });
      const sum = charges.reduce((s, c) => s + Number(c.amount.toString()), 0);
      expect(Math.round(sum * 100) / 100).toBe(420);
    });
  });
});
