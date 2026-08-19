// Workstream E, Part 5 — combined tenant statement, grouped by UNIT CONTEXT and
// de-identified so the tenant never learns who their owner is (PDPA, fix #5).
//
// A tenant living in Unit B (owner OWNER_RES) who also rents bay "B2-145"
// (a Carpark with owner OWNER_CP) gets ONE statement for the month with TWO
// groups, labelled by unit context — NOT by owner:
//   - "B-10-01": residential rent (charge.unitId = UNIT_RES).
//   - "Carpark": carpark rent (charge.carparkId = CARPARK, charge.unitId = null).
// plus a grand total. Proves getCombinedStatement still routes the carpark rent
// via the Carpark relation when unitId is null, while leaking no owner identity.
//
// Run: RUN_INTEGRATION=1 DATABASE_URL=... npx vitest run \
//   src/modules/portal/charges/__tests__/portal.statement.integration.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { getCombinedStatement } from "../portal.statement.repository";

const RUN = process.env.RUN_INTEGRATION === "1";

// Disjoint fixed UUIDs (prefix 1a… — unique to this suite).
const ORG = "1a000000-0000-4000-8000-0000000000a1";
const OWNER_RES = "1a000000-0000-4000-8000-0000000000a2";
const OWNER_CP = "1a000000-0000-4000-8000-0000000000a3";
const TENANT = "1a000000-0000-4000-8000-0000000000a4";
const PROPERTY = "1a000000-0000-4000-8000-0000000000a5";
const APT_RES = "1a000000-0000-4000-8000-0000000000a6";
const APT_CP = "1a000000-0000-4000-8000-0000000000a7"; // home apartment for the carpark bay
const UNIT_RES = "1a000000-0000-4000-8000-0000000000a8";
const TENANCY_RES = "1a000000-0000-4000-8000-0000000000aa";
const CARPARK = "1a000000-0000-4000-8000-0000000000ac"; // the Carpark bay (NOT a Listing)

const MONTH = "2026-06";
const DUE = new Date(Date.UTC(2026, 5, 5));

async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  await db.charge.deleteMany({ where: org });
  await db.carparkAssignment.deleteMany({ where: org });
  await db.carpark.deleteMany({ where: org });
  await db.tenancy.deleteMany({ where: org });
  await db.listing.deleteMany({ where: org });
  await db.apartment.deleteMany({ where: org });
  await db.property.deleteMany({ where: org });
  await db.party.deleteMany({ where: org });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function seed() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG,
      name: "Statement Org",
      slug: "statement-org-e",
      status: "active",
      defaultCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur",
      locale: "en-MY",
      subscriptionPlan: "free",
    },
  });
  for (const [id, name] of [
    // Distinctive, obviously-PII owner names: the leak test asserts NEITHER
    // appears anywhere in the serialized tenant statement (PDPA #5).
    [OWNER_RES, "DATO RAZAK BIN AHMAD"],
    [OWNER_CP, "PUAN SITI NURHALIZA"],
    [TENANT, "Statement Tenant"],
  ] as const) {
    await db.party.create({
      data: { id, organizationId: ORG, displayName: name, partyType: "individual", status: "active" },
    });
  }
  await db.property.create({
    data: {
      id: PROPERTY,
      organizationId: ORG,
      name: "Statement Property",
      propertyCode: "STMT-E-P1",
      propertyType: "apartment",
      addressLine1: "1 Statement St",
      city: "KL",
      country: "MY",
      status: "active",
      publishStatus: "draft",
    },
  });
  // Residential apartment + listing.
  await db.apartment.create({
    data: { id: APT_RES, organizationId: ORG, propertyId: PROPERTY, unitCode: "B-10-01", listingMode: "WHOLE" },
  });
  await db.listing.create({
    data: {
      id: UNIT_RES,
      organizationId: ORG,
      apartmentId: APT_RES,
      listingType: "Whole unit",
      occupancyStatus: "occupied",
      listingStatus: "active",
      currency: "MYR",
      ownerPartyId: OWNER_RES,
    },
  });
  // Carpark bay's home apartment (the building unit to which the bay belongs).
  await db.apartment.create({
    data: { id: APT_CP, organizationId: ORG, propertyId: PROPERTY, unitCode: "A-CP-145", listingMode: "WHOLE" },
  });
  // The Carpark itself — NOT a Listing. Owner is OWNER_CP (a different owner from OWNER_RES).
  await db.carpark.create({
    data: {
      id: CARPARK,
      organizationId: ORG,
      propertyId: PROPERTY,
      apartmentId: APT_CP,
      ownerPartyId: OWNER_CP,
      label: "B2-145",
      monthlyRate: "150.00",
      status: "rented",
    },
  });
  // Residential tenancy (room).
  await db.tenancy.create({
    data: {
      id: TENANCY_RES,
      organizationId: ORG,
      propertyId: PROPERTY,
      unitId: UNIT_RES,
      tenantPartyId: TENANT,
      tenancyCode: "STMT-E-RES",
      status: "active",
      billingStatus: "current",
      startDate: new Date("2026-01-01T00:00:00.000Z"),
      monthlyRentAmount: "1500",
    },
  });
  // Residential rent charge → resolved to Owner B via charge.unit.ownerPartyId.
  await db.charge.create({
    data: {
      organizationId: ORG,
      chargeNumber: "STMT-E-RENT-RES",
      tenancyId: TENANCY_RES,
      unitId: UNIT_RES,
      partyId: TENANT,
      chargeType: "rent",
      status: "posted",
      dueDate: DUE,
      amount: "1500.00",
      currency: "MYR",
      outstandingAmount: "1500.00",
    },
  });
  // Carpark rent charge → resolved to Owner A via charge.carpark.ownerPartyId.
  // unitId is null because there is no carpark Listing in the new model.
  await db.charge.create({
    data: {
      organizationId: ORG,
      chargeNumber: "STMT-E-RENT-CARPARK",
      tenancyId: TENANCY_RES,
      carparkId: CARPARK,
      partyId: TENANT,
      chargeType: "rent",
      status: "posted",
      dueDate: DUE,
      amount: "150.00",
      currency: "MYR",
      outstandingAmount: "150.00",
    },
  });
  // A charge from a PRIOR month — must be excluded from the June statement.
  await db.charge.create({
    data: {
      organizationId: ORG,
      chargeNumber: "STMT-E-RENT-MAY",
      tenancyId: TENANCY_RES,
      unitId: UNIT_RES,
      partyId: TENANT,
      chargeType: "rent",
      status: "paid",
      dueDate: new Date(Date.UTC(2026, 4, 5)), // 2026-05-05
      amount: "1500.00",
      currency: "MYR",
      outstandingAmount: "0.00",
    },
  });
}

describe.skipIf(!RUN)("getCombinedStatement — tenant charges grouped by unit context, de-identified (integration)", () => {
  beforeAll(async () => {
    await cleanup();
    await seed();
  });
  afterAll(cleanup);

  it("groups the month's charges into two unit-context groups with the right amounts + total", async () => {
    const stmt = await getCombinedStatement({ partyId: TENANT, orgId: ORG }, MONTH);

    expect(stmt.month).toBe("2026-06-01");
    expect(stmt.monthLabel).toBe("June 2026");

    // Two groups, keyed + labelled by UNIT context (not owner): the residential
    // Listing (its unit code) and the Carpark bay.
    expect(stmt.groups).toHaveLength(2);

    const byLabel = new Map(stmt.groups.map((g) => [g.groupLabel, g]));
    const resGroup = byLabel.get("B-10-01");
    const cpGroup = byLabel.get("Carpark");
    expect(resGroup).toBeDefined();
    expect(cpGroup).toBeDefined();

    // Residential group = the residential rent only, keyed by the Listing id.
    expect(resGroup!.groupKey).toBe(UNIT_RES);
    expect(resGroup!.lines).toHaveLength(1);
    expect(resGroup!.lines[0]!.chargeNumber).toBe("STMT-E-RENT-RES");
    expect(resGroup!.subtotal).toBe(1500);

    // Carpark group = the carpark rent only, keyed by the Carpark id.
    expect(cpGroup!.groupKey).toBe(CARPARK);
    expect(cpGroup!.lines).toHaveLength(1);
    expect(cpGroup!.lines[0]!.chargeNumber).toBe("STMT-E-RENT-CARPARK");
    expect(cpGroup!.subtotal).toBe(150);

    // Grand total across groups (May's charge is excluded by the month window).
    expect(stmt.total).toBe(1650);
    expect(stmt.outstandingTotal).toBe(1650);
    expect(stmt.currency).toBe("MYR");
  });

  it("excludes charges outside the requested month", async () => {
    const may = await getCombinedStatement({ partyId: TENANT, orgId: ORG }, "2026-05");
    // Only the May residential rent → one group, labelled by the unit code.
    expect(may.total).toBe(1500);
    expect(may.groups).toHaveLength(1);
    expect(may.groups[0]!.groupLabel).toBe("B-10-01");
  });

  it("no owner name leaks to tenant — the statement is de-identified (PDPA #5)", async () => {
    const stmt = await getCombinedStatement({ partyId: TENANT, orgId: ORG }, MONTH);
    const serialized = JSON.stringify(stmt);

    // The tenant payload must carry NO owner identity — neither the display name
    // nor the owner partyId — for the residential unit's owner OR the carpark
    // bay's (different) owner.
    expect(serialized).not.toContain("DATO RAZAK BIN AHMAD");
    expect(serialized).not.toContain("PUAN SITI NURHALIZA");
    expect(serialized).not.toContain(OWNER_RES);
    expect(serialized).not.toContain(OWNER_CP);

    // What the tenant DOES see: unit-context labels only.
    const labels = stmt.groups.map((g) => g.groupLabel).sort();
    expect(labels).toEqual(["B-10-01", "Carpark"]);
  });
});

// ─── Task B2 (#9): hide the RM0 shared-utility charge line, render-side ───────
//
// A room's "Shared utilities" charge can compute to RM0.00 when the owner's
// subsidy fully covers that room's share. The RM0.00 line is a confusing render
// artifact, not new information — hide it. If EVERY charge in a unit's group for
// the month is a 0.00 utility charge, the whole group must vanish too (never an
// empty group card). A non-zero utility charge, and a non-utility charge that
// happens to be 0.00 (e.g. a waived rent adjustment), are both unaffected.

const ORG2 = "1b000000-0000-4000-8000-0000000000b1";
const TENANT2 = "1b000000-0000-4000-8000-0000000000b2";
const PROPERTY2 = "1b000000-0000-4000-8000-0000000000b3";
const APT_ZERO = "1b000000-0000-4000-8000-0000000000b4";
const UNIT_ZERO = "1b000000-0000-4000-8000-0000000000b5";
const APT_MIXED = "1b000000-0000-4000-8000-0000000000b6";
const UNIT_MIXED = "1b000000-0000-4000-8000-0000000000b7";

async function cleanup2() {
  const db = getDb();
  const org = { organizationId: ORG2 };
  await db.charge.deleteMany({ where: org });
  await db.listing.deleteMany({ where: org });
  await db.apartment.deleteMany({ where: org });
  await db.property.deleteMany({ where: org });
  await db.party.deleteMany({ where: org });
  await db.organization.deleteMany({ where: { id: ORG2 } });
}

async function seed2() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG2,
      name: "Statement Org B2",
      slug: "statement-org-b2",
      status: "active",
      defaultCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur",
      locale: "en-MY",
      subscriptionPlan: "free",
    },
  });
  await db.party.create({
    data: {
      id: TENANT2,
      organizationId: ORG2,
      displayName: "Zero-Utility Tenant",
      partyType: "individual",
      status: "active",
    },
  });
  await db.property.create({
    data: {
      id: PROPERTY2,
      organizationId: ORG2,
      name: "Statement Property B2",
      propertyCode: "STMT-B2-P1",
      propertyType: "apartment",
      addressLine1: "2 Statement St",
      city: "KL",
      country: "MY",
      status: "active",
      publishStatus: "draft",
    },
  });

  // UNIT_ZERO: the ONLY charge for the month is a 0.00 utility charge — the whole
  // group must vanish (no empty group card).
  await db.apartment.create({
    data: { id: APT_ZERO, organizationId: ORG2, propertyId: PROPERTY2, unitCode: "Z-ZERO-01", listingMode: "WHOLE" },
  });
  await db.listing.create({
    data: {
      id: UNIT_ZERO,
      organizationId: ORG2,
      apartmentId: APT_ZERO,
      listingType: "Whole unit",
      occupancyStatus: "occupied",
      listingStatus: "active",
      currency: "MYR",
    },
  });
  await db.charge.create({
    data: {
      organizationId: ORG2,
      chargeNumber: "STMT-B2-ZERO-UTIL",
      unitId: UNIT_ZERO,
      partyId: TENANT2,
      chargeType: "utility",
      status: "posted",
      dueDate: DUE,
      amount: "0.00",
      currency: "MYR",
      outstandingAmount: "0.00",
    },
  });

  // UNIT_MIXED: a non-zero rent charge + a 0.00 utility charge + a non-zero
  // utility charge + a 0.00 RENT charge (non-utility). Group survives (non-zero
  // lines present); the 0.00 UTILITY line is hidden; the 0.00 RENT line is NOT
  // (the filter is scoped to chargeType==="utility" only).
  await db.apartment.create({
    data: { id: APT_MIXED, organizationId: ORG2, propertyId: PROPERTY2, unitCode: "Z-MIX-02", listingMode: "WHOLE" },
  });
  await db.listing.create({
    data: {
      id: UNIT_MIXED,
      organizationId: ORG2,
      apartmentId: APT_MIXED,
      listingType: "Whole unit",
      occupancyStatus: "occupied",
      listingStatus: "active",
      currency: "MYR",
    },
  });
  await db.charge.create({
    data: {
      organizationId: ORG2,
      chargeNumber: "STMT-B2-MIXED-RENT",
      unitId: UNIT_MIXED,
      partyId: TENANT2,
      chargeType: "rent",
      status: "posted",
      dueDate: DUE,
      amount: "800.00",
      currency: "MYR",
      outstandingAmount: "800.00",
    },
  });
  await db.charge.create({
    data: {
      organizationId: ORG2,
      chargeNumber: "STMT-B2-MIXED-ZERO-UTIL",
      unitId: UNIT_MIXED,
      partyId: TENANT2,
      chargeType: "utility",
      status: "posted",
      dueDate: DUE,
      amount: "0.00",
      currency: "MYR",
      outstandingAmount: "0.00",
    },
  });
  await db.charge.create({
    data: {
      organizationId: ORG2,
      chargeNumber: "STMT-B2-MIXED-NONZERO-UTIL",
      unitId: UNIT_MIXED,
      partyId: TENANT2,
      chargeType: "utility",
      status: "posted",
      dueDate: DUE,
      amount: "12.50",
      currency: "MYR",
      outstandingAmount: "12.50",
    },
  });
  await db.charge.create({
    data: {
      organizationId: ORG2,
      chargeNumber: "STMT-B2-MIXED-ZERO-RENT",
      unitId: UNIT_MIXED,
      partyId: TENANT2,
      chargeType: "rent",
      status: "posted",
      dueDate: DUE,
      amount: "0.00",
      currency: "MYR",
      outstandingAmount: "0.00",
    },
  });
}

describe.skipIf(!RUN)("getCombinedStatement — zero utility hidden (#9, integration)", () => {
  beforeAll(async () => {
    await cleanup2();
    await seed2();
  });
  afterAll(cleanup2);

  it("zero utility hidden: drops the 0.00 utility line, keeps non-zero + non-utility-zero lines, and removes a group left fully empty", async () => {
    const stmt = await getCombinedStatement({ partyId: TENANT2, orgId: ORG2 }, MONTH);

    const byLabel = new Map(stmt.groups.map((g) => [g.groupLabel, g]));

    // UNIT_ZERO's only charge was a 0.00 utility line — the whole group is gone.
    expect(byLabel.has("Z-ZERO-01")).toBe(false);
    expect(stmt.groups).toHaveLength(1); // only UNIT_MIXED survives

    // UNIT_MIXED's group survives (it has non-zero + non-utility-zero lines).
    const mixed = byLabel.get("Z-MIX-02");
    expect(mixed).toBeDefined();

    // Exactly 3 lines: rent (800.00) + non-zero utility (12.50) + zero RENT
    // (0.00, non-utility) — the 0.00 UTILITY line is hidden.
    expect(mixed!.lines).toHaveLength(3);
    expect(
      mixed!.lines.some((l) => l.chargeType === "utility" && l.amount === 0),
    ).toBe(false);
    expect(mixed!.lines.some((l) => l.chargeType === "rent" && l.amount === 800)).toBe(true);
    expect(mixed!.lines.some((l) => l.chargeType === "utility" && l.amount === 12.5)).toBe(true);
    expect(mixed!.lines.some((l) => l.chargeType === "rent" && l.amount === 0)).toBe(true);

    // Totals unaffected by the hidden 0.00 utility lines (0 contributes 0 either way).
    expect(mixed!.subtotal).toBe(812.5);
    expect(stmt.total).toBe(812.5);
  });
});
