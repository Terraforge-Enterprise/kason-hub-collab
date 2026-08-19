import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OwnerBillingActorCtx } from "../owner-billing.types";

// Mirrors owner-statement-sections.test.ts: mock getDb, stub only the DB-hitting
// findDepositsCollectedInMonth (keep depositWindowEndOfMonth real by spreading the
// actual module).
vi.mock("@kason/db", () => ({ getDb: vi.fn() }));
vi.mock("../owner-billing.repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../owner-billing.repository")>();
  // findDepositsHeldForUnits defaults to empty — see owner-statement-sections.test.ts.
  return { ...actual, findDepositsCollectedInMonth: vi.fn(), findDepositsHeldForUnits: vi.fn(async () => []) };
});

import { getDb } from "@kason/db";
import { findDepositsCollectedInMonth } from "../owner-billing.repository";
import { assembleYannieStatement } from "../owner-statement-sections";

const ORG = "00000000-0000-0000-0000-000000000001";
const STMT_ID = "00000000-0000-0000-0000-000000000002";
const OWNER_ID = "00000000-0000-0000-0000-000000000003";
const LISTING_A = "00000000-0000-0000-0000-000000000004";
const LISTING_B = "00000000-0000-0000-0000-000000000005";

// Two apartments owned by the SAME owner.
const APT_1 = "apt-1"; // unitCode A-10-04 (whole unit)
const APT_2 = "apt-2"; // unitCode A-19-02 (other unit)

const ctx: OwnerBillingActorCtx = { orgId: ORG, actorUserId: "u1", actorRole: "admin" };

// Prisma Decimal-like
const dec = (s: string) => ({ toString: () => s });

const PERIOD = new Date("2026-06-01T00:00:00.000Z");

// Master datasets: one income ledger row + one listing per apartment. The mocks
// below honour the `where.apartmentId` filter, faithfully simulating Prisma — so
// the test actually proves the assembler PASSES apartmentId into both queries.
const ALL_LEDGER = [
  {
    direction: "income",
    category: "rental_income",
    amount: dec("2000.00"),
    sstAmount: null,
    includeInPayout: false,
    taxCategory: "not_applicable",
    propertyId: "prop-1",
    apartmentId: APT_1,
    listingId: LISTING_A,
    statementMonth: PERIOD,
    paymentStatus: "paid",
    description: null,
    remarks: null,
  },
  {
    direction: "income",
    category: "rental_income",
    amount: dec("1800.00"),
    sstAmount: null,
    includeInPayout: false,
    taxCategory: "not_applicable",
    propertyId: "prop-1",
    apartmentId: APT_2,
    listingId: LISTING_B,
    statementMonth: PERIOD,
    paymentStatus: "paid",
    description: null,
    remarks: null,
  },
];

const ALL_LISTINGS = [
  {
    id: LISTING_A,
    apartmentId: APT_1,
    rentalRate: dec("2000.00"),
    apartment: {
      unitCode: "A-10-04",
      propertyId: "prop-1",
      property: { name: "PV9 Residences" },
    },
    tenancies: [
      {
        startDate: new Date("2026-01-01"),
        endDate: null,
        monthlyRentAmount: dec("2000.00"),
        depositAmount: dec("4000.00"),
        tenantParty: { displayName: "John Tenant" },
      },
    ],
  },
  {
    id: LISTING_B,
    apartmentId: APT_2,
    rentalRate: dec("1800.00"),
    apartment: {
      unitCode: "A-19-02",
      propertyId: "prop-1",
      property: { name: "PV9 Residences" },
    },
    tenancies: [
      {
        startDate: new Date("2026-02-01"),
        endDate: null,
        monthlyRentAmount: dec("1800.00"),
        depositAmount: dec("3600.00"),
        tenantParty: { displayName: "Jane Tenant" },
      },
    ],
  },
];

describe("assembleYannieStatement — apartment filter (Task 5)", () => {
  let dbMock: {
    invoice: { findFirst: ReturnType<typeof vi.fn> };
    party: { findFirst: ReturnType<typeof vi.fn> };
    ownerLedgerEntry: { findMany: ReturnType<typeof vi.fn> };
    listing: { findMany: ReturnType<typeof vi.fn> };
    managementFeeConfig: { findMany: ReturnType<typeof vi.fn> };
    charge: { findMany: ReturnType<typeof vi.fn> };
    documentSeries: { findFirst: ReturnType<typeof vi.fn> };
    billingDocumentLine: { findMany: ReturnType<typeof vi.fn> };
  };

  beforeEach(() => {
    dbMock = {
      invoice: { findFirst: vi.fn() },
      party: { findFirst: vi.fn() },
      ownerLedgerEntry: { findMany: vi.fn() },
      listing: { findMany: vi.fn() },
      managementFeeConfig: { findMany: vi.fn() },
      // Task-6 charged-amount lookup + the derived tenant-paid-expense scan.
      charge: { findMany: vi.fn() },
      // §5 owner-receivable itemisation reads the IVOWN series + its document lines.
      documentSeries: { findFirst: vi.fn() },
      billingDocumentLine: { findMany: vi.fn() },
    };
    (getDb as ReturnType<typeof vi.fn>).mockReturnValue(dbMock);
    (findDepositsCollectedInMonth as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    // No IVOWN series/lines by default ⇒ §5 gains no owner-receivable rows, so every
    // pre-existing expectation in these suites stays byte-identical.
    dbMock.documentSeries.findFirst.mockResolvedValue(null);
    dbMock.billingDocumentLine.findMany.mockResolvedValue([]);
    dbMock.charge.findMany.mockResolvedValue([]);

    dbMock.managementFeeConfig.findMany.mockResolvedValue([
      {
        propertyId: null,
        feeType: "percent",
        feeValue: dec("10"),
        capAmount: null,
        sstPercent: dec("8"),
        updatedAt: PERIOD,
      },
    ]);

    dbMock.party.findFirst.mockResolvedValue({
      displayName: "Ahmad Owner",
      bankName: "Maybank",
      bankAccountHolder: "Ahmad bin Ali",
      bankAccountNumber: "12345678",
    });

    // Honour the apartmentId where-filter (simulate Prisma). When the assembler
    // does NOT pass apartmentId (null path), return everything verbatim.
    dbMock.ownerLedgerEntry.findMany.mockImplementation(async (args: any) => {
      const apt = args?.where?.apartmentId;
      return apt ? ALL_LEDGER.filter((r) => r.apartmentId === apt) : ALL_LEDGER;
    });
    dbMock.listing.findMany.mockImplementation(async (args: any) => {
      const apt = args?.where?.apartmentId;
      return apt ? ALL_LISTINGS.filter((l) => l.apartmentId === apt) : ALL_LISTINGS;
    });
  });

  it("Case A: invoice.apartmentId set ⇒ occupancy + income cover ONLY that apartment", async () => {
    dbMock.invoice.findFirst.mockResolvedValue({
      id: STMT_ID,
      ownerPartyId: OWNER_ID,
      periodMonth: PERIOD,
      apartmentId: APT_1,
    });

    const result = await assembleYannieStatement(ctx, STMT_ID);
    expect(result).not.toBeNull();

    const occCodes = result!.occupancy.rows.map((r) => r.unitCode);
    expect(occCodes).toContain("A-10-04");
    expect(occCodes).not.toContain("A-19-02");
    expect(result!.occupancy.rows).toHaveLength(1);

    const incCodes = result!.incomeBreakdown.rows.map((r) => r.unitCode);
    expect(incCodes).toContain("A-10-04");
    expect(incCodes).not.toContain("A-19-02");
    expect(result!.incomeBreakdown.rows).toHaveLength(1);
  });

  it("Case A: ledger + listing queries are scoped to the invoice apartmentId", async () => {
    dbMock.invoice.findFirst.mockResolvedValue({
      id: STMT_ID,
      ownerPartyId: OWNER_ID,
      periodMonth: PERIOD,
      apartmentId: APT_1,
    });

    await assembleYannieStatement(ctx, STMT_ID);

    expect(dbMock.ownerLedgerEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ apartmentId: APT_1 }) }),
    );
    expect(dbMock.listing.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ apartmentId: APT_1 }) }),
    );
  });

  it("Case B: invoice.apartmentId null ⇒ BOTH apartments appear (verbatim, all owner listings)", async () => {
    dbMock.invoice.findFirst.mockResolvedValue({
      id: STMT_ID,
      ownerPartyId: OWNER_ID,
      periodMonth: PERIOD,
      apartmentId: null,
    });

    const result = await assembleYannieStatement(ctx, STMT_ID);
    expect(result).not.toBeNull();

    const occCodes = result!.occupancy.rows.map((r) => r.unitCode);
    expect(occCodes).toContain("A-10-04");
    expect(occCodes).toContain("A-19-02");
    expect(result!.occupancy.rows).toHaveLength(2);

    const incCodes = result!.incomeBreakdown.rows.map((r) => r.unitCode);
    expect(incCodes).toContain("A-10-04");
    expect(incCodes).toContain("A-19-02");
    expect(result!.incomeBreakdown.rows).toHaveLength(2);

    // Null path must NOT inject an apartmentId filter into either query.
    expect(dbMock.ownerLedgerEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.not.objectContaining({ apartmentId: expect.anything() }) }),
    );
    expect(dbMock.listing.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.not.objectContaining({ apartmentId: expect.anything() }) }),
    );
  });
});
