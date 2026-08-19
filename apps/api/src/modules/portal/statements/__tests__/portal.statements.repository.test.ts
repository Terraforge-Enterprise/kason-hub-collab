/**
 * Repository tests for the owner-portal own-statements surface (Task E3).
 *
 * `@kason/db` is mocked so every query the repository issues is served from
 * fixtures; the real money math (summarizeStatement / collected-rent helper) runs.
 *
 * Owner scope is the load-bearing contract: BOTH queries carry
 *   ownerPartyId === scope.partyId  AND  organizationId === scope.orgId
 *   AND invoiceType === "owner_statement"
 * so an owner can never resolve another owner's statement. These tests assert the
 * exact WHERE clause the queries are issued with.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = {
  invoice: { findMany: vi.fn(), findFirst: vi.fn() },
  listing: { findMany: vi.fn() },
  charge: { findMany: vi.fn() },
  managementFeeConfig: { findFirst: vi.fn() },
};

vi.mock("@kason/db", () => ({
  getDb: () => dbMock,
}));

import {
  listOwnStatements,
  findOwnStatementPdfKey,
  getOwnStatementDetail,
} from "../portal.statements.repository";

const ORG = "org-1";
const OWNER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const scope = { partyId: OWNER_A, orgId: ORG };

beforeEach(() => {
  vi.clearAllMocks();
  // Default: owner owns one occupied unit collecting 1500 rent this month — used
  // by getCollectedRentForOwnerMonth, which now resolves the owner's units via a
  // FLAT listing.findMany keyed by Listing.ownerPartyId (+ charge query).
  dbMock.listing.findMany.mockResolvedValue([
    { id: "unit-1", tenancies: [{ id: "ten-1" }] },
  ]);
  dbMock.charge.findMany.mockResolvedValue([
    { amount: "2000.00", outstandingAmount: "500.00" }, // collected 1500
  ]);
});

describe("listOwnStatements", () => {
  it("scopes the query to owner+org+owner_statement and filters by month", async () => {
    dbMock.invoice.findMany.mockResolvedValue([]);
    await listOwnStatements(scope, "2026-06");

    const arg = dbMock.invoice.findMany.mock.calls[0]![0];
    expect(arg.where.organizationId).toBe(ORG);
    expect(arg.where.ownerPartyId).toBe(OWNER_A);
    expect(arg.where.invoiceType).toBe("owner_statement");
    // month → first-of-month UTC periodMonth filter.
    expect(arg.where.periodMonth).toEqual(new Date(Date.UTC(2026, 5, 1)));
  });

  it("omits the periodMonth filter when no month is given", async () => {
    dbMock.invoice.findMany.mockResolvedValue([]);
    await listOwnStatements(scope);
    const arg = dbMock.invoice.findMany.mock.calls[0]![0];
    expect(arg.where).not.toHaveProperty("periodMonth");
  });

  it("maps rows + computes net remittance (collected 1500 − fee 200 − SST 16 − cleaning 100 = 1184)", async () => {
    dbMock.invoice.findMany.mockResolvedValue([
      {
        id: "stmt-1",
        periodMonth: new Date(Date.UTC(2026, 5, 1)),
        status: "approved",
        totalAmount: "316.00",
        sstAmount: "16.00",
        charges: [
          { chargeType: "management_fee", amount: "200.00" },
          { chargeType: "cleaning", amount: "100.00" },
        ],
      },
    ]);

    const items = await listOwnStatements(scope, "2026-06");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "stmt-1",
      periodMonth: "2026-06-01T00:00:00.000Z",
      status: "approved",
      totalAmount: "316.00",
      netRemittance: "1184.00",
    });
  });

  it("rejects a malformed month before querying", async () => {
    await expect(listOwnStatements(scope, "2026/06")).rejects.toThrow("Invalid month format");
    expect(dbMock.invoice.findMany).not.toHaveBeenCalled();
  });
});

describe("findOwnStatementPdfKey", () => {
  it("scopes the lookup to owner+org+owner_statement (cross-owner can never match)", async () => {
    dbMock.invoice.findFirst.mockResolvedValue({ pdfKey: "k.pdf" });
    await findOwnStatementPdfKey(scope, "stmt-1");

    const arg = dbMock.invoice.findFirst.mock.calls[0]![0];
    expect(arg.where).toEqual({
      id: "stmt-1",
      organizationId: ORG,
      ownerPartyId: OWNER_A,
      invoiceType: "owner_statement",
    });
  });

  it("returns the pdfKey when the OWN statement has one", async () => {
    dbMock.invoice.findFirst.mockResolvedValue({ pdfKey: "owner-statements/o/x.pdf" });
    const res = await findOwnStatementPdfKey(scope, "stmt-1");
    expect(res).toEqual({ pdfKey: "owner-statements/o/x.pdf" });
  });

  it("returns { pdfKey: null } when the OWN statement has no pdf yet", async () => {
    dbMock.invoice.findFirst.mockResolvedValue({ pdfKey: null });
    const res = await findOwnStatementPdfKey(scope, "stmt-1");
    expect(res).toEqual({ pdfKey: null });
  });

  it("returns null when the id is not the owner's (cross-owner / cross-org / unknown)", async () => {
    // The owner+org WHERE matches no row for another owner's statement id.
    dbMock.invoice.findFirst.mockResolvedValue(null);
    const res = await findOwnStatementPdfKey({ partyId: OWNER_B, orgId: ORG }, "stmt-of-owner-A");
    expect(res).toBeNull();
  });
});

describe("getOwnStatementDetail", () => {
  // A statement: mgmt-fee base 200 + cleaning 100, statement SST 16.
  function detailStatementRow() {
    return {
      id: "stmt-1",
      periodMonth: new Date(Date.UTC(2026, 5, 1)),
      status: "approved",
      currency: "MYR",
      totalAmount: "316.00",
      sstAmount: "16.00",
      charges: [
        {
          id: "c-fee",
          chargeNumber: "OSC-202606-0001",
          chargeType: "management_fee",
          unitId: "unit-1",
          description: "Management fee",
          amount: "200.00",
          currency: "MYR",
          status: "posted",
        },
        {
          id: "c-clean",
          chargeNumber: "OSC-202606-0002",
          chargeType: "cleaning",
          unitId: "unit-1",
          description: "Cleaning",
          amount: "100.00",
          currency: "MYR",
          status: "posted",
        },
      ],
    };
  }

  it("scopes the lookup to owner+org+owner_statement + excludes void lines", async () => {
    dbMock.invoice.findFirst.mockResolvedValue(detailStatementRow());
    dbMock.managementFeeConfig.findFirst.mockResolvedValue({ feeType: "percent", feeValue: "10" });

    await getOwnStatementDetail(scope, "stmt-1");

    const arg = dbMock.invoice.findFirst.mock.calls[0]![0];
    expect(arg.where).toEqual({
      id: "stmt-1",
      organizationId: ORG,
      ownerPartyId: OWNER_A,
      invoiceType: "owner_statement",
    });
    // Only non-void child charges are selected for the detail.
    expect(arg.select.charges.where).toEqual({ status: { not: "void" } });
  });

  it("returns the statement + lines + totals (collected 1500 − fee 200 − SST 16 − cleaning 100 = 1184)", async () => {
    dbMock.invoice.findFirst.mockResolvedValue(detailStatementRow());
    dbMock.managementFeeConfig.findFirst.mockResolvedValue({ feeType: "percent", feeValue: "10" });

    const detail = await getOwnStatementDetail(scope, "stmt-1");
    expect(detail).not.toBeNull();
    expect(detail!.id).toBe("stmt-1");
    expect(detail!.periodMonth).toBe("2026-06-01T00:00:00.000Z");
    expect(detail!.status).toBe("approved");
    expect(detail!.totalAmount).toBe("316.00");
    expect(detail!.sstAmount).toBe("16.00");
    expect(detail!.collectedRent).toBe("1500.00");
    expect(detail!.totalDeductions).toBe("316.00");
    expect(detail!.netRemittance).toBe("1184.00");
    // Lines are serialised (2dp amounts, no Decimal leak).
    expect(detail!.lines).toEqual([
      {
        id: "c-fee",
        chargeNumber: "OSC-202606-0001",
        chargeType: "management_fee",
        unitId: "unit-1",
        description: "Management fee",
        amount: "200.00",
        currency: "MYR",
        status: "posted",
      },
      {
        id: "c-clean",
        chargeNumber: "OSC-202606-0002",
        chargeType: "cleaning",
        unitId: "unit-1",
        description: "Cleaning",
        amount: "100.00",
        currency: "MYR",
        status: "posted",
      },
    ]);
    // feeBreakdown reflects the mgmt-fee line: base 200, SST 16, total 216, "10%".
    expect(detail!.feeBreakdown).toEqual({ percentLabel: "10%", base: "200.00", sst: "16.00", total: "216.00" });
  });

  it("feeBreakdown is null when the statement carries no management-fee line", async () => {
    dbMock.invoice.findFirst.mockResolvedValue({
      ...detailStatementRow(),
      sstAmount: null,
      charges: [
        {
          id: "c-clean",
          chargeNumber: "OSC-202606-0001",
          chargeType: "cleaning",
          unitId: "unit-1",
          description: "Cleaning",
          amount: "100.00",
          currency: "MYR",
          status: "posted",
        },
      ],
    });

    const detail = await getOwnStatementDetail(scope, "stmt-1");
    expect(detail!.feeBreakdown).toBeNull();
    // No fee config lookup is needed when there is no fee line.
    expect(dbMock.managementFeeConfig.findFirst).not.toHaveBeenCalled();
    // collected 1500 − cleaning 100 = 1400.
    expect(detail!.netRemittance).toBe("1400.00");
  });

  it("returns null when the id is not the owner's (cross-owner / cross-org / unknown)", async () => {
    // The owner+org+owner_statement WHERE matches no row for another owner's id.
    dbMock.invoice.findFirst.mockResolvedValue(null);
    const detail = await getOwnStatementDetail({ partyId: OWNER_B, orgId: ORG }, "stmt-of-owner-A");
    expect(detail).toBeNull();
    // No collected-rent / fee-config work is done for a statement that isn't ours.
    expect(dbMock.managementFeeConfig.findFirst).not.toHaveBeenCalled();
  });
});
