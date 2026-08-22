// UI Task 3 — grid-table.tsx. Pure props-driven table: 7 acceptance rows per
// the brief. Fixtures build VALID GridRow/GridEntryDto objects via
// makeRow/makeEntry/makeBearerConfig/makeSubRow helpers (never a simplified
// shape — that's the §16 "renders fine but the field silently isn't there"
// regression this whole plan guards against).
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import type { GridRow, GridEntryDto, GridBearerConfigDto, GridSubRow } from "@/api/bills-grid";
import { billingStateForCell, GridTable, renewalSignalForRow, rowHasBillingState } from "../grid-table";
import { CURRENT_COLUMNS } from "../columns";
import { emptySettlementCells } from "@kason/shared";

function makeEntry(partial: Partial<GridEntryDto> = {}): GridEntryDto {
  return {
    cleaning: null,
    tnbTotal: null,
    airSelangor: null,
    wifi: null,
    maintenanceFee: null,
    readingDate: null,
    paymentStatus: "unpaid",
    tnbPattern: "recharged",
    airPattern: "recharged",
    cleaningBearer: "owner",
    wifiBearer: "owner",
    maintenanceFeeBearer: "owner",
    updatedAt: "2026-07-01T00:00:00.000Z",
    lockState: "draft",
    ...partial,
  };
}

function makeBearerConfig(partial: Partial<GridBearerConfigDto> = {}): GridBearerConfigDto {
  return {
    tnbPattern: "recharged",
    airPattern: "recharged",
    cleaningBearer: "owner",
    wifiBearer: "owner",
    maintenanceFeeBearer: "owner",
    cleaningRecurringAmount: "0.00",
    isLocked: false,
    ...partial,
  };
}

function makeSubRow(partial: Partial<GridSubRow> = {}): GridSubRow {
  return {
    listingId: "L1",
    tenancyId: "T1",
    partyName: "Tenant",
    previousKwh: null,
    currentKwh: null,
    amount: null,
    ratePerKwh: "0.6000",
    rateConfigured: false,
    rental: null,
    ...partial,
  };
}

function makeRow(partial: Partial<GridRow> = {}): GridRow {
  return {
    apartmentId: "APT1",
    unitCode: "PV9 A-13-13",
    propertyId: "PROP1",
    propertyName: "Sunway Vista",
    entryId: null,
    preview: null,
    previewError: null,
    warnings: [],
    subRows: [],
    billedAt: null,
    paymentStatus: "unpaid",
    priorMonths: [],
    entry: null,
    bearerConfig: makeBearerConfig(),
    expenses: { tenant: { total: "0.00", withSstTotal: "0.00", count: 0 }, owner: { total: "0.00", withSstTotal: "0.00", count: 0 } },
    attachments: [],
    // Task 6: grain-lock is now re-based on isWholeUnit (server-derived from
    // Apartment.listingMode), NOT entry.rental (removed). Default false
    // (partitioned) mirrors the old default fixture shape (entry: null /
    // entry.rental: null used to imply partitioned).
    isWholeUnit: false,
    ...partial,
  };
}

describe("GridTable", () => {
  it("shows a 60-day renewal signal and advances its message with the tenant decision", () => {
    const now = new Date(2026, 7, 22);
    const ending = makeSubRow({ tenancyId: "T1", tenancyEndDate: "2026-10-21T00:00:00.000Z", renewalDecision: "pending" });
    expect(renewalSignalForRow(makeRow({ subRows: [ending] }), now)).toEqual({
      tenancyId: "T1",
      label: "Ask tenant about renewal · 60d left",
      urgent: true,
    });
    expect(renewalSignalForRow(makeRow({ subRows: [{ ...ending, renewalDecision: "contacted" }] }), now)?.label).toBe("Renewal answer pending · 60d left");
    expect(renewalSignalForRow(makeRow({ subRows: [{ ...ending, renewalDecision: "renew" }] }), now)?.label).toBe("Renewal · add TA fee");
    expect(renewalSignalForRow(makeRow({
      subRows: [{ ...ending, renewalDecision: "renew" }],
      agreementFees: {
        new: { amount: "0.00", outstanding: "0.00", state: "none" },
        renewal: { amount: "0.00", outstanding: "0.00", state: "saved" },
      },
    }), now)?.label).toBe("Renewal ready to complete");
    expect(renewalSignalForRow(makeRow({ subRows: [{ ...ending, renewalDecision: "not_renew" }] }), now)?.label).toBe("Move-out planned · 60d left");
  });

  it("uses compact content-led widths for Rent, Deposit and TA without forcing Fit All wider than its container", () => {
    const compactColumns = CURRENT_COLUMNS.filter((column) =>
      ["rental", "deposit", "agreementFee"].includes(column.id),
    );
    const { container, rerender } = render(
      <GridTable rows={[]} columns={compactColumns} displayMode="easy-read" />,
    );

    expect(Array.from(container.querySelectorAll("col"), (col) => col.style.width)).toEqual([
      "300px",
      "86px",
      "86px",
      "72px",
    ]);

    rerender(<GridTable rows={[]} columns={compactColumns} displayMode="fit-all" />);
    const table = container.querySelector("table");
    expect(table?.className).not.toContain("min-w-[1680px]");
    expect(table?.style.minWidth).toBe("");
  });

  it("does not render the redundant Billed lifecycle tag", () => {
    render(<GridTable rows={[makeRow({ billed: true, billedAt: null })]} columns={CURRENT_COLUMNS} />);
    expect(screen.queryByTestId("billed-badge")).not.toBeInTheDocument();
  });

  it("rule 2: no `Billed` tag on an unbilled row (billed falsy)", () => {
    render(<GridTable rows={[makeRow({ billed: false })]} columns={CURRENT_COLUMNS} />);
    expect(screen.queryByTestId("billed-badge")).not.toBeInTheDocument();
  });

  it('"sub-rows": partitioned apartment (3 occupied rooms) renders 1 unit row + 3 tenant-sub-rows', () => {
    const row = makeRow({
      entry: makeEntry({}),
      subRows: [
        makeSubRow({ listingId: "L1", tenancyId: "T1", partyName: "Ali" }),
        makeSubRow({ listingId: "L2", tenancyId: "T2", partyName: "Bala" }),
        makeSubRow({ listingId: "L3", tenancyId: "T3", partyName: "Chong" }),
      ],
    });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} />);
    expect(screen.getByRole("row", { name: /PV9 A-13-13/ })).toBeInTheDocument();
    expect(screen.getAllByTestId("tenant-sub-row")).toHaveLength(3);
  });

  it('"vacant rooms": two rooms with tenancyId:null keep distinct identity via listingId', () => {
    const row = makeRow({
      entry: makeEntry({}),
      subRows: [
        makeSubRow({ listingId: "L20", tenancyId: null, partyName: null }),
        makeSubRow({ listingId: "L21", tenancyId: null, partyName: null }),
      ],
    });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} />);
    const subRows = screen.getAllByTestId("tenant-sub-row");
    expect(subRows.map((r) => r.getAttribute("data-listing-id"))).toEqual(["L20", "L21"]);
    for (const r of subRows) {
      const cell = within(r).getByTestId("cell-previousKwh");
      expect(cell.querySelector("input")).not.toBeNull();
      expect(cell.getAttribute("aria-readonly")).not.toBe("true");
    }
  });

  it('"vacant rooms hidden (showVacant=false)": a partitioned unit drops its vacant, dataless rooms from both the sub-rows and the room count; occupied + data-carrying (orphan) rooms stay; showVacant=true shows all', () => {
    const row = makeRow({
      entry: makeEntry({}),
      subRows: [
        makeSubRow({ listingId: "OCC", tenancyId: "T1", partyName: "Ali" }),
        makeSubRow({ listingId: "VACANT", tenancyId: null, partyName: null }),
        makeSubRow({ listingId: "ORPHAN", tenancyId: null, partyName: null, currentKwh: "999" }),
      ],
    });

    const { rerender } = render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} showVacant={false} />);
    expect(screen.getAllByTestId("tenant-sub-row").map((r) => r.getAttribute("data-listing-id"))).toEqual(["OCC", "ORPHAN"]);
    const unitRow = screen.getByRole("row", { name: /PV9 A-13-13/ });
    expect(within(unitRow).getByTestId("unit-occupancy-tag")).toHaveTextContent("2 rooms");

    rerender(<GridTable rows={[row]} columns={CURRENT_COLUMNS} showVacant={true} />);
    expect(screen.getAllByTestId("tenant-sub-row").map((r) => r.getAttribute("data-listing-id"))).toEqual(["OCC", "VACANT", "ORPHAN"]);
  });

  it('"billing contacts": owner and tenant names show without phone numbers', () => {
    const row = makeRow({
      ownerName: "Tan Ah Kow",
      subRows: [makeSubRow({ listingId: "L1", tenancyId: "T1", partyName: "Ali bin Ahmad", partyPhone: "011-2223333" })],
    });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} />);

    const ownerLine = screen.getByTestId("owner-line");
    expect(ownerLine).toHaveTextContent("Tan Ah Kow");
    // Owner phone is intentionally NOT surfaced on this page.
    expect(ownerLine).not.toHaveTextContent("012");
    expect(screen.getByTestId("tenant-sub-row")).toHaveTextContent("Ali bin Ahmad");
    expect(screen.queryByText(/011-2223333/)).toBeNull();
  });

  it('"whole-unit contacts": shows Owner and Tenant on separate lines without tenant phone', () => {
    const row = makeRow({
      isWholeUnit: true,
      ownerName: "Lim Bee",
      subRows: [makeSubRow({ listingId: "L1", tenancyId: "T1", partyName: "Siti", partyPhone: "017-5554444" })],
    });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} />);
    expect(screen.queryByTestId("subrow-phone")).toBeNull();
    expect(screen.getByTestId("unit-occupancy-tag")).toHaveTextContent("Whole unit: Lim Bee");
    expect(screen.getByTestId("whole-unit-tenant")).toHaveTextContent("Tenant: Siti");
    expect(screen.queryByText(/017-5554444/)).toBeNull();
  });

  it('"billing contacts absent": no owner line and no phone span when the row carries neither', () => {
    const row = makeRow({ subRows: [makeSubRow({ listingId: "L1", tenancyId: "T1", partyName: "Ali", partyPhone: null })] });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} />);
    expect(screen.queryByTestId("owner-line")).toBeNull();
    expect(screen.queryByTestId("subrow-phone")).toBeNull();
    expect(screen.queryByTestId("whole-unit-tenant-phone")).toBeNull();
  });

  it('"whole-unit": isWholeUnit:true renders inline; zero tenant-sub-row (grain-lock re-based, Task 6)', () => {
    const row = makeRow({
      isWholeUnit: true,
      entry: makeEntry({}),
      subRows: [makeSubRow({ listingId: "L1", tenancyId: "T1", rental: "3000.00" })],
    });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} />);
    const unitRow = screen.getByRole("row", { name: /PV9 A-13-13/ });
    expect(within(unitRow).getByTestId("cell-rental")).toHaveTextContent("3000.00");
    expect(screen.queryAllByTestId("tenant-sub-row")).toHaveLength(0);
  });

  // Task 6 (B9): grain-lock is now re-based on isWholeUnit, NOT
  // subRows.length/entry.rental — a partitioned row with isWholeUnit:false
  // and 3 subRows must still render 3 nested sub-rows regardless of what
  // entry (now rental-less) carries.
  it('"grain-lock nested": isWholeUnit:false with 3 subRows renders 3 nested tenant-sub-rows', () => {
    const row = makeRow({
      isWholeUnit: false,
      entry: makeEntry({}),
      subRows: [
        makeSubRow({ listingId: "L1", tenancyId: "T1", partyName: "Ali" }),
        makeSubRow({ listingId: "L2", tenancyId: "T2", partyName: "Bala" }),
        makeSubRow({ listingId: "L3", tenancyId: "T3", partyName: "Chong" }),
      ],
    });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} />);
    expect(screen.getAllByTestId("tenant-sub-row")).toHaveLength(3);
  });

  // Task 6 (B8): the inverse — isWholeUnit:true with only 1 subRow (the
  // typical whole-unit shape) must render inline, never nested, even though
  // subRows.length === 1 would previously have been ambiguous under the old
  // `subRows.length > 1` rule.
  it('"grain-lock inline": isWholeUnit:true renders inline regardless of subRows content', () => {
    const row = makeRow({
      isWholeUnit: true,
      entry: makeEntry({}),
      subRows: [makeSubRow({ listingId: "L1", tenancyId: "T1", partyName: "Ali", rental: "2500.00" })],
    });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} />);
    expect(screen.queryAllByTestId("tenant-sub-row")).toHaveLength(0);
  });

  // Task 6 (B1/B2/B3/B5): Amount + Rental read-only, with a live preview on
  // Amount. Amount/Rental cells were previously EditableCell (<input>); they
  // are now LockedCell (no <input>, aria-readonly="true").

  it('"amount read-only": a nested sub-row\'s amount cell has no <input> and shows the stored amount when nothing is staged', () => {
    const row = makeRow({
      isWholeUnit: false,
      entry: makeEntry({}),
      subRows: [
        makeSubRow({ listingId: "L1", tenancyId: "T1", previousKwh: "100.00", currentKwh: "150.00", amount: "30.00", ratePerKwh: "0.6000" }),
        makeSubRow({ listingId: "L2", tenancyId: "T2" }),
      ],
    });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} />);
    const subRow = screen.getAllByTestId("tenant-sub-row")[0];
    const amountCell = within(subRow).getByTestId("cell-amount");
    expect(amountCell.querySelector("input")).toBeNull();
    expect(amountCell.getAttribute("aria-readonly")).toBe("true");
    expect(amountCell).toHaveTextContent("30.00");
  });

  // Final-review Finding 1: a SAVED reading (no staged edit) must show the
  // STORED snapshot amount, NOT a re-computation at the CURRENT rate. Here
  // the reading was saved at rate 0.60 (amount "60.00") but ratePerKwh has
  // since changed to 0.5500 — re-pricing at the current rate would yield
  // "55.00", which disagrees with server-computed totals derived from the
  // stored "60.00". The unedited cell must show "60.00".
  it('"amount stored snapshot": unedited saved reading shows the stored amount even when ratePerKwh changed since save (not re-priced)', () => {
    const row = makeRow({
      isWholeUnit: false,
      entry: makeEntry({}),
      subRows: [
        makeSubRow({ listingId: "L1", tenancyId: "T1", previousKwh: "0", currentKwh: "100", amount: "60.00", ratePerKwh: "0.5500" }),
      ],
    });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} />);
    const subRow = screen.getByTestId("tenant-sub-row");
    expect(within(subRow).getByTestId("cell-amount")).toHaveTextContent("60.00");
  });

  it('"whole-unit meter not applicable": previous/current/amount are centred dashes and cannot be edited', () => {
    const row = makeRow({
      isWholeUnit: true,
      entry: makeEntry({}),
      subRows: [
        makeSubRow({ listingId: "L1", tenancyId: "T1", previousKwh: "0", currentKwh: "100", amount: "60.00", ratePerKwh: "0.5500" }),
      ],
    });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} />);
    const unitRow = screen.getByRole("row", { name: /PV9 A-13-13/ });
    for (const columnId of ["previousKwh", "currentKwh", "amount"]) {
      const cell = within(unitRow).getByTestId(`cell-${columnId}`);
      expect(cell).toHaveTextContent("—");
      expect(cell).toHaveClass("text-center", "align-middle");
      expect(cell).toHaveAttribute("aria-readonly", "true");
      expect(cell.querySelector("input")).toBeNull();
    }
  });

  // Regression (audit finding #6, symmetric case): the existing live-preview
  // test above stages ONLY previousKwh; this mirrors it staging ONLY
  // currentKwh, confirming the OR in `hasStagedEdit` triggers the live
  // preview from either field alone.
  it('"amount live-preview (currentKwh only staged)": staging only currentKwh (previousKwh left at its seed) still live-previews', async () => {
    const row = makeRow({
      isWholeUnit: false,
      entry: makeEntry({}),
      subRows: [
        makeSubRow({ listingId: "L1", tenancyId: "T1", previousKwh: "100.00", currentKwh: null, amount: "999.00", ratePerKwh: "0.5000" }),
      ],
    });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} />);
    const subRow = screen.getByTestId("tenant-sub-row");
    expect(within(subRow).getByTestId("cell-amount")).toHaveTextContent("999.00");

    const currentInput = within(subRow).getByTestId("cell-currentKwh").querySelector("input")!;
    await userEvent.type(currentInput, "150");

    // (150 - 100) * 0.5 = 25.00
    expect(within(subRow).getByTestId("cell-amount")).toHaveTextContent("25.00");
  });

  it('"amount live-preview": completing Current+Previous live-previews round2((cur-prev)*ratePerKwh) on the Amount cell, replacing the stale stored amount', async () => {
    const row = makeRow({
      isWholeUnit: false,
      entry: makeEntry({}),
      subRows: [
        // previousKwh is null (never Saved) — Current/Previous are NOT both
        // parseable yet, so the cell falls back to the stored (stale) amount.
        makeSubRow({ listingId: "L1", tenancyId: "T1", previousKwh: null, currentKwh: "150.00", amount: "999.00", ratePerKwh: "0.5000" }),
      ],
    });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} />);
    const subRow = screen.getByTestId("tenant-sub-row");
    // stale stored amount ("999.00") shown until BOTH Current+Previous are staged
    expect(within(subRow).getByTestId("cell-amount")).toHaveTextContent("999.00");

    const previousInput = within(subRow).getByTestId("cell-previousKwh").querySelector("input")!;
    await userEvent.type(previousInput, "100");

    // (150 - 100) * 0.5 = 25.00 — the STALE stored amount must be replaced
    // the instant both fields are staged/parseable numbers.
    expect(within(subRow).getByTestId("cell-amount")).toHaveTextContent("25.00");
  });

  it('"amount preview clamps negative delta to 0": currentKwh below previousKwh never shows negative money', async () => {
    const row = makeRow({
      isWholeUnit: false,
      entry: makeEntry({}),
      subRows: [
        makeSubRow({ listingId: "L1", tenancyId: "T1", previousKwh: "100.00", currentKwh: "150.00", amount: "30.00", ratePerKwh: "0.6000" }),
      ],
    });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} />);
    const subRow = screen.getByTestId("tenant-sub-row");
    const currentInput = within(subRow).getByTestId("cell-currentKwh").querySelector("input")!;
    await userEvent.clear(currentInput);
    await userEvent.type(currentInput, "50"); // below previousKwh (100) — negative delta

    expect(within(subRow).getByTestId("cell-amount")).toHaveTextContent("0.00");
  });

  it('"rental read-only": the unit-row rental cell has no <input>', () => {
    const row = makeRow({
      isWholeUnit: true,
      entry: makeEntry({}),
      subRows: [makeSubRow({ listingId: "L1", tenancyId: "T1", rental: "3000.00" })],
    });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} />);
    const unitRow = screen.getByRole("row", { name: /PV9 A-13-13/ });
    const rentalCell = within(unitRow).getByTestId("cell-rental");
    expect(rentalCell.querySelector("input")).toBeNull();
    expect(rentalCell.getAttribute("aria-readonly")).toBe("true");
  });

  it('"rental em-dash": whole-unit rental cell shows "—" when subRows[0].rental is null', () => {
    const row = makeRow({
      isWholeUnit: true,
      entry: makeEntry({}),
      subRows: [makeSubRow({ listingId: "L1", tenancyId: "T1", rental: null })],
    });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} />);
    const unitRow = screen.getByRole("row", { name: /PV9 A-13-13/ });
    const cell = within(unitRow).getByTestId("cell-rental");
    expect(cell).toHaveTextContent("—");
    expect(cell).toHaveClass("text-center", "align-middle", "bg-transparent");
    expect(cell).not.toHaveClass("text-right");
  });

  it('"grain": a unit row WITH sub-rows locks its inline cell-previousKwh', () => {
    const row = makeRow({
      entry: makeEntry({}),
      subRows: [
        makeSubRow({ listingId: "L1", tenancyId: "T1" }),
        makeSubRow({ listingId: "L2", tenancyId: "T2" }),
      ],
    });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} />);
    const unitRow = screen.getByRole("row", { name: /PV9 A-13-13/ });
    const cell = within(unitRow).getByTestId("cell-previousKwh");
    expect(cell.getAttribute("aria-readonly")).toBe("true");
  });

  it('"band order": TA sits inside Rent & Deposit and management fee has one SST-inclusive column', () => {
    render(<GridTable rows={[]} columns={CURRENT_COLUMNS} />);
    const bands = screen.getAllByTestId("band-header").map((el) => el.textContent);
    expect(bands).toEqual([
      "Rent & Deposit", "Cleaning", "TNB", "Water", "WiFi",
      "Maint Fee", "Recurring", "Tenant Expenses", "Owner Expenses", "Management Fee", "Owner Payout",
    ]);
    expect(screen.queryByText(/aircond/i)).toBeNull();
  });

  it("combines new and renewal agreement fees into one SST-inclusive TA cell", () => {
    const row = makeRow({
      agreementFees: {
        new: { amount: "350.00", outstanding: "350.00", state: "saved" },
        renewal: { amount: "250.00", outstanding: "0.00", state: "paid" },
      },
      managementFee: { nonSst: "250.00", sst: "20.00", total: "270.00" },
    });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} />);
    expect(screen.getByTestId("cell-agreementFee")).toHaveTextContent("600.00");
    expect(screen.getByTestId("cell-managementFeeSst")).toHaveTextContent("270.00");
    expect(billingStateForCell(row, row.apartmentId, "agreementFee")).toBe("saved");
  });

  it("distinguishes no TA charge from a deliberately saved zero-value TA charge", () => {
    const noTa = makeRow({
      agreementFees: {
        new: { amount: "0.00", outstanding: "0.00", state: "none" },
        renewal: { amount: "0.00", outstanding: "0.00", state: "none" },
      },
    });
    const zeroTa = makeRow({
      apartmentId: "APT-ZERO-TA",
      unitCode: "A-01-02",
      agreementFees: {
        new: { amount: "0.00", outstanding: "0.00", state: "saved" },
        renewal: { amount: "0.00", outstanding: "0.00", state: "none" },
      },
    });

    const { rerender } = render(<GridTable rows={[noTa]} columns={CURRENT_COLUMNS} />);
    expect(screen.getByTestId("cell-agreementFee")).toHaveTextContent("—");

    rerender(<GridTable key="zero-ta" rows={[zeroTa]} columns={CURRENT_COLUMNS} />);
    expect(billingStateForCell(zeroTa, zeroTa.apartmentId, "agreementFee")).toBe("saved");
    const cell = screen.getByTestId("cell-agreementFee");
    expect(cell).toHaveTextContent("0.00");
    expect(cell).toHaveAttribute("data-billing-state", "saved");
  });

  it('"prior strip": 3 months selected → DOM has NO prior-month cells for rental/maintenance/meter/SST-split', () => {
    const row = makeRow({
      priorMonths: [
        { period: "2026-06-01", cleaning: "50.00", tnb: "120.00", air: "30.00", wifi: "80.00", others: "0.00" },
        { period: "2026-05-01", cleaning: "50.00", tnb: "110.00", air: "30.00", wifi: "80.00", others: "0.00" },
        { period: "2026-04-01", cleaning: "50.00", tnb: "100.00", air: "30.00", wifi: "80.00", others: "0.00" },
      ],
    });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} />);
    const strips = screen.getAllByTestId("prior-month-strip");
    expect(strips).toHaveLength(3);
    for (const strip of strips) {
      expect(within(strip).queryAllByRole("textbox")).toHaveLength(0);
      expect(within(strip).queryByTestId("cell-rental")).toBeNull();
      expect(within(strip).queryByTestId("cell-maintenanceFee")).toBeNull();
      expect(within(strip).queryByTestId("cell-previousKwh")).toBeNull();
      expect(within(strip).queryByTestId("cell-currentKwh")).toBeNull();
      expect(within(strip).queryByTestId("cell-tenantExpWithSst")).toBeNull();
      expect(within(strip).queryByTestId("cell-ownerExpWithSst")).toBeNull();
    }
  });

  it('"cleaning read-only" (recurring-charges R9): the auto-fill amount shows read-only in the active cleaning cell, never an editable textbox', () => {
    const row = makeRow({
      entry: makeEntry({ cleaning: null, cleaningBearer: "owner" }),
      bearerConfig: makeBearerConfig({ cleaningBearer: "owner", cleaningRecurringAmount: "100.00" }),
      subRows: [makeSubRow({ listingId: "L1", tenancyId: "T1" })],
    });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} />);
    const unitRow = screen.getByRole("row", { name: /PV9 A-13-13/ });
    const cell = within(unitRow).getByTestId("cell-cleaningOwner");
    expect(cell).toHaveTextContent("100.00"); // settings-controlled amount, generated read-only
    expect(cell.querySelector("input")).toBeNull(); // no editable textbox (R9)
  });

  it('"owner SST split": owner expenses RM20 withSST + RM15.50 non render ownerExpWithSst "20.00" and ownerExpNonSst "15.50"', () => {
    const row = makeRow({
      entry: makeEntry({}),
      subRows: [makeSubRow({ listingId: "L1", tenancyId: "T1" })],
      expenses: {
        tenant: { total: "0.00", withSstTotal: "0.00", count: 0 },
        owner: { total: "35.50", withSstTotal: "20.00", count: 2 },
      },
    });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} />);
    const unitRow = screen.getByRole("row", { name: /PV9 A-13-13/ });
    expect(within(unitRow).getByTestId("cell-ownerExpWithSst")).toHaveTextContent("20.00");
    expect(within(unitRow).getByTestId("cell-ownerExpNonSst")).toHaveTextContent("15.50");
  });

  it("replaces Add Cost with non-clickable Profit/Loss labels after each expense cell's costs are completed", () => {
    const row = makeRow({
      entry: makeEntry({}),
      expenses: {
        tenant: {
          total: "220.00", withSstTotal: "100.00", count: 2,
          nonSstCount: 1, withSstCount: 1,
          nonSstActionRequiredCount: 0, withSstActionRequiredCount: 0,
          nonSstGrossMargin: "20.00", withSstGrossMargin: "-30.00",
        },
        owner: { total: "0.00", withSstTotal: "0.00", count: 0 },
      },
    });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} onViewExpenses={() => {}} />);
    const unitRow = screen.getByRole("row", { name: /PV9 A-13-13/ });
    const [profit, loss] = within(unitRow).getAllByTestId("view-expenses-tenant-margin");
    expect(profit).toHaveTextContent("Profit RM20.00");
    expect(loss).toHaveTextContent("Loss RM30.00");
    expect(profit.tagName).toBe("SPAN");
    expect(loss.tagName).toBe("SPAN");
    expect(within(unitRow).queryByRole("button", { name: "Add Cost" })).toBeNull();
  });

  it('"wifi read-only" (recurring-charges R9): a saved wifiBearer "tenant" row shows the value read-only on the tenant column, "—" on owner — no textbox on either', () => {
    const row = makeRow({
      entry: makeEntry({ wifi: "88.00", wifiBearer: "tenant" }),
      bearerConfig: makeBearerConfig({ wifiBearer: "tenant" }),
    });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} />);
    const unitRow = screen.getByRole("row", { name: /PV9 A-13-13/ });
    // R9: wifi is settings-controlled read-only on BOTH sides; the tenant side is the ACTIVE
    // (value-bearing) one for a tenant bearer, the owner side shows "—". Neither is editable.
    const tenantCell = within(unitRow).getByTestId("cell-wifiTenant");
    expect(tenantCell.querySelector("input")).toBeNull();
    expect(tenantCell.getAttribute("aria-readonly")).toBe("true");
    expect(tenantCell).toHaveTextContent("88.00"); // active side shows the value
    const ownerCell = within(unitRow).getByTestId("cell-wifiOwner");
    expect(ownerCell.getAttribute("aria-readonly")).toBe("true");
    expect(ownerCell).toHaveTextContent("—");
  });

  // R5 regression guard — proves the frozen-snapshot invariant setting-drawer's
  // new grid-invalidation depends on: once a month is Saved, entry.*Bearer is
  // a SNAPSHOT that must keep winning over a manager's live bearerConfig
  // edits, even after the invalidation-triggered refetch brings in fresh
  // bearerConfig data. Pins existing isApplicable() behavior — UNCHANGED by
  // this task — so a live grid refetch never silently moves a saved month's
  // owner/tenant split.
  it('"entry snapshot wins": saved row keeps entry.cleaningBearer "owner" as the active (value-bearing) read-only side even though bearerConfig.cleaningBearer is now "tenant"', () => {
    const row = makeRow({
      entry: makeEntry({ cleaningBearer: "owner", cleaning: "77.00" }),
      bearerConfig: makeBearerConfig({ cleaningBearer: "tenant" }),
    });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} />);
    const unitRow = screen.getByRole("row", { name: /PV9 A-13-13/ });
    // R9: cleaning is read-only. The snapshot bearer (owner) still governs which side is ACTIVE
    // (shows the value) vs "—", even though the live bearerConfig now says tenant.
    const ownerCell = within(unitRow).getByTestId("cell-cleaningOwner");
    expect(ownerCell.querySelector("input")).toBeNull(); // read-only now (R9)
    expect(ownerCell.getAttribute("aria-readonly")).toBe("true");
    expect(ownerCell).toHaveTextContent("77.00"); // snapshot owner side is active
    const tenantCell = within(unitRow).getByTestId("cell-cleaningTenant");
    expect(tenantCell.getAttribute("aria-readonly")).toBe("true");
    expect(tenantCell).toHaveTextContent("—");
  });

  // Task 7 (R2): a single occupancy tag on the unit row — "Whole unit ·
  // {tenant}" for a whole-unit tenancy, "{N} rooms" for a partitioned
  // apartment. Display-only; existing sub-row rendering is unchanged.
  it('"whole unit tag": whole-unit row shows owner then tenant on separate lines', () => {
    const row = makeRow({
      isWholeUnit: true,
      ownerName: "Owner Lee",
      entry: makeEntry({}),
      subRows: [makeSubRow({ listingId: "L1", tenancyId: "T1", partyName: "Ali", rental: "3000.00" })],
    });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} />);
    const unitRow = screen.getByRole("row", { name: /PV9 A-13-13/ });
    // getByTestId (singular) throws on 0 OR 2+ matches — this also proves
    // the tag renders exactly once, not the whole-unit case's zero nested
    // sub-rows re-emitting it.
    expect(within(unitRow).getByTestId("unit-occupancy-tag")).toHaveTextContent("Whole unit: Owner Lee");
    expect(within(unitRow).getByTestId("whole-unit-tenant")).toHaveTextContent("Tenant: Ali");
    /* Retired format assertion kept in history:
    expect(within(unitRow).getByTestId("unit-occupancy-tag")).toHaveTextContent("Whole unit · Ali");
    */
  });

  it('"partitioned rooms tag": partitioned row (3 rooms) shows "3 rooms" occupancy tag and keeps its tenant-sub-rows', () => {
    const row = makeRow({
      entry: makeEntry({}),
      subRows: [
        makeSubRow({ listingId: "L1", tenancyId: "T1", partyName: "Ali" }),
        makeSubRow({ listingId: "L2", tenancyId: "T2", partyName: "Bala" }),
        makeSubRow({ listingId: "L3", tenancyId: "T3", partyName: "Chong" }),
      ],
    });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} />);
    const unitRow = screen.getByRole("row", { name: /PV9 A-13-13/ });
    expect(within(unitRow).getByTestId("unit-occupancy-tag")).toHaveTextContent("3 rooms");
    // Guards against the tag ALSO being rendered per tenant-sub-row.
    expect(screen.getAllByTestId("unit-occupancy-tag")).toHaveLength(1);
    expect(screen.getAllByTestId("tenant-sub-row")).toHaveLength(3);
  });

  it('"whole unit vacant": whole unit with no owner or tenant shows an empty owner value', () => {
    const row = makeRow({
      isWholeUnit: true,
      entry: makeEntry({}),
      subRows: [makeSubRow({ listingId: "L1", tenancyId: null, partyName: null })],
    });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} />);
    const unitRow = screen.getByRole("row", { name: /PV9 A-13-13/ });
    const tag = within(unitRow).getByTestId("unit-occupancy-tag");
    expect(tag).toHaveTextContent("Whole unit");
    expect(tag.textContent).toBe("Whole unit: —");
    expect(screen.queryByTestId("whole-unit-tenant")).toBeNull();
  });

  // Task 8 (R4) — the ~17-column matrix scrolls horizontally inside
  // TableWrap's overflow-x-auto container; without a pinned Unit column, row
  // identity is lost mid-scroll. Pins all four Unit-column cells (header +
  // body unit-row + nested tenant sub-row + prior-month strip) with
  // `sticky left-0` and an OPAQUE background token each — a transparent
  // sticky cell would let scrolled-away columns bleed through underneath it.
  it('"sticky unit column": header Unit th carries sticky + left-0 + top-0 + opaque bg', () => {
    render(<GridTable rows={[]} columns={CURRENT_COLUMNS} />);
    const headerCell = screen.getByRole("columnheader", { name: "Unit" });
    expect(headerCell.className).toContain("sticky");
    expect(headerCell.className).toContain("left-0");
    expect(headerCell.className).toContain("top-0");
    expect(headerCell.className).toContain("bg-[var(--page-bg)]");
  });

  // Task 11 (R4b) — full sticky header: on vertical scroll the WHOLE header
  // (both thead rows), not just the Unit corner, must stay visible. Row 1
  // (band groups) pins at top-0; row 2 (per-column headers) pins at top-10
  // (2.5rem = row 1's own h-10 height) so it sits directly below row 1
  // instead of overlapping it.
  it('"sticky full header (R4b)": a band-header cell (row 1) carries sticky + top-0 + opaque bg; a column-header cell (row 2) carries sticky + top-10 + opaque bg', () => {
    render(<GridTable rows={[]} columns={CURRENT_COLUMNS} />);

    const bandHeaderCell = screen.getAllByTestId("band-header")[0];
    expect(bandHeaderCell.className).toContain("sticky");
    expect(bandHeaderCell.className).toContain("top-0");
    expect(bandHeaderCell.className).toContain("bg-[var(--page-bg)]");

    const columnHeaderCell = screen.getByTestId("col-header-rental");
    expect(columnHeaderCell.className).toContain("sticky");
    expect(columnHeaderCell.className).toContain("top-10");
    expect(columnHeaderCell.className).toContain("bg-[var(--page-bg)]");
  });

  it('"sticky unit column": body + sub-row + prior-strip Unit td cells each carry sticky + left-0 + opaque bg + z-10 (Task 11: lowered below the z-20 header so the header wins at their on-scroll intersection)', () => {
    const row = makeRow({
      entry: makeEntry({}),
      subRows: [makeSubRow({ listingId: "L1", tenancyId: "T1", partyName: "Ali" })],
      priorMonths: [
        { period: "2026-06-01", cleaning: "50.00", tnb: "120.00", air: "30.00", wifi: "80.00", others: "0.00" },
      ],
    });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} />);

    const unitRow = screen.getByRole("row", { name: /PV9 A-13-13/ });
    const unitCell = within(unitRow).getByTestId("unit-occupancy-tag").closest("td");
    expect(unitCell).not.toBeNull();
    expect(unitCell!.className).toContain("sticky");
    expect(unitCell!.className).toContain("left-0");
    expect(unitCell!.className).toContain("bg-[var(--page-bg)]");
    expect(unitCell!.className).toContain("z-10");
    expect(unitCell!.className).not.toContain("z-20");

    const subRow = screen.getByTestId("tenant-sub-row");
    const subRowCell = within(subRow).getByText(/↳/).closest("td");
    expect(subRowCell).not.toBeNull();
    expect(subRowCell!.className).toContain("sticky");
    expect(subRowCell!.className).toContain("left-0");
    expect(subRowCell!.className).toContain("bg-background");
    expect(subRowCell!.className).toContain("z-10");
    expect(subRowCell!.className).not.toContain("z-20");

    const priorStrip = screen.getByTestId("prior-month-strip");
    const priorCell = within(priorStrip).getByText("2026-06-01").closest("td");
    expect(priorCell).not.toBeNull();
    expect(priorCell!.className).toContain("sticky");
    expect(priorCell!.className).toContain("left-0");
    expect(priorCell!.className).toContain("bg-[var(--page-bg)]");
    expect(priorCell!.className).toContain("z-10");
    expect(priorCell!.className).not.toContain("z-20");
  });

  // Task 11 (R2 grammar fix) — the partitioned-apartment occupancy tag must
  // pluralise correctly and never announce "0 rooms". "3 rooms" (plural, N)
  // is covered by the existing "partitioned rooms tag" test above (unchanged
  // by this task); these two cover the singular and zero boundaries.
  it('"room tag singular": a partitioned row with exactly 1 sub-row shows "1 room" (singular, not "1 rooms")', () => {
    const row = makeRow({
      entry: makeEntry({}), // isWholeUnit: false (default) => partitioned, even with 1 room
      subRows: [makeSubRow({ listingId: "L1", tenancyId: "T1", partyName: "Ali" })],
    });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} />);
    const unitRow = screen.getByRole("row", { name: /PV9 A-13-13/ });
    expect(within(unitRow).getByTestId("unit-occupancy-tag")).toHaveTextContent("1 room");
    // guards the singular fix: must NOT say "1 rooms"
    expect(within(unitRow).getByTestId("unit-occupancy-tag").textContent).toBe("1 room");
  });

  it('"room tag vacant": a partitioned row (hasNestedSubRows true) with 0 sub-rows shows "Vacant" (never "0 rooms")', () => {
    const row = makeRow({
      entry: makeEntry({}), // isWholeUnit: false (default) => partitioned
      subRows: [],
    });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} />);
    const unitRow = screen.getByRole("row", { name: /PV9 A-13-13/ });
    const tag = within(unitRow).getByTestId("unit-occupancy-tag");
    expect(tag).toHaveTextContent("Vacant");
    expect(tag.textContent).toBe("Vacant");
  });

  it('"remediation guidance — AIRCON_EXCEEDS_TNB": a WHOLE-unit row (this code only fires when privateAircond is off) explains aircond is part of the TNB bill and how to fix it', () => {
    const row = makeRow({
      entry: makeEntry({}),
      previewError: { code: "AIRCON_EXCEEDS_TNB" },
    });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} />);
    const unitRow = screen.getByRole("row", { name: /PV9 A-13-13/ });
    const indicator = within(unitRow).getByTitle(
      "Whole unit: aircond is part of the TNB bill, so it can't be higher than the TNB total. Lower the aircond reading (Current kWh) or raise the TNB total. This amount is auto-calculated and can't be edited.",
    );
    expect(indicator).toBeInTheDocument();
  });

  it('"remediation guidance — TNB_UNDERSHOOT": a row with previewError.code "TNB_UNDERSHOOT" shows near-equal TNB guidance (no whole-unit claim — this code is thrown before the unit mode is known)', () => {
    const row = makeRow({
      entry: makeEntry({}),
      previewError: { code: "TNB_UNDERSHOOT" },
    });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} />);
    const unitRow = screen.getByRole("row", { name: /PV9 A-13-13/ });
    const indicator = within(unitRow).getByTitle(
      "The TNB total is just below the aircond total. Raise the TNB total to at least the aircond amount, or lower the aircond reading (Current kWh). This amount is auto-calculated and can't be edited.",
    );
    expect(indicator).toBeInTheDocument();
  });

  it("shows an edited-by tooltip on an edited unit row", () => {
    const row = makeRow({
      entry: makeEntry({ lastEditedByName: "Uma", updatedAt: "2026-07-14T10:00:00.000Z" }),
    });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} />);
    expect(screen.getByTitle(/Edited by Uma ·/)).toBeInTheDocument();
  });

  it("shows a dash for a never-edited row", () => {
    const row = makeRow({ entry: null });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} />);
    expect(screen.getByTitle("Not edited")).toBeInTheDocument();
  });

  // Final-review fix pass, FIX 1: a SAVED entry (real @updatedAt token, always
  // non-null — Prisma stamps it on every write) whose lastEditedByName is
  // null must still render "Not edited" — updatedById is a nullable column
  // with no backfill, so EVERY pre-existing prod/UAT row has a real
  // updatedAt but a null lastEditedByName. Gating the dash on BOTH name AND
  // at being null (the pre-fix behaviour) would wrongly show "Edited · {date}"
  // with no name for every such row. Spec R7 + Error Handling define the
  // null contract on the NAME, not the timestamp.
  it('shows "Not edited" for a saved entry with a null lastEditedByName and a real updatedAt', () => {
    const row = makeRow({
      entry: makeEntry({ lastEditedByName: null, updatedAt: "2026-07-01T00:00:00.000Z" }),
    });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} />);
    expect(screen.getByTitle("Not edited")).toBeInTheDocument();
  });

  it("shows an edited-by tooltip on an edited tenant sub-row", () => {
    const row = makeRow({
      entry: makeEntry({}),
      subRows: [
        makeSubRow({
          listingId: "L1",
          tenancyId: "T1",
          partyName: "Ali",
          lastEditedByName: "Siti",
          updatedAt: "2026-07-10T08:30:00.000Z",
        }),
      ],
    });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} />);
    expect(screen.getByTitle(/Edited by Siti ·/)).toBeInTheDocument();
  });

  // Punch-list Item 5: each unit row shows its parent property/condo name under
  // the unit code — the bare unit code alone is ambiguous under the "All"
  // property filter, where units from different condos are interleaved.
  it('"property name": the unit row renders row.propertyName under the unit code', () => {
    const row = makeRow({ propertyName: "Sunway GEO Residences", entry: makeEntry({}) });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} />);
    const unitRow = screen.getByRole("row", { name: /PV9 A-13-13/ });
    expect(within(unitRow).getByText("Sunway GEO Residences")).toBeInTheDocument();
    // Lives inside the pinned Unit td, alongside the unit code (same cell).
    const unitCell = within(unitRow).getByText("Sunway GEO Residences").closest("td");
    expect(within(unitCell!).getByText("PV9 A-13-13")).toBeInTheDocument();
  });

  it("draws strong category boundaries while keeping inner sub-columns unaccented", () => {
    render(<GridTable rows={[makeRow({ entry: makeEntry({ tnbTotal: "100.00" }) })]} columns={CURRENT_COLUMNS} />);
    expect(screen.getByTestId("col-header-tnbOwner")).toHaveClass("border-l-2");
    expect(screen.getByTestId("col-header-amount")).toHaveClass("border-r-2");
    expect(screen.getByTestId("col-header-currentKwh")).not.toHaveClass("border-l-2", "border-r-2");
    expect(screen.getByTestId("cell-tnbOwner")).toHaveClass("border-l-2");
    expect(screen.getByTestId("cell-amount")).toHaveClass("border-r-2");
  });

  it("centres matrix values and numeric inputs while leaving unit details separate", () => {
    render(<GridTable rows={[makeRow({
      isWholeUnit: true,
      entry: makeEntry({ tnbTotal: "100.00" }),
      subRows: [makeSubRow({ rental: "1200.00" })],
    })]} columns={CURRENT_COLUMNS} />);
    expect(screen.getByTestId("cell-rental")).toHaveClass("text-center", "align-middle");
    expect(screen.getByTestId("cell-tnbTenant")).toHaveClass("text-center", "align-middle");
    expect(within(screen.getByTestId("cell-tnbTenant")).getByRole("textbox")).toHaveClass("text-center");
  });

  it("shows 0.00 for every empty monetary total and a dash only for meter readings", () => {
    render(<GridTable rows={[makeRow({
      isWholeUnit: true,
      entry: makeEntry({}),
      subRows: [makeSubRow({ previousKwh: null, currentKwh: null, amount: null })],
    })]} columns={CURRENT_COLUMNS} />);

    for (const columnId of ["tnbOwner", "tnbTenant", "amount", "airOwner", "airTenant", "wifiOwner", "wifiTenant"]) {
      expect(screen.getByTestId(`total-${columnId}`)).toHaveTextContent("0.00");
    }
    expect(screen.getByTestId("total-previousKwh")).toHaveTextContent("—");
    expect(screen.getByTestId("total-currentKwh")).toHaveTextContent("—");
  });

  it("shows each unit's projected Owner Payout, monthly total, and owner-report trigger", async () => {
    let opened: GridRow | null = null;
    const row = makeRow({
      ownerPartyId: "OWNER-1",
      isWholeUnit: true,
      entry: makeEntry({
        cleaning: "100.00", tnbTotal: "200.00", airSelangor: "50.00",
        wifi: "80.00", maintenanceFee: "70.00", tnbPattern: "absorbed", airPattern: "absorbed",
      }),
      bearerConfig: makeBearerConfig({ tnbPattern: "absorbed", airPattern: "absorbed" }),
      subRows: [makeSubRow({ rental: "3000.00", deposit: "1000.00" })],
      recurring: { owner: { total: "30.00", count: 1 }, tenant: { total: "0.00", count: 0 } },
      expenses: {
        tenant: { total: "0.00", withSstTotal: "0.00", count: 0 },
        owner: { total: "35.00", withSstTotal: "0.00", count: 1 },
      },
      managementFee: { nonSst: "250.00", sst: "20.00", total: "270.00" },
    });
    render(<MemoryRouter><GridTable rows={[row]} columns={CURRENT_COLUMNS} onViewOwnerReport={(selected) => { opened = selected; }} /></MemoryRouter>);
    expect(screen.getByTestId("cell-ownerPayout")).toHaveTextContent("3165.00");
    expect(screen.getByTestId("cell-ownerPayout").querySelector("input")).toBeNull();
    expect(screen.getByTestId("total-ownerPayout")).toHaveTextContent("3165.00");
    await userEvent.click(screen.getByRole("button", { name: "View owner monthly report for PV9 A-13-13" }));
    expect(opened).toBe(row);
  });

  it("automates saved/billed/paid/re-bill cell colours while empty cells stay unpainted", () => {
    const saved = makeRow({
      entryId: "E1",
      billed: false,
      entry: makeEntry({ cleaning: "25.00", wifi: "10.00" }),
    });
    const { rerender } = render(<GridTable rows={[saved]} columns={CURRENT_COLUMNS} />);
    let cell = screen.getByTestId("cell-cleaningOwner");
    expect(cell).toHaveAttribute("data-billing-state", "saved");
    expect(cell).toHaveStyle({ backgroundColor: "rgb(255, 140, 0)" });
    expect(screen.getByTestId("cell-airOwner")).not.toHaveAttribute("data-billing-state");

    const unpaidSettlement = { status: "unpaid" as const, cells: { ...emptySettlementCells(), cleaningOwner: "unpaid" as const, wifiOwner: "unpaid" as const }, rooms: {}, expenseLines: {} };
    rerender(<GridTable rows={[{ ...saved, billed: true, billedAt: "2026-08-01T00:00:00.000Z", settlement: unpaidSettlement }]} columns={CURRENT_COLUMNS} />);
    cell = screen.getByTestId("cell-cleaningOwner");
    expect(cell).toHaveAttribute("data-billing-state", "billed-unpaid");
    expect(cell).toHaveStyle({ backgroundColor: "rgb(255, 255, 0)" });

    const paidSettlement = { status: "paid" as const, cells: { ...emptySettlementCells(), cleaningOwner: "paid" as const }, rooms: {}, expenseLines: {} };
    rerender(<GridTable rows={[{ ...saved, billed: true, billedAt: "2026-08-01T00:00:00.000Z", paymentStatus: "paid", settlement: paidSettlement }]} columns={CURRENT_COLUMNS} />);
    cell = screen.getByTestId("cell-cleaningOwner");
    expect(cell).toHaveAttribute("data-billing-state", "paid");
    expect(cell).toHaveStyle({ backgroundColor: "rgb(0, 255, 0)" });

    rerender(<GridTable rows={[{ ...saved, billed: true, billedAt: "2026-08-01T00:00:00.000Z", hasUnbilledChanges: true, settlement: unpaidSettlement }]} columns={CURRENT_COLUMNS} isCellPendingRebill={(cellKey, columnId) => cellKey === "APT1" && columnId === "cleaningOwner"} />);
    cell = screen.getByTestId("cell-cleaningOwner");
    expect(cell).toHaveAttribute("data-billing-state", "changed");
    expect(cell).toHaveStyle({ backgroundColor: "rgb(255, 0, 0)" });
    expect(screen.getByTestId("cell-wifiOwner")).toHaveAttribute("data-billing-state", "billed-unpaid");
    expect(screen.getByTestId("cell-wifiOwner")).toHaveStyle({ backgroundColor: "rgb(255, 255, 0)" });
  });

  it("paints single-column utilities from their actual bearer-side bill", () => {
    const live = (cells: Partial<ReturnType<typeof emptySettlementCells>>) => ({
      status: "unpaid" as const,
      cells: { ...emptySettlementCells(), ...cells },
      rooms: {},
      expenseLines: {},
    });
    const base = makeRow({
      entryId: "E1",
      billed: true,
      billedAt: "2026-08-01T00:00:00.000Z",
      entry: makeEntry({
        tnbTotal: "580.00",
        tnbPattern: "recharged",
        maintenanceFee: "50.00",
        maintenanceFeeBearer: "tenant",
      }),
      settlement: live({ tnbTenant: "unpaid", maintenanceTenant: "unpaid" }),
    });
    const { rerender } = render(<GridTable rows={[base]} columns={CURRENT_COLUMNS} />);

    expect(within(screen.getByTestId("cell-tnbTenant")).getByRole("textbox")).toHaveValue("580.00");
    expect(screen.getByTestId("cell-tnbOwner")).toHaveTextContent("—");
    expect(screen.getByTestId("cell-tnbTenant")).toHaveAttribute("data-billing-state", "billed-unpaid");
    expect(screen.getByTestId("cell-tnbOwner")).not.toHaveAttribute("data-billing-state");
    expect(screen.getByTestId("cell-maintenanceFee")).toHaveAttribute("data-billing-state", "billed-unpaid");

    rerender(<GridTable rows={[{
      ...base,
      entry: makeEntry({ tnbTotal: "580.00", tnbPattern: "absorbed" }),
      settlement: live({ tnbOwner: "unpaid" }),
    }]} columns={CURRENT_COLUMNS} />);
    expect(within(screen.getByTestId("cell-tnbOwner")).getByRole("textbox")).toHaveValue("580.00");
    expect(screen.getByTestId("cell-tnbTenant")).toHaveTextContent("—");
    expect(screen.getByTestId("cell-tnbOwner")).toHaveAttribute("data-billing-state", "billed-unpaid");
  });

  it("rental uses only billed-unpaid yellow and paid fluorescent green", () => {
    const rentalRow = makeRow({
      isWholeUnit: true,
      entryId: "E1",
      entry: makeEntry({}),
      subRows: [makeSubRow({ rental: "1200.00" })],
      billed: false,
    });
    const { rerender } = render(<GridTable rows={[rentalRow]} columns={CURRENT_COLUMNS} />);
    let rental = screen.getByTestId("cell-rental");
    expect(rental).not.toHaveAttribute("data-billing-state");

    rerender(<GridTable rows={[{ ...rentalRow, billed: true, billedAt: "2026-08-01T00:00:00.000Z" }]} columns={CURRENT_COLUMNS} />);
    rental = screen.getByTestId("cell-rental");
    expect(rental).toHaveAttribute("data-billing-state", "billed-unpaid");
    expect(rental).toHaveStyle({ backgroundColor: "rgb(255, 255, 0)" });

    rerender(<GridTable rows={[{ ...rentalRow, billed: true, billedAt: "2026-08-01T00:00:00.000Z", settlement: { status: "partial", cells: emptySettlementCells(), rooms: {}, expenseLines: {} } }]} columns={CURRENT_COLUMNS} />);
    rental = screen.getByTestId("cell-rental");
    expect(rental).toHaveAttribute("data-billing-state", "billed-unpaid");
    expect(rental).toHaveStyle({ backgroundColor: "rgb(255, 255, 0)" });

    rerender(<GridTable rows={[{ ...rentalRow, billed: true, billedAt: "2026-08-01T00:00:00.000Z", paymentStatus: "paid" }]} columns={CURRENT_COLUMNS} />);
    rental = screen.getByTestId("cell-rental");
    expect(rental).toHaveAttribute("data-billing-state", "paid");
    expect(rental).toHaveStyle({ backgroundColor: "rgb(0, 255, 0)" });
  });

  it("paints tenant-visible rental outstanding yellow even when the grid row itself was never billed", () => {
    const rentalRow = makeRow({
      isWholeUnit: true,
      billed: false,
      billedAt: null,
      subRows: [makeSubRow({ rental: "1064.52", rentalBillingState: "billed-unpaid" })],
    });
    render(<GridTable rows={[rentalRow]} columns={CURRENT_COLUMNS} />);
    const rental = screen.getByTestId("cell-rental");
    expect(rental).toHaveTextContent("1064.52");
    expect(rental).toHaveAttribute("data-billing-state", "billed-unpaid");
    expect(rental).toHaveStyle({ backgroundColor: "rgb(255, 255, 0)" });
  });

  it("shows the selected month's deposit beside rental with its own document/payment colour", () => {
    const depositRow = makeRow({
      isWholeUnit: true,
      subRows: [makeSubRow({ deposit: "7500.00", depositBillingState: "saved" })],
    });
    const { rerender } = render(<GridTable rows={[depositRow]} columns={CURRENT_COLUMNS} />);
    let deposit = screen.getByTestId("cell-deposit");
    expect(deposit).toHaveTextContent("7500.00");
    expect(deposit).toHaveAttribute("data-billing-state", "saved");
    expect(deposit).toHaveStyle({ backgroundColor: "rgb(255, 140, 0)" });

    rerender(<GridTable rows={[{
      ...depositRow,
      subRows: [makeSubRow({ deposit: "7500.00", depositBillingState: "billed-unpaid" })],
    }]} columns={CURRENT_COLUMNS} />);
    deposit = screen.getByTestId("cell-deposit");
    expect(deposit).toHaveStyle({ backgroundColor: "rgb(255, 255, 0)" });

    rerender(<GridTable rows={[{
      ...depositRow,
      subRows: [makeSubRow({ deposit: "7500.00", depositBillingState: "paid" })],
    }]} columns={CURRENT_COLUMNS} />);
    deposit = screen.getByTestId("cell-deposit");
    expect(deposit).toHaveStyle({ backgroundColor: "rgb(0, 255, 0)" });
  });

  it("colour filtering matches a unit when even one cell carries the selected automatic colour", () => {
    const row = makeRow({
      isWholeUnit: true,
      subRows: [makeSubRow({ deposit: "7500.00", depositBillingState: "billed-unpaid" })],
    });
    expect(rowHasBillingState(row, "billed-unpaid", CURRENT_COLUMNS)).toBe(true);
    expect(rowHasBillingState(row, "paid", CURRENT_COLUMNS)).toBe(false);
  });
});
