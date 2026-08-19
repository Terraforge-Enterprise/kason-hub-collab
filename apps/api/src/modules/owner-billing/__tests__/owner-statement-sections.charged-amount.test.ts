/**
 * Task 6: charged income amount — failing tests first (RED).
 *
 * Verifies that income breakdown rows expose `chargedAmount` (the BILLED amount)
 * separately from `amount` (the COLLECTED figure that drives all payout math).
 *
 * Run:
 *   cd .../six-ux-fixes/apps/api && npx vitest run owner-statement-sections.charged-amount
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OwnerBillingActorCtx } from "../owner-billing.types";

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
const APT_1 = "apt-1";
const CHARGE_A = "charge-aaaa-0000-0000-000000000001";
const CHARGE_B = "charge-bbbb-0000-0000-000000000002";

const ctx: OwnerBillingActorCtx = { orgId: ORG, actorUserId: "u1", actorRole: "admin" };
const dec = (s: string) => ({ toString: () => s });
const PERIOD = new Date("2026-06-01T00:00:00.000Z");

function makeLedgerRow(overrides: Record<string, unknown> = {}) {
  return {
    direction: "income",
    category: "rental_income",
    amount: dec("0.00"),
    sstAmount: null,
    includeInPayout: true,
    taxCategory: "not_applicable",
    propertyId: "prop-1",
    apartmentId: APT_1,
    listingId: LISTING_A,
    statementMonth: PERIOD,
    paymentStatus: "pending",
    payeeName: null,
    paidOnBehalfRef: null,
    paidOnBehalfDate: null,
    description: null,
    remarks: null,
    sourceChargeId: CHARGE_A,
    ...overrides,
  };
}

function makeListing(id = LISTING_A, unitCode = "A-10-04") {
  return {
    id,
    apartmentId: APT_1,
    rentalRate: dec("500.00"),
    unitKind: null,
    apartment: {
      unitCode,
      propertyId: "prop-1",
      property: { name: "PV9 Residences" },
    },
    tenancies: [
      {
        startDate: new Date("2026-01-01"),
        endDate: null,
        monthlyRentAmount: dec("500.00"),
        depositAmount: dec("1000.00"),
        tenantParty: { displayName: "John Tenant" },
      },
    ],
  };
}

describe("assembleYannieStatement — charged income amount (Task 6)", () => {
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

    dbMock.invoice.findFirst.mockResolvedValue({
      id: STMT_ID,
      ownerPartyId: OWNER_ID,
      periodMonth: PERIOD,
      apartmentId: null,
    });
    dbMock.party.findFirst.mockResolvedValue({
      displayName: "Ahmad Owner",
      bankName: "Maybank",
      bankAccountHolder: "Ahmad bin Ali",
      bankAccountNumber: "12345678",
    });
    // No management fee for simplicity — gross income === payout.
    dbMock.managementFeeConfig.findMany.mockResolvedValue([]);
    dbMock.listing.findMany.mockResolvedValue([makeListing()]);
  });

  it("unpaid income line returns chargedAmount = charged, amount = 0 (collected), paymentStatus = pending", async () => {
    dbMock.ownerLedgerEntry.findMany.mockResolvedValue([
      makeLedgerRow({ amount: dec("0.00"), paymentStatus: "pending", sourceChargeId: CHARGE_A }),
    ]);
    dbMock.charge.findMany.mockImplementation(async (args: { where?: { sourceGridExpenseId?: unknown } }) =>
      args?.where?.sourceGridExpenseId ? [] : [{ id: CHARGE_A, amount: dec("500.00") }],
    );

    const result = await assembleYannieStatement(ctx, STMT_ID);
    expect(result).not.toBeNull();

    const row = result!.incomeBreakdown.rows[0]!;
    expect(row.chargedAmount).toBe("500.00");
    expect(row.amount).toBe("0.00");
    expect(row.paymentStatus).toBe("pending");
  });

  it("partial income line returns chargedAmount = full, amount = partial collected", async () => {
    dbMock.ownerLedgerEntry.findMany.mockResolvedValue([
      makeLedgerRow({ amount: dec("250.00"), paymentStatus: "partial", sourceChargeId: CHARGE_A }),
    ]);
    dbMock.charge.findMany.mockImplementation(async (args: { where?: { sourceGridExpenseId?: unknown } }) =>
      args?.where?.sourceGridExpenseId ? [] : [{ id: CHARGE_A, amount: dec("500.00") }],
    );

    const result = await assembleYannieStatement(ctx, STMT_ID);
    expect(result).not.toBeNull();

    const row = result!.incomeBreakdown.rows[0]!;
    expect(row.chargedAmount).toBe("500.00");
    expect(row.amount).toBe("250.00");
    expect(row.paymentStatus).toBe("partial");
  });

  it("paid income line: chargedAmount === amount (both reflect the full charged amount)", async () => {
    dbMock.ownerLedgerEntry.findMany.mockResolvedValue([
      makeLedgerRow({ amount: dec("500.00"), paymentStatus: "paid", sourceChargeId: CHARGE_A }),
    ]);
    dbMock.charge.findMany.mockImplementation(async (args: { where?: { sourceGridExpenseId?: unknown } }) =>
      args?.where?.sourceGridExpenseId ? [] : [{ id: CHARGE_A, amount: dec("500.00") }],
    );

    const result = await assembleYannieStatement(ctx, STMT_ID);
    expect(result).not.toBeNull();

    const row = result!.incomeBreakdown.rows[0]!;
    expect(row.chargedAmount).toBe("500.00");
    expect(row.amount).toBe("500.00");
  });

  it("manual income row (sourceChargeId = null): chargedAmount falls back to collected amount", async () => {
    dbMock.ownerLedgerEntry.findMany.mockResolvedValue([
      makeLedgerRow({ amount: dec("300.00"), paymentStatus: "paid", sourceChargeId: null }),
    ]);
    // charge.findMany NOT called (incomeSourceChargeIds empty) — mock returns empty
    dbMock.charge.findMany.mockResolvedValue([]);

    const result = await assembleYannieStatement(ctx, STMT_ID);
    expect(result).not.toBeNull();

    const row = result!.incomeBreakdown.rows[0]!;
    // Manual rows: chargedAmount === amount (collected) because there is no source charge
    expect(row.chargedAmount).toBe("300.00");
    expect(row.amount).toBe("300.00");
  });

  it("footing: Net Payout uses collected amount (amount), never chargedAmount — payout is unchanged", async () => {
    // Row 1: unpaid (charged 500, collected 0)
    // Row 2: paid   (charged 500, collected 500)
    // Expected payout = 500 (only what was collected), NOT 1000 (sum of charged)
    dbMock.ownerLedgerEntry.findMany.mockResolvedValue([
      makeLedgerRow({ listingId: LISTING_A, amount: dec("0.00"), paymentStatus: "pending", sourceChargeId: CHARGE_A }),
      makeLedgerRow({ listingId: LISTING_B, amount: dec("500.00"), paymentStatus: "paid", sourceChargeId: CHARGE_B }),
    ]);
    dbMock.charge.findMany.mockImplementation(async (args: { where?: { sourceGridExpenseId?: unknown } }) =>
      args?.where?.sourceGridExpenseId
        ? []
        : [
            { id: CHARGE_A, amount: dec("500.00") },
            { id: CHARGE_B, amount: dec("500.00") },
          ],
    );
    dbMock.listing.findMany.mockResolvedValue([
      makeListing(LISTING_A, "A-10-04"),
      makeListing(LISTING_B, "A-10-05"),
    ]);

    const result = await assembleYannieStatement(ctx, STMT_ID);
    expect(result).not.toBeNull();

    // Income rows: chargedAmount shows 500 each (what was billed)
    const rows = result!.incomeBreakdown.rows;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.chargedAmount).toBe("500.00");
    expect(rows[1]!.chargedAmount).toBe("500.00");

    // Collected amounts: 0 and 500
    expect(rows[0]!.amount).toBe("0.00");
    expect(rows[1]!.amount).toBe("500.00");

    // Payout is based on collected ONLY: 0 + 500 = 500 (never 1000)
    expect(result!.payoutSummary.netPayoutToOwner).toBe("500.00");

    // Also verify the payout summary line "Total Income Collected" = 500 (collected-based)
    const grossLine = result!.payoutSummary.lines.find((l) => l.label === "Total Income Collected");
    expect(grossLine).toBeDefined();
    expect(grossLine!.amount).toBe("500.00");
  });
});
