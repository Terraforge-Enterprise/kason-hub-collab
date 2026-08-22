// Grid payment display — the row badge + the per-cell greyed/tick affordance.
//
// The bug this covers: an admin pays a tenant invoice in full and the grid keeps saying
// "unpaid", because the pill read the MANUAL `paymentStatus` column (never advanced by a
// Bill or a payment) instead of real settlement. The fixtures below mirror the actual
// data that reproduced it — tenant charges settled, owner charges outstanding.
import { describe, expect, it, vi, afterEach } from "vitest";

afterEach(() => vi.unstubAllEnvs());
import { render, screen, within } from "@testing-library/react";
import type { GridRow, GridEntryDto, GridBearerConfigDto, GridSubRow, GridSettlementDto } from "@/api/bills-grid";
import { emptySettlementCells, type SettlementBucket, type SettlementState } from "@kason/shared";
import { GridTable } from "../grid-table";
import { CURRENT_COLUMNS } from "../columns";

// AIR is OWNER-borne ("absorbed") throughout this file, deliberately: these tests use the
// airOwner cell as their subject, and since 2026-08-14 the AIR bearer decides WHICH of the
// two AIR columns renders (cell-applicability.ts). An owner-borne AIR is also the coherent
// pairing for the `airOwner` settlement bucket they assert on — that bucket is fed by
// OWNER-side invoice lines (foldSettlement, service.ts), which is what an absorbed water
// bill produces. A "recharged" fixture would settle into airTenant instead.
function makeEntry(partial: Partial<GridEntryDto> = {}): GridEntryDto {
  return {
    cleaning: null, tnbTotal: null, airSelangor: null, wifi: null, maintenanceFee: null,
    readingDate: null, paymentStatus: "unpaid", tnbPattern: "recharged", airPattern: "absorbed",
    cleaningBearer: "owner", wifiBearer: "owner", maintenanceFeeBearer: "owner",
    updatedAt: "2026-07-01T00:00:00.000Z", lockState: "draft", ...partial,
  };
}

function makeBearerConfig(): GridBearerConfigDto {
  return {
    tnbPattern: "recharged", airPattern: "absorbed", cleaningBearer: "owner",
    wifiBearer: "owner", maintenanceFeeBearer: "owner", cleaningRecurringAmount: "0.00", isLocked: false,
  };
}

function makeSubRow(partial: Partial<GridSubRow> = {}): GridSubRow {
  return {
    listingId: "L1", tenancyId: "T1", partyName: "Tenant", previousKwh: null, currentKwh: null,
    amount: null, ratePerKwh: "0.6000", rateConfigured: false, rental: null, ...partial,
  };
}

/** Settlement fixture: everything "none" unless named. */
function settlement(
  status: SettlementState,
  cells: Partial<Record<SettlementBucket, SettlementState>> = {},
  rooms: Record<string, Partial<Record<SettlementBucket, SettlementState>>> = {},
): GridSettlementDto {
  return {
    status,
    cells: { ...emptySettlementCells(), ...cells },
    rooms: Object.fromEntries(
      Object.entries(rooms).map(([id, c]) => [id, { ...emptySettlementCells(), ...c }]),
    ),
    expenseLines: {},
  };
}

function makeRow(partial: Partial<GridRow> = {}): GridRow {
  return {
    apartmentId: "APT1", unitCode: "PV9 A-13-13", propertyId: "PROP1", propertyName: "Sunway Vista",
    entryId: "E1", preview: null, previewError: null, warnings: [], subRows: [],
    billedAt: null, paymentStatus: "unpaid", priorMonths: [], entry: makeEntry(),
    bearerConfig: makeBearerConfig(),
    expenses: { tenant: { total: "0.00", withSstTotal: "0.00", count: 0 }, owner: { total: "0.00", withSstTotal: "0.00", count: 0 } },
    attachments: [], isWholeUnit: false, ...partial,
  };
}

const pill = () => screen.getByTestId("entry-payment-pill");

describe("row payment badge", () => {
  it("tenant paid in full but owner still owes → 'Partially paid' (never a green Paid)", () => {
    render(
      <GridTable
        rows={[makeRow({
          paymentStatus: "unpaid", // the stale manual column — must NOT win
          settlement: settlement("partial", { tnbTenant: "paid", maintenanceOwner: "unpaid" }),
        })]}
        columns={CURRENT_COLUMNS}
      />,
    );
    expect(pill()).toHaveTextContent("Partially paid");
  });

  it("everything settled → 'Paid', even though the manual column still says unpaid", () => {
    render(
      <GridTable
        rows={[makeRow({ paymentStatus: "unpaid", settlement: settlement("paid", { tnbTenant: "paid" }) })]}
        columns={CURRENT_COLUMNS}
      />,
    );
    expect(pill()).toHaveTextContent("Paid");
  });

  it("billed but nothing paid → 'Unpaid'", () => {
    render(
      <GridTable
        rows={[makeRow({ settlement: settlement("unpaid", { tnbTenant: "unpaid" }) })]}
        columns={CURRENT_COLUMNS}
      />,
    );
    expect(pill()).toHaveTextContent("Unpaid");
  });

  it("nothing billed yet (status 'none') falls back to the manual column — unchanged behaviour", () => {
    render(
      <GridTable rows={[makeRow({ paymentStatus: "pending", settlement: settlement("none") })]} columns={CURRENT_COLUMNS} />,
    );
    expect(pill()).toHaveTextContent("pending");
  });

  it("a row with no settlement at all (older payload) still renders the manual column", () => {
    render(<GridTable rows={[makeRow({ paymentStatus: "unpaid", settlement: undefined })]} columns={CURRENT_COLUMNS} />);
    expect(pill()).toHaveTextContent("unpaid");
  });
});

describe("per-cell paid affordance", () => {
  it("colours the paid column without a redundant corner tick; leaves the unpaid one alone", () => {
    render(
      <GridTable
        rows={[makeRow({
          entry: makeEntry({ airSelangor: "20.00", maintenanceFee: "300.00" }),
          settlement: settlement("partial", { airOwner: "paid", maintenanceOwner: "unpaid" }),
        })]}
        columns={CURRENT_COLUMNS}
      />,
    );
    const paidCell = screen.getByTestId("cell-airOwner");
    expect(paidCell).toHaveAttribute("data-settled", "true");
    expect(within(paidCell).queryByTestId("settled-tick")).not.toBeInTheDocument();
    expect(within(paidCell).getByText("Paid")).toBeInTheDocument();

    const unpaidCell = screen.getByTestId("cell-maintenanceFee");
    expect(unpaidCell).not.toHaveAttribute("data-settled");
    expect(within(unpaidCell).queryByTestId("settled-tick")).not.toBeInTheDocument();
  });

  // RULE CHANGED 2026-08-03. This test used to assert that a partially-paid column
  // renders NOTHING ("half-settled must not read as done"). The premise was right —
  // partial is not done — but rendering nothing made "half the money is in"
  // indistinguishable from "no money is in", which is the worse of the two lies. It
  // now paints in a DIFFERENT hue and glyph: still not done, but visibly not nothing.
  it("a PARTIALLY paid column marks in amber, and never as 'paid'", () => {
    render(
      <GridTable
        rows={[makeRow({ entry: makeEntry({ airSelangor: "20.00" }), settlement: settlement("partial", { airOwner: "partial" }) })]}
        columns={CURRENT_COLUMNS}
      />,
    );
    const cell = screen.getByTestId("cell-airOwner");
    // `data-settled` is the "this line is done" signal — partial must NOT claim it.
    expect(cell).not.toHaveAttribute("data-settled");
    expect(cell).toHaveAttribute("data-settlement", "partial");
    expect(within(cell).getByTestId("partial-tick")).toBeInTheDocument();
    expect(within(cell).queryByTestId("settled-tick")).not.toBeInTheDocument();
    // Not colour-only: the state reaches a screen reader as words.
    expect(within(cell).getByText("Partially paid")).toBeInTheDocument();
  });

  it("paid and partial cells are distinguishable from each other AND from unpaid", () => {
    render(
      <GridTable
        rows={[makeRow({
          entry: makeEntry({ airSelangor: "20.00", maintenanceFee: "300.00", wifi: "50.00" }),
          settlement: settlement("partial", { airOwner: "paid", wifiOwner: "partial", maintenanceOwner: "unpaid" }),
        })]}
        columns={CURRENT_COLUMNS}
      />,
    );
    expect(screen.getByTestId("cell-airOwner")).toHaveAttribute("data-settlement", "paid");
    expect(screen.getByTestId("cell-wifiOwner")).toHaveAttribute("data-settlement", "partial");
    expect(screen.getByTestId("cell-maintenanceFee")).not.toHaveAttribute("data-settlement");
  });

  it("read-only money columns (expenses) tick too, not just editable ones", () => {
    render(
      <GridTable
        rows={[makeRow({ settlement: settlement("partial", { expensesTenant: "paid", expensesOwner: "unpaid" }) })]}
        columns={CURRENT_COLUMNS}
      />,
    );
    expect(screen.getByTestId("cell-tenantExpWithSst")).toHaveAttribute("data-settled", "true");
    expect(screen.getByTestId("cell-tenantExpNonSst")).toHaveAttribute("data-settled", "true");
    expect(screen.getByTestId("cell-ownerExpWithSst")).not.toHaveAttribute("data-settled");
  });

  it("non-money columns never tick, however the row is settled", () => {
    render(
      <GridTable
        rows={[makeRow({
          subRows: [makeSubRow({ rental: "1200.00" })],
          settlement: settlement("paid", { tnbTenant: "paid", airOwner: "paid" }),
        })]}
        columns={CURRENT_COLUMNS}
      />,
    );
    // Rental is server-derived display, never a grid charge — a tick would imply
    // someone had settled a bill that was never issued. Asserted across EVERY rental
    // cell (the unit row and the inline sub-row both render one).
    const rentalCells = screen.getAllByTestId("cell-rental");
    expect(rentalCells.length).toBeGreaterThan(0);
    for (const c of rentalCells) expect(c).not.toHaveAttribute("data-settled");
  });

  describe("PARTITIONED unit", () => {
    it("ticks the paid room's TNB amount and not its unpaid sibling's", () => {
      render(
        <GridTable
          rows={[makeRow({
            subRows: [
              makeSubRow({ listingId: "room-A", tenancyId: "T1", partyName: "Ali", amount: "150.00" }),
              makeSubRow({ listingId: "room-B", tenancyId: "T2", partyName: "Bala", amount: "150.00" }),
            ],
            settlement: settlement(
              "partial",
              { tnbTenant: "partial" }, // unit roll-up: not all rooms settled
              { "room-A": { tnbTenant: "paid" }, "room-B": { tnbTenant: "unpaid" } },
            ),
          })]}
          columns={CURRENT_COLUMNS}
        />,
      );
      const rows = screen.getAllByTestId("tenant-sub-row");
      const roomA = rows.find((r) => r.getAttribute("data-listing-id") === "room-A")!;
      const roomB = rows.find((r) => r.getAttribute("data-listing-id") === "room-B")!;
      expect(within(roomA).getByTestId("cell-amount")).toHaveAttribute("data-settled", "true");
      expect(within(roomB).getByTestId("cell-amount")).not.toHaveAttribute("data-settled");
    });
  });
});

// ── Row edit lock (row-lock.ts), rendered ────────────────────────────────────
// The bug: the lock read the MANUAL `paymentStatus` column, which no payment ever
// advances. So a paid row kept rendering live <input>s — an admin could type a new
// number into money that the SERVER had already frozen (anyChargePaid freezes an
// entry on any net-positive payment). The edit looked accepted and died at Save.
//
// `data-settled`/the tick were never the gate: they are decoration, and the old
// code said so explicitly ("the cell stays EDITABLE"). These tests assert the thing
// that actually matters — whether a real <input> exists to type into.
describe("row edit lock follows real payment, not the manual column", () => {
  /** The money cell an admin would try to edit on these fixtures. */
  const airCell = () => screen.getByTestId("cell-airOwner");

  it("a billed row with a FULLY paid cell renders no input — and stays GREEN, not grey", () => {
    render(
      <GridTable
        rows={[makeRow({
          billedAt: "2026-08-01T00:00:00.000Z",
          paymentStatus: "unpaid", // manual column still says unpaid — the old bug
          entry: makeEntry({ airSelangor: "20.00" }),
          settlement: settlement("paid", { airOwner: "paid" }),
        })]}
        columns={CURRENT_COLUMNS}
      />,
    );
    const cell = airCell();
    expect(within(cell).queryByRole("textbox")).not.toBeInTheDocument();
    // Locked cells default to a muted grey wash; a settled one must keep its green.
    expect(cell).toHaveAttribute("data-settled", "true");
    expect(cell.className).toContain("emerald");
    expect(cell.className).not.toContain("bg-muted");
  });

  it("ONE partially-paid cell locks ONLY itself — its untouched neighbours stay editable", () => {
    // Cell-grain is flag-gated; see row-lock.ts. Flag off, the whole row locks.
    vi.stubEnv("VITE_ENABLE_PROFORMA_INVOICES", "true");
    render(
      <GridTable
        rows={[makeRow({
          billedAt: "2026-08-01T00:00:00.000Z",
          paymentStatus: "unpaid",
          entry: makeEntry({ airSelangor: "20.00", maintenanceFee: "300.00" }),
          // Only the WiFi bucket has money against it; air/maintenance are untouched.
          settlement: settlement("partial", { wifiOwner: "partial" }),
        })]}
        columns={CURRENT_COLUMNS}
      />,
    );
    // REVERSED 2026-08-18 (spec R6 write half). This test previously asserted that one
    // partially-paid WiFi cell froze air and maintenance too — a documented trade-off that
    // was correct only while a re-Bill refused the whole month once any money landed.
    // Partial re-Bill removed that constraint, so the row lock became coarser than the
    // money it represents and an admin could not correct an untouched line.
    //
    // The WiFi money must still freeze its OWN cell; air and maintenance are untouched and
    // stay editable.
    expect(within(airCell()).queryByRole("textbox")).toBeInTheDocument();
    // ...and the untouched cells carry no payment marker — editable ≠ paid.
    expect(airCell()).not.toHaveAttribute("data-settlement");
  });

  it("a billed but WHOLLY UNPAID row stays editable — amend + re-Bill (spec R7) is untouched", () => {
    render(
      <GridTable
        rows={[makeRow({
          billedAt: "2026-08-01T00:00:00.000Z",
          paymentStatus: "unpaid",
          entry: makeEntry({ airSelangor: "20.00" }),
          settlement: settlement("unpaid", { airOwner: "unpaid" }),
        })]}
        columns={CURRENT_COLUMNS}
      />,
    );
    expect(within(airCell()).getByRole("textbox")).toBeInTheDocument();
  });

  it("an UNBILLED row is never locked, whatever settlement claims", () => {
    render(
      <GridTable
        rows={[makeRow({
          billedAt: null,
          entry: makeEntry({ airSelangor: "20.00" }),
          settlement: settlement("paid", { airOwner: "paid" }),
        })]}
        columns={CURRENT_COLUMNS}
      />,
    );
    expect(within(airCell()).getByRole("textbox")).toBeInTheDocument();
  });

  it("the legacy manual lock still works — an admin-marked 'paid' row locks with no settlement at all", () => {
    render(
      <GridTable
        rows={[makeRow({
          billedAt: "2026-08-01T00:00:00.000Z",
          paymentStatus: "paid",
          entry: makeEntry({ airSelangor: "20.00" }),
          settlement: undefined,
        })]}
        columns={CURRENT_COLUMNS}
      />,
    );
    expect(within(airCell()).queryByRole("textbox")).not.toBeInTheDocument();
  });
});
