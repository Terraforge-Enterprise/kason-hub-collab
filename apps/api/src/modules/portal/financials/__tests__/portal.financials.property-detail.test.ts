/**
 * Repository tests for the owner-portal financials PROPERTY-DETAIL path (Task HF1).
 *
 * `getFinancials(scope, month, propertyId)` powers BOTH the all-properties rollup
 * AND the single-property detail the owner-reports page drills into. This file pins
 * the detail contract (POST owner re-point — owner→units resolves per-unit via
 * Listing.ownerPartyId, NOT property-level LandlordTenancy):
 *   • the query is a flat listing.findMany keyed by ownerPartyId === scope.partyId
 *     AND organizationId === scope.orgId, so an owner can only ever resolve THEIR
 *     OWN units — units owned by someone else (or in another org) are excluded;
 *   • the optional propertyId filter is pushed into the listing WHERE as
 *     apartment:{ propertyId } — narrowing to one of the owner's properties;
 *   • the response carries exactly that one property's units + totals.
 *
 * `@kason/db` is mocked so every query is served from fixtures; the real rollup
 * math (expected/collected/collectionRate) runs.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = {
  listing: { findMany: vi.fn() },
  charge: { findMany: vi.fn() },
};

vi.mock("@kason/db", () => ({
  getDb: () => dbMock,
}));

import { getFinancials } from "../portal.financials.repository";

const ORG = "org-1";
const OWNER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROP_1 = "prop-1";
const MONTH = "2026-06";
const scope = { partyId: OWNER_A, orgId: ORG };

// One owner property with a single occupied unit collecting partial rent this month
// — the FLAT listing row shape getFinancials now reads (apartment carries the
// property; each listing carries its own active tenancy).
function listingRows() {
  return [
    {
      id: "unit-1",
      occupancyStatus: "occupied",
      apartment: {
        unitCode: "A-1",
        propertyId: PROP_1,
        property: { name: "Annex Residence" },
      },
      tenancies: [
        {
          tenantPartyId: "tenant-1",
          tenantParty: { displayName: "Tan" },
          monthlyRentAmount: "2000.00",
        },
      ],
    },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.listing.findMany.mockResolvedValue(listingRows());
  // unit-1 rent charge this month: amount 2000, outstanding 500 → collected 1500.
  dbMock.charge.findMany.mockResolvedValue([
    { unitId: "unit-1", amount: "2000.00", outstandingAmount: "500.00", status: "posted" },
  ]);
});

describe("getFinancials — single-property detail (owner-scoped)", () => {
  it("pushes the propertyId filter into the OWNER-scoped listing WHERE (apartment:{propertyId})", async () => {
    await getFinancials(scope, MONTH, PROP_1);

    const arg = dbMock.listing.findMany.mock.calls[0]![0];
    // OWNER scope is load-bearing: ownerPartyId === the session owner, org === session org.
    expect(arg.where.ownerPartyId).toBe(OWNER_A);
    expect(arg.where.organizationId).toBe(ORG);
    expect(arg.where.listingStatus).toEqual({ not: "archived" });
    // The single-property filter is applied via the listing's apartment → property,
    // alongside the R4 under-management gate (always present, unconditionally).
    expect(arg.where.apartment).toEqual({ underManagement: true, propertyId: PROP_1 });
  });

  it("returns ONLY the requested property's rollup (units + totals)", async () => {
    const result = await getFinancials(scope, MONTH, PROP_1);

    expect(result.month).toBe(MONTH);
    expect(result.properties).toHaveLength(1);
    const property = result.properties[0]!;
    expect(property.id).toBe(PROP_1);
    expect(property.name).toBe("Annex Residence");
    expect(property.totalUnits).toBe(1);
    expect(property.occupiedUnits).toBe(1);
    // expected = monthly rent 2000; collected = amount − outstanding = 1500.
    expect(property.expectedRent).toBe(2000);
    expect(property.collectedRent).toBe(1500);
    // A "posted" rent charge with outstanding > 0 flags the unit overdue (the
    // rollup treats unpaid-but-posted as overdue, not partial).
    expect(property.units).toEqual([
      { unitCode: "A-1", tenantName: "Tan", expectedRent: 2000, paidAmount: 1500, status: "overdue" },
    ]);
    // Totals roll up just this property.
    expect(result.totals.expectedRent).toBe(2000);
    expect(result.totals.collectedRent).toBe(1500);
    expect(result.totals.collectionRate).toBe(0.75);
  });

  it("a property NOT owned by the caller resolves to an empty rollup (owner+propertyId WHERE never matches)", async () => {
    // The ownerPartyId+org+apartment:{propertyId} WHERE matches no Listing the
    // caller owns in that property → no units → no properties → all-zero totals.
    // The caller can never see another owner's property detail.
    dbMock.listing.findMany.mockResolvedValue([]);
    dbMock.charge.findMany.mockResolvedValue([]);

    const result = await getFinancials(scope, MONTH, "prop-not-mine");
    expect(result.properties).toEqual([]);
    expect(result.totals).toEqual({ expectedRent: 0, collectedRent: 0, collectionRate: 0 });
    // The WHERE was still owner-scoped with the requested propertyId (via apartment),
    // alongside the R4 under-management gate (always present, unconditionally).
    const arg = dbMock.listing.findMany.mock.calls[0]![0];
    expect(arg.where.ownerPartyId).toBe(OWNER_A);
    expect(arg.where.apartment).toEqual({ underManagement: true, propertyId: "prop-not-mine" });
  });
});
