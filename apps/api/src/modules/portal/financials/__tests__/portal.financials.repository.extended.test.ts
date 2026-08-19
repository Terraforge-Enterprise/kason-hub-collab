/**
 * Repository composition tests for getFinancialsExtended (Task E1).
 *
 * Verifies the ADDITIVE breakdown is computed correctly by COMPOSING around the
 * existing getFinancials (never rewriting it) + reusing getCollectedRentForOwnerMonth
 * (D1). `@kason/db` is mocked so every query the composition makes is served from
 * fixtures; the real money math (toCents / summarizeStatement / centsToString) runs.
 *
 * Owner scope: the statement query carries ownerPartyId === session.partyId AND the
 * owner+org idempotency key, so an owner can never resolve another owner's statement.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── DB mock ─────────────────────────────────────────────────────────────────
// One shared mock object; each test sets the return values for the queries the
// composition issues (landlordTenancy + charge for the base & collected-rent
// resolution, invoice for the statement, managementFeeConfig for the fee label).
const dbMock = {
  listing: { findMany: vi.fn() },
  charge: { findMany: vi.fn() },
  invoice: { findFirst: vi.fn() },
  managementFeeConfig: { findFirst: vi.fn() },
};

vi.mock("@kason/db", () => ({
  getDb: () => dbMock,
}));

import { getFinancials, getFinancialsExtended, getCollectedRentForOwnerMonth } from "../portal.financials.repository";

const ORG = "org-1";
const OWNER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MONTH = "2026-06";

// Owner re-point: owner→units resolves per-unit via Listing.ownerPartyId.
// listing.findMany is called by getFinancials AND getCollectedRentForOwnerMonth,
// each selecting a slightly different shape. We return a superset FLAT row that
// satisfies both selections (extra keys are harmless; Prisma `select` is a fixture
// contract here).
function listingRows() {
  return [
    {
      id: "unit-1",
      occupancyStatus: "occupied",
      apartment: {
        unitCode: "A-1",
        propertyId: "prop-1",
        property: { name: "Annex Residence" },
      },
      tenancies: [
        {
          id: "ten-1",
          tenantPartyId: "tenant-1",
          tenantParty: { displayName: "Tan" },
          monthlyRentAmount: "2000.00",
        },
      ],
    },
  ];
}

// rent charges for unit-1 this month: amount 2000, outstanding 500 → collected 1500.
function rentCharges() {
  return [{ unitId: "unit-1", amount: "2000.00", outstandingAmount: "500.00", status: "posted" }];
}

beforeEach(() => {
  vi.clearAllMocks();
  // getFinancials issues: listing.findMany then charge.findMany.
  // getCollectedRentForOwnerMonth issues: listing.findMany then charge.findMany.
  // Same fixtures satisfy both — use mockResolvedValue (not Once) so order-independence holds.
  dbMock.listing.findMany.mockResolvedValue(listingRows());
  dbMock.charge.findMany.mockResolvedValue(rentCharges());
});

describe("getFinancialsExtended — composition with a statement", () => {
  it("layers mgmtFeeDeducted/expenses/netRemittance + feeBreakdown onto the base shape", async () => {
    // Owner A's owner_statement: mgmt-fee base 200 + cleaning 100, SST 16.
    dbMock.invoice.findFirst.mockResolvedValue({
      sstAmount: "16.00",
      charges: [
        { chargeType: "management_fee", amount: "200.00", unitId: "unit-1" },
        { chargeType: "cleaning", amount: "100.00", unitId: "unit-1" },
      ],
    });
    dbMock.managementFeeConfig.findFirst.mockResolvedValue({ feeType: "percent", feeValue: "10.00" });

    const result = await getFinancialsExtended({ partyId: OWNER_A, orgId: ORG }, MONTH);

    // Base shape is preserved (collectedRent 1500 from the rent charge).
    expect(result.month).toBe("2026-06");
    expect(result.totals.expectedRent).toBe(2000);
    expect(result.totals.collectedRent).toBe(1500);

    // Additive breakdown.
    expect(result.totals.mgmtFeeDeducted).toBe("200.00");
    expect(result.totals.expenses).toBe("100.00"); // cleaning only (fee excluded)
    // netRemittance = collected 1500 − (200 + 100 + 16 SST) = 1184.00
    expect(result.totals.netRemittance).toBe("1184.00");
    expect(result.feeBreakdown).toEqual({
      percentLabel: "10%",
      base: "200.00",
      sst: "16.00",
      total: "216.00",
    });

    // Owner scope: the statement query is pinned to owner A + the owner+org key.
    expect(dbMock.invoice.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: ORG,
          ownerPartyId: OWNER_A,
          invoiceType: "owner_statement",
          idempotencyKey: `owner:${OWNER_A}:${MONTH}`,
        }),
      }),
    );
  });

  it("no statement for the month → zero breakdown, feeBreakdown null, net == collected", async () => {
    dbMock.invoice.findFirst.mockResolvedValue(null);

    const result = await getFinancialsExtended({ partyId: OWNER_A, orgId: ORG }, MONTH);

    expect(result.totals.mgmtFeeDeducted).toBe("0.00");
    expect(result.totals.expenses).toBe("0.00");
    expect(result.totals.netRemittance).toBe("1500.00"); // nothing deducted
    expect(result.feeBreakdown).toBeNull();
    // No fee config lookup when there is no statement.
    expect(dbMock.managementFeeConfig.findFirst).not.toHaveBeenCalled();
  });

  it("statement with no management-fee line → feeBreakdown null, expenses carries the lines", async () => {
    dbMock.invoice.findFirst.mockResolvedValue({
      sstAmount: "0.00",
      charges: [{ chargeType: "cleaning", amount: "100.00", unitId: "unit-1" }],
    });

    const result = await getFinancialsExtended({ partyId: OWNER_A, orgId: ORG }, MONTH);

    expect(result.totals.mgmtFeeDeducted).toBe("0.00");
    expect(result.totals.expenses).toBe("100.00");
    expect(result.totals.netRemittance).toBe("1400.00"); // 1500 − 100
    expect(result.feeBreakdown).toBeNull();
  });

  it("excludes void lines from the breakdown (query filters status not void)", async () => {
    // The statement query already filters status not "void" at the DB layer; the
    // returned charges are the surviving lines only. Assert the query carries it.
    dbMock.invoice.findFirst.mockResolvedValue({
      sstAmount: "16.00",
      charges: [{ chargeType: "management_fee", amount: "200.00", unitId: "unit-1" }],
    });
    dbMock.managementFeeConfig.findFirst.mockResolvedValue({ feeType: "fixed", feeValue: "200.00" });

    await getFinancialsExtended({ partyId: OWNER_A, orgId: ORG }, MONTH);

    const call = dbMock.invoice.findFirst.mock.calls[0]![0] as {
      select: { charges: { where: { status: { not: string } } } };
    };
    expect(call.select.charges.where).toEqual({ status: { not: "void" } });
  });

  it("fixed-fee config produces a 'Fixed' percentLabel", async () => {
    dbMock.invoice.findFirst.mockResolvedValue({
      sstAmount: "16.00",
      charges: [{ chargeType: "management_fee", amount: "200.00", unitId: "unit-1" }],
    });
    dbMock.managementFeeConfig.findFirst.mockResolvedValue({ feeType: "fixed", feeValue: "200.00" });

    const result = await getFinancialsExtended({ partyId: OWNER_A, orgId: ORG }, MONTH);
    expect(result.feeBreakdown?.percentLabel).toBe("Fixed");
  });
});

describe("portal financials — under-management gating (R4)", () => {
  it("getFinancials applies underManagement filter on the default (no propertyId) load", async () => {
    dbMock.listing.findMany.mockResolvedValue([]);
    await getFinancials({ partyId: OWNER_A, orgId: ORG });
    expect(dbMock.listing.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ apartment: expect.objectContaining({ underManagement: true }) }),
      }),
    );
  });
  it("getFinancials keeps propertyId AND underManagement when filtered", async () => {
    dbMock.listing.findMany.mockResolvedValue([]);
    await getFinancials({ partyId: OWNER_A, orgId: ORG }, MONTH, "prop-1");
    expect(dbMock.listing.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ apartment: expect.objectContaining({ underManagement: true, propertyId: "prop-1" }) }),
      }),
    );
  });
  it("getCollectedRentForOwnerMonth applies the underManagement filter", async () => {
    dbMock.listing.findMany.mockResolvedValue([]);
    await getCollectedRentForOwnerMonth(ORG, OWNER_A, MONTH);
    expect(dbMock.listing.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ apartment: expect.objectContaining({ underManagement: true }) }),
      }),
    );
  });
});
