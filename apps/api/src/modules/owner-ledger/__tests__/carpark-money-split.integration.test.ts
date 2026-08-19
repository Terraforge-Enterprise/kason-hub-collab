// Workstream E, Task 4.4 — end-to-end carpark money-split (integration, NEW MODEL).
//
// Scenario: A tenant lives in Unit B (residential, owned by OWNER_RES) and also rents
// a carpark bay (owned by OWNER_CP) in the same building. The bay is modelled as a
// `Carpark` record (new model) — NOT a carpark Listing. The bay's rent is a Charge
// with carparkId set and unitId:null (invisible to the existing unitId-IN-unitIds
// Source-1 fetch in syncMonthService).
//
// After syncMonthService runs for each owner:
//   • OWNER_CP's ledger has a `carpark_income` row (sourceType:"carpark") for the bay
//     charge — attributed by Carpark.ownerPartyId.
//   • OWNER_RES's ledger has a `rental_income` row for the room rent.
//   • Neither owner's ledger contains the other's row (clean money split).
//
// Run: RUN_INTEGRATION=1 DATABASE_URL=... npx vitest run \
//   src/modules/owner-ledger/__tests__/carpark-money-split.integration.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { syncMonthService } from "../owner-ledger.sync";
import type { OwnerLedgerActorCtx } from "../owner-ledger.types";

const RUN = process.env.RUN_INTEGRATION === "1";

// Disjoint fixed UUIDs (prefix 0f… — unique to this suite).
const ORG      = "0f000000-0000-4000-8000-0000000000a1";
const USER     = "0f000000-0000-4000-8000-0000000000a2"; // operator (audit FK)
const OPERATOR = "0f000000-0000-4000-8000-0000000000a3"; // operator party
const OWNER_RES = "0f000000-0000-4000-8000-0000000000a4"; // owns the room
const OWNER_CP  = "0f000000-0000-4000-8000-0000000000a5"; // owns the carpark bay
const TENANT    = "0f000000-0000-4000-8000-0000000000a6";
const PROPERTY  = "0f000000-0000-4000-8000-0000000000a7";
const APT_RES   = "0f000000-0000-4000-8000-0000000000a8"; // residential apartment
const APT_CP    = "0f000000-0000-4000-8000-0000000000a9"; // apartment the bay belongs to
const UNIT_RES  = "0f000000-0000-4000-8000-0000000000aa"; // residential Listing
const CARPARK   = "0f000000-0000-4000-8000-0000000000ab"; // Carpark entity (new model)
const TENANCY_RES = "0f000000-0000-4000-8000-0000000000ac"; // residential tenancy

const MONTH = "2026-06";
const DUE   = new Date(Date.UTC(2026, 5, 5)); // 2026-06-05

const ctx: OwnerLedgerActorCtx = {
  orgId: ORG,
  actorUserId: USER,
  actorRole: "admin",
  ip: "127.0.0.1",
  userAgent: "vitest",
};

async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  await db.ownerLedgerEntry.deleteMany({ where: org });
  await db.charge.deleteMany({ where: org });
  await db.tenancy.deleteMany({ where: org });
  await db.carpark.deleteMany({ where: org }); // must precede listing/apartment/party deletes
  await db.listing.deleteMany({ where: org });
  await db.apartment.deleteMany({ where: org });
  await db.property.deleteMany({ where: org });
  await db.auditLog.deleteMany({ where: org });
  await db.user.deleteMany({ where: { id: USER } });
  await db.partyRole.deleteMany({ where: org });
  await db.party.deleteMany({ where: org });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function seed() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG,
      name: "Carpark Split Org",
      slug: "carpark-split-org-44",
      status: "active",
      defaultCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur",
      locale: "en-MY",
      subscriptionPlan: "free",
    },
  });

  for (const [id, name] of [
    [OPERATOR, "Operator"],
    [OWNER_RES, "Owner B (residential)"],
    [OWNER_CP, "Owner A (carpark bay)"],
    [TENANT, "Cross-unit Tenant"],
  ] as const) {
    await db.party.create({
      data: { id, organizationId: ORG, displayName: name, partyType: "individual", status: "active" },
    });
  }

  await db.user.create({
    data: {
      id: USER,
      organizationId: ORG,
      email: "carpark-split44-operator@example.com",
      fullName: "Operator",
      status: "active",
      role: "admin",
      userType: "operator",
      partyId: OPERATOR,
    },
  });

  await db.property.create({
    data: {
      id: PROPERTY,
      organizationId: ORG,
      name: "Carpark Split Property",
      propertyCode: "CP-SPLIT44-P1",
      propertyType: "apartment",
      addressLine1: "1 Split St",
      city: "KL",
      country: "MY",
      status: "active",
      publishStatus: "draft",
    },
  });

  // Residential apartment + listing (owned by OWNER_RES).
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

  // Home apartment for the carpark bay (owned by OWNER_CP via Carpark.ownerPartyId).
  await db.apartment.create({
    data: { id: APT_CP, organizationId: ORG, propertyId: PROPERTY, unitCode: "A-CP-145", listingMode: "WHOLE" },
  });

  // Carpark bay — new model (Carpark entity, NOT a Listing).
  await db.carpark.create({
    data: {
      id: CARPARK,
      organizationId: ORG,
      propertyId: PROPERTY,
      apartmentId: APT_CP,
      ownerPartyId: OWNER_CP,
      label: "P-145",
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
      tenancyCode: "CP-SPLIT44-RES",
      status: "active",
      billingStatus: "current",
      startDate: new Date("2026-01-01T00:00:00.000Z"),
      monthlyRentAmount: "1500",
    },
  });

  // Rent charge — residential room (billed to the tenant, unitId set, carparkId null).
  await db.charge.create({
    data: {
      organizationId: ORG,
      chargeNumber: "CP-SPLIT44-RENT-RES",
      tenancyId: TENANCY_RES,
      unitId: UNIT_RES,
      partyId: TENANT,
      chargeType: "rent",
      status: "posted",
      dueDate: DUE,
      amount: "1500.00",
      currency: "MYR",
      outstandingAmount: "1500.00", // unpaid → collected = 0
    },
  });

  // Carpark charge — bay rent (carparkId set, unitId:null — new model).
  // This charge is INVISIBLE to Source-1's unitId-IN-unitIds fetch;
  // Task 4.4's Source-5 block picks it up via carparkId.
  await db.charge.create({
    data: {
      organizationId: ORG,
      chargeNumber: "CP-SPLIT44-CARPARK",
      carparkId: CARPARK,
      unitId: null,
      partyId: TENANT,
      chargeType: "carpark",
      status: "paid",
      dueDate: DUE,
      amount: "150.00",
      currency: "MYR",
      outstandingAmount: "0.00", // fully paid → collected = 150
    },
  });
}

describe.skipIf(!RUN)("Task 4.4 — carpark money-split (new model, integration)", () => {
  beforeAll(async () => {
    await cleanup();
    await seed();
  });
  afterAll(cleanup);

  it("routes carpark rent to the bay owner's ledger (carpark_income), room rent to the room owner's ledger (rental_income) — no cross-contamination", async () => {
    const db = getDb();

    const resSync = await syncMonthService(ctx, { ownerPartyId: OWNER_RES, month: MONTH });
    const cpSync  = await syncMonthService(ctx, { ownerPartyId: OWNER_CP,  month: MONTH });
    expect(resSync.ok).toBe(true);
    expect(cpSync.ok).toBe(true);

    // Residential owner: exactly one rental_income row for the room.
    const resRows = await db.ownerLedgerEntry.findMany({
      where: { organizationId: ORG, ownerPartyId: OWNER_RES, category: "rental_income" },
    });
    expect(resRows).toHaveLength(1);
    expect(resRows[0]!.listingId).toBe(UNIT_RES);
    expect(resRows[0]!.amount.toString()).toBe("0");   // 1500 − 1500 outstanding = 0
    expect(resRows[0]!.direction).toBe("income");
    expect(resRows[0]!.sourceType).toBe("rent");

    // Carpark owner: exactly one carpark_income row for the bay (Source 5, new model).
    const cpRows = await db.ownerLedgerEntry.findMany({
      where: { organizationId: ORG, ownerPartyId: OWNER_CP, category: "carpark_income" },
    });
    expect(cpRows).toHaveLength(1);
    expect(cpRows[0]!.listingId).toBeNull();           // no Listing — it's a Carpark
    expect(cpRows[0]!.apartmentId).toBe(APT_CP);       // property context from Carpark
    expect(cpRows[0]!.amount.toString()).toBe("150");  // 150 − 0 outstanding = 150 collected
    expect(cpRows[0]!.direction).toBe("income");
    expect(cpRows[0]!.sourceType).toBe("carpark");     // distinct from "rent"
    expect(cpRows[0]!.paymentStatus).toBe("paid");

    // Clean split: neither owner's ledger bleeds into the other's.
    const resCarparkRows = await db.ownerLedgerEntry.findMany({
      where: { organizationId: ORG, ownerPartyId: OWNER_RES, category: "carpark_income" },
    });
    expect(resCarparkRows).toHaveLength(0);

    const cpRentalRows = await db.ownerLedgerEntry.findMany({
      where: { organizationId: ORG, ownerPartyId: OWNER_CP, category: "rental_income" },
    });
    expect(cpRentalRows).toHaveLength(0);
  });

  it("re-sync is idempotent — running syncMonthService twice does not duplicate rows", async () => {
    const db = getDb();
    // Both owners already synced in the previous test. Run again.
    const res2 = await syncMonthService(ctx, { ownerPartyId: OWNER_CP, month: MONTH });
    expect(res2.ok).toBe(true);

    const cpRows = await db.ownerLedgerEntry.findMany({
      where: { organizationId: ORG, ownerPartyId: OWNER_CP, category: "carpark_income" },
    });
    // Still exactly one row (updated, not duplicated).
    expect(cpRows).toHaveLength(1);
  });
});
