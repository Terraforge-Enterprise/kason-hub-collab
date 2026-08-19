// P4 Task 3 — render integration for the active-cell nav layer. Verifies the
// three optional GridTable props (isCellActive / onCellActivate / registerCell)
// mark exactly the active cell, activate on click, register the DOM node, and —
// when ABSENT — leave the frozen render byte-identical (parity). Fixtures build
// VALID GridRow/GridEntryDto shapes (never a simplified shape).
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { GridRow, GridEntryDto, GridBearerConfigDto, GridSubRow } from "@/api/bills-grid";
import { GridTable } from "../grid-table";
import { CURRENT_COLUMNS } from "../columns";

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
    isWholeUnit: false,
    ...partial,
  };
}

describe("GridTable active-cell nav wiring", () => {
  it("active marker on exactly the active editable cell", () => {
    const row = makeRow({ isWholeUnit: true, entry: makeEntry({}), subRows: [makeSubRow({ rental: "3000.00" })] });
    // cleaningOwner is an editable unit-grain cell on APT1.
    render(
      <GridTable
        rows={[row]}
        columns={CURRENT_COLUMNS}
        isCellActive={(cellKey, columnId) => cellKey === "APT1" && columnId === "cleaningOwner"}
      />,
    );
    const active = screen.getByTestId("cell-cleaningOwner");
    expect(active.getAttribute("data-active")).toBe("true");
    // P4 Task 4 (ring-visibility fix): the active cell carries the VISIBLE,
    // high-contrast --primary ring, and it is a SOLID/outset border (NOT
    // ring-inset) so it is visually distinct from the inset --primary selection
    // ring. The old near-invisible --accent token is gone entirely.
    expect(active.className).toContain("ring-[var(--primary)]");
    expect(active.className).toContain("ring-2");
    expect(active.className).not.toContain("ring-inset"); // distinct from the inset selection ring
    expect(active.className).not.toContain("ring-[var(--accent)]");
    // No other rendered cell carries data-active.
    const allActive = document.querySelectorAll('[data-active="true"]');
    expect(allActive).toHaveLength(1);
  });

  it("active+selected cell (Fix 1 / Task 3 tint): shows the OUTSET active ring and NOT the in-range tint", () => {
    // A cell that is BOTH active AND inside a shift-range must keep its distinct
    // outset active ring — the in-range TINT (Task 3) is gated on !active so it
    // never paints under the active cell (which reads as the active ring alone,
    // matching Excel's active-cell-inside-a-selection look).
    const row = makeRow({ isWholeUnit: true, entry: makeEntry({}), subRows: [makeSubRow({ rental: "3000.00" })] });
    render(
      <GridTable
        rows={[row]}
        columns={CURRENT_COLUMNS}
        isCellActive={(cellKey, columnId) => cellKey === "APT1" && columnId === "cleaningOwner"}
        isCellSelected={(cellKey, columnId) => cellKey === "APT1" && columnId === "cleaningOwner"}
      />,
    );
    const cell = screen.getByTestId("cell-cleaningOwner");
    // Both data attributes are present (the cell IS in the range and IS active).
    expect(cell.getAttribute("data-active")).toBe("true");
    expect(cell.getAttribute("data-selected")).toBe("true");
    // Visually it carries the OUTSET active ring, NOT the inset selection ring…
    expect(cell.className).toContain("ring-2");
    expect(cell.className).toContain("ring-[var(--primary)]");
    expect(cell.className).not.toContain("ring-inset");
    // …and NOT the in-range tint (the tint is gated on !active).
    expect(cell.className).not.toContain("bg-[var(--primary)]/10");
  });

  it("selected-but-not-active cell (Task 3): carries the --primary TINT fill, not the inset ring", () => {
    // Task 3: the in-range visual is a light --primary tint fill (reads as a
    // continuous block for a rectangle), NOT the old ring-inset outline. A range
    // cell that is not the active one gets the tint and no ring at all.
    const row = makeRow({ isWholeUnit: true, entry: makeEntry({}), subRows: [makeSubRow({ rental: "3000.00" })] });
    render(
      <GridTable
        rows={[row]}
        columns={CURRENT_COLUMNS}
        isCellActive={(cellKey, columnId) => cellKey === "APT1" && columnId === "tnbOwner"}
        isCellSelected={(cellKey, columnId) => cellKey === "APT1" && columnId === "cleaningOwner"}
      />,
    );
    const sel = screen.getByTestId("cell-cleaningOwner");
    expect(sel.getAttribute("data-selected")).toBe("true");
    expect(sel.getAttribute("data-active")).toBeNull();
    // The in-range tint, and NOT the old inset selection ring. (Excel-Web V2
    // bumped the tint /10 → /15 for a clearer block now that the competing
    // native gold ::selection is suppressed on the grid.)
    expect(sel.className).toContain("bg-[var(--primary)]/15");
    expect(sel.className).not.toContain("ring-inset");

    // The active cell (tnbOwner) still carries its distinct outset ring.
    const active = screen.getByTestId("cell-tnbOwner");
    expect(active.className).toContain("ring-2");
    expect(active.className).toContain("ring-[var(--primary)]");
    expect(active.className).not.toContain("bg-[var(--primary)]/10");
  });

  it("click activates the cell (onCellActivate called with cellKey+columnId+mods)", async () => {
    const user = userEvent.setup();
    const onCellActivate = vi.fn();
    const row = makeRow({ isWholeUnit: true, entry: makeEntry({}), subRows: [makeSubRow({ rental: "3000.00" })] });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} onCellActivate={onCellActivate} />);
    // Task 3: onCellActivate now carries a third {shift,ctrl} mods arg (built
    // from the click event's modifier keys) so a shift/ctrl click can extend
    // the selection instead of collapsing it. A plain click reports both false.
    await user.click(screen.getByTestId("cell-cleaningOwner"));
    expect(onCellActivate).toHaveBeenCalledWith("APT1", "cleaningOwner", { shift: false, ctrl: false });
  });

  it("shift/ctrl click carries mods through onCellActivate (all three cell components)", async () => {
    const user = userEvent.setup();
    const onCellActivate = vi.fn();
    const row = makeRow({ isWholeUnit: true, entry: makeEntry({}), subRows: [makeSubRow({ rental: "3000.00" })] });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} onCellActivate={onCellActivate} />);

    // EditableCell (cleaningOwner) — shift-click ⇒ {shift:true, ctrl:false}
    await user.keyboard("{Shift>}");
    await user.click(screen.getByTestId("cell-cleaningOwner"));
    await user.keyboard("{/Shift}");
    expect(onCellActivate).toHaveBeenLastCalledWith("APT1", "cleaningOwner", { shift: true, ctrl: false });

    // LockedCell (whole-unit rental) — ctrl-click ⇒ {shift:false, ctrl:true}
    await user.keyboard("{Control>}");
    await user.click(screen.getByTestId("cell-rental"));
    await user.keyboard("{/Control}");
    expect(onCellActivate).toHaveBeenLastCalledWith("APT1", "rental", { shift: false, ctrl: true });

    // ReadOnlyCell (expense total) — plain click ⇒ {shift:false, ctrl:false}
    await user.click(screen.getByTestId("cell-tenantExpWithSst"));
    expect(onCellActivate).toHaveBeenLastCalledWith("APT1", "tenantExpWithSst", { shift: false, ctrl: false });
  });

  it("active marker reaches read-only LockedCell (unit-row rental) with tabIndex", () => {
    const onCellActivate = vi.fn();
    // Whole-unit row → unit-row `rental` renders as a LockedCell keyed on the
    // apartmentId. A read-only navigable cell must still carry the active ring,
    // data-active, an onClick, and tabIndex=-1 (so the page focus effect lands).
    const row = makeRow({ isWholeUnit: true, entry: makeEntry({}), subRows: [makeSubRow({ rental: "3000.00" })] });
    render(
      <GridTable
        rows={[row]}
        columns={CURRENT_COLUMNS}
        isCellActive={(cellKey, columnId) => cellKey === "APT1" && columnId === "rental"}
        onCellActivate={onCellActivate}
        registerCell={() => {}}
      />,
    );
    const cell = screen.getByTestId("cell-rental");
    expect(cell.getAttribute("data-active")).toBe("true");
    expect(cell.className).toContain("ring-[var(--primary)]");
    expect(cell.className).not.toContain("ring-inset");
    expect(cell.getAttribute("tabindex")).toBe("-1");
  });

  it("active marker reaches read-only ReadOnlyCell (expense total) with tabIndex", () => {
    const row = makeRow({ isWholeUnit: true, entry: makeEntry({}), subRows: [makeSubRow({ rental: "3000.00" })] });
    render(
      <GridTable
        rows={[row]}
        columns={CURRENT_COLUMNS}
        isCellActive={(cellKey, columnId) => cellKey === "APT1" && columnId === "tenantExpWithSst"}
        registerCell={() => {}}
      />,
    );
    const cell = screen.getByTestId("cell-tenantExpWithSst");
    expect(cell.getAttribute("data-active")).toBe("true");
    expect(cell.className).toContain("ring-[var(--primary)]");
    expect(cell.className).not.toContain("ring-inset");
    expect(cell.getAttribute("tabindex")).toBe("-1");
  });

  it("active marker reaches the raw sub-row rental td (partitioned per-room rental)", async () => {
    const user = userEvent.setup();
    const onCellActivate = vi.fn();
    // Partitioned apartment (isWholeUnit:false) → the per-room `rental` cell is
    // the RAW inline <td> in the nested sub-row block (NOT a LockedCell/
    // ReadOnlyCell component). It is keyed on the sub-row's listingId.
    const row = makeRow({
      isWholeUnit: false,
      entry: makeEntry({}),
      subRows: [makeSubRow({ listingId: "L1", tenancyId: "T1", partyName: "Ali", rental: "1200.00" })],
    });
    render(
      <GridTable
        rows={[row]}
        columns={CURRENT_COLUMNS}
        isCellActive={(cellKey, columnId) => cellKey === "L1" && columnId === "rental"}
        onCellActivate={onCellActivate}
        registerCell={() => {}}
      />,
    );
    const subRow = screen.getByTestId("tenant-sub-row");
    const cell = within(subRow).getByTestId("cell-rental");
    expect(cell.getAttribute("data-active")).toBe("true");
    expect(cell.className).toContain("ring-[var(--primary)]");
    expect(cell.className).not.toContain("ring-inset");
    expect(cell.getAttribute("tabindex")).toBe("-1");
    await user.click(cell);
    // Task 3: raw sub-row rental <td> also carries the {shift,ctrl} mods arg.
    expect(onCellActivate).toHaveBeenCalledWith("L1", "rental", { shift: false, ctrl: false });
  });

  it("parity without props: no data-active and no tabindex anywhere", () => {
    // A mixed grid: one whole-unit row (inline reading + rental LockedCell +
    // expense ReadOnlyCells) and one partitioned row (nested sub-row rental
    // <td>). With NONE of the active-cell props passed, the render must carry
    // no data-active attribute and no tabindex on any data cell — byte-identical
    // to before this task.
    const wholeUnit = makeRow({
      apartmentId: "APT1",
      unitCode: "PV9 A-13-13",
      isWholeUnit: true,
      entry: makeEntry({}),
      subRows: [makeSubRow({ listingId: "L1", rental: "3000.00" })],
    });
    const partitioned = makeRow({
      apartmentId: "APT2",
      unitCode: "PV9 B-14-14",
      isWholeUnit: false,
      entry: makeEntry({}),
      subRows: [makeSubRow({ listingId: "L2", tenancyId: "T2", partyName: "Ali", rental: "1200.00" })],
    });
    const { container } = render(<GridTable rows={[wholeUnit, partitioned]} columns={CURRENT_COLUMNS} />);
    expect(container.querySelectorAll('[data-active]')).toHaveLength(0);
    // No data cell (<td> or <input>) gains a tabindex when the nav props are absent.
    expect(container.querySelectorAll('td[tabindex], input[tabindex]')).toHaveLength(0);
    // No active-ring or in-range-tint class token leaks into the parity render.
    // With no isCellActive/isCellSelected props passed, neither the (non-inset)
    // active ring nor the in-range --primary tint fill (Task 3) may appear.
    expect(container.innerHTML).not.toContain("ring-[var(--accent)]");
    expect(container.innerHTML).not.toContain("ring-[var(--primary)]");
    expect(container.innerHTML).not.toContain("bg-[var(--primary)]/10");
  });

  it("registerCell receives the editable cell's input node keyed by cellKey+columnId", () => {
    const registerCell = vi.fn();
    const row = makeRow({ isWholeUnit: true, entry: makeEntry({}), subRows: [makeSubRow({ rental: "3000.00" })] });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} registerCell={registerCell} />);
    // The tnbOwner editable cell registers its <input> (focus target).
    // (cleaning/WiFi are read-only LockedCells now and register a <td>, not an
    // <input> — so an editable unit-grain cell is the right subject here.)
    const call = registerCell.mock.calls.find(([k, c]) => k === "APT1" && c === "tnbOwner");
    expect(call).toBeDefined();
    expect(call?.[2]).toBeInstanceOf(HTMLInputElement);
  });
});
