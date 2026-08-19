// P4 Task 2 — useGridNav hook. Active-cell state + column-preserving arrow
// moves + period reset (R14). Pure nav state: no money write, no DOM. Consumes
// buildNavRows (Task 1) as the single source of truth for navigable cells.
//
// Fixtures mirror nav-cells.test.tsx / grid-table.test.tsx helpers (full valid
// GridRow / GridEntryDto / GridSubRow shapes only — never a simplified §16
// stand-in). Column facts that make the moves testable:
//   - "cleaningOwner" is a UNIT-grain editable column → appears on unit rows
//     only (NOT on sub-rows).
//   - "currentKwh" is a SUB-ROW-grain editable column → appears on sub-rows
//     only (and the inline sub of a whole-unit row).
// A partitioned row therefore enumerates: unit row (bearing cleaningOwner) then
// its sub-rows (bearing currentKwh but NOT cleaningOwner) — so "down from
// cleaningOwner skips the sub-rows to the next unit row" is a real assertion.
import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { GridRow, GridEntryDto, GridBearerConfigDto, GridSubRow } from "@/api/bills-grid";
import { useGridNav } from "../use-grid-nav";
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

/** Single-arg convenience: a sub-row with the given listingId (and a distinct
 * tenancyId so vacant/occupied identity stays sane in fixtures). */
function makeSub(listingId: string, partial: Partial<GridSubRow> = {}): GridSubRow {
  return makeSubRow({ listingId, tenancyId: `T-${listingId}`, ...partial });
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

/** Partitioned unit: unit row + N nested sub-rows. cleaningOwner lands on the
 * unit row; currentKwh lands on each sub-row. */
function partitioned(apartmentId: string, subIds: string[], over: Partial<GridRow> = {}): GridRow {
  return makeRow({
    apartmentId,
    entry: makeEntry({}),
    isWholeUnit: false,
    subRows: subIds.map((id) => makeSub(id)),
    ...over,
  });
}

const PERIOD = "2026-07-01";

describe("useGridNav", () => {
  it("setActiveByCell activates the cell", () => {
    const rows = [partitioned("APT-A", ["L1", "L2"])];
    const { result } = renderHook(() =>
      useGridNav({ rows, columns: CURRENT_COLUMNS, currentPeriod: PERIOD }),
    );
    expect(result.current.active).toBeNull();
    // cleaning/WiFi are read-only navigable cells now, so the editable
    // unit-grain landing target is tnbOwner (also keyed on the apartmentId).
    act(() => result.current.setActiveByCell("APT-A", "tnbOwner"));
    expect(result.current.active?.columnId).toBe("tnbOwner");
    expect(result.current.active?.apartmentId).toBe("APT-A");
    expect(result.current.active?.cellKey).toBe("APT-A");
    expect(result.current.active?.editable).toBe(true);
  });

  it("down preserves column", () => {
    // APT-A unit row bears cleaningOwner, then 2 sub-rows that do NOT.
    // APT-B unit row bears cleaningOwner. Down must skip A's sub-rows and land
    // on B's unit row in the SAME column.
    const rows = [partitioned("APT-A", ["L1", "L2"]), partitioned("APT-B", ["L3", "L4"])];
    const { result } = renderHook(() =>
      useGridNav({ rows, columns: CURRENT_COLUMNS, currentPeriod: PERIOD }),
    );
    act(() => result.current.setActiveByCell("APT-A", "cleaningOwner"));
    act(() => result.current.move("down"));
    expect(result.current.active?.columnId).toBe("cleaningOwner");
    expect(result.current.active?.apartmentId).toBe("APT-B"); // sub-rows skipped, next unit row
  });

  it("edge stop at last cell in column", () => {
    // Two units. From APT-B's cleaningOwner (the last unit row bearing it),
    // down has nowhere to go → active unchanged.
    const rows = [partitioned("APT-A", ["L1"]), partitioned("APT-B", ["L2"])];
    const { result } = renderHook(() =>
      useGridNav({ rows, columns: CURRENT_COLUMNS, currentPeriod: PERIOD }),
    );
    act(() => result.current.setActiveByCell("APT-B", "cleaningOwner"));
    const before = result.current.active;
    act(() => result.current.move("down"));
    expect(result.current.active?.apartmentId).toBe("APT-B");
    expect(result.current.active?.columnId).toBe("cleaningOwner");
    expect(result.current.active).toEqual(before); // truly unchanged
  });

  it("skips blanks — down over a row where the column renders no cell", () => {
    // currentKwh is a sub-row-grain column: it exists on sub-rows but NOT on
    // unit rows. From APT-A's first sub-row currentKwh, down must skip APT-B's
    // UNIT row (structural blank in currentKwh) and land on APT-B's sub-row.
    const rows = [partitioned("APT-A", ["L1"]), partitioned("APT-B", ["L2"])];
    const { result } = renderHook(() =>
      useGridNav({ rows, columns: CURRENT_COLUMNS, currentPeriod: PERIOD }),
    );
    act(() => result.current.setActiveByCell("L1", "currentKwh"));
    expect(result.current.active?.cellKey).toBe("L1"); // sanity: seated on sub-row
    act(() => result.current.move("down"));
    expect(result.current.active?.columnId).toBe("currentKwh");
    expect(result.current.active?.cellKey).toBe("L2"); // APT-B unit row skipped
  });

  it("up preserves column — mirror of down", () => {
    const rows = [partitioned("APT-A", ["L1"]), partitioned("APT-B", ["L2"])];
    const { result } = renderHook(() =>
      useGridNav({ rows, columns: CURRENT_COLUMNS, currentPeriod: PERIOD }),
    );
    act(() => result.current.setActiveByCell("APT-B", "cleaningOwner"));
    act(() => result.current.move("up"));
    expect(result.current.active?.columnId).toBe("cleaningOwner");
    expect(result.current.active?.apartmentId).toBe("APT-A");
    // and up from the top is an edge-stop
    act(() => result.current.move("up"));
    expect(result.current.active?.apartmentId).toBe("APT-A");
  });

  it("left/right move within the active row and edge-stop at ends", () => {
    const rows = [partitioned("APT-A", ["L1"])];
    const { result } = renderHook(() =>
      useGridNav({ rows, columns: CURRENT_COLUMNS, currentPeriod: PERIOD }),
    );
    // Derive two adjacent navigable cells from the enumerated unit row rather
    // than hardcoding column ids (which cells are present depends on
    // bearer-applicability). move steps within row.cells order.
    const unitCells = result.current.navRows[0].cells;
    const c0 = unitCells[0].columnId;
    const c1 = unitCells[1].columnId;
    act(() => result.current.setActiveByCell("APT-A", c0));
    act(() => result.current.move("right"));
    expect(result.current.active?.columnId).toBe(c1);
    act(() => result.current.move("left"));
    expect(result.current.active?.columnId).toBe(c0);
    // left from the first cell in the row is an edge-stop
    const before = result.current.active;
    act(() => result.current.move("left"));
    expect(result.current.active).toEqual(before);
  });

  it("move from null seeds the first navigable cell", () => {
    const rows = [partitioned("APT-A", ["L1"])];
    const { result } = renderHook(() =>
      useGridNav({ rows, columns: CURRENT_COLUMNS, currentPeriod: PERIOD }),
    );
    expect(result.current.active).toBeNull();
    act(() => result.current.move("down"));
    const firstCell = result.current.navRows.find((r) => r.cells.length)!.cells[0];
    expect(result.current.active?.cellKey).toBe(firstCell.cellKey);
    expect(result.current.active?.columnId).toBe(firstCell.columnId);
  });

  it("resets on period change", () => {
    const rows = [partitioned("APT-A", ["L1"])];
    const { result, rerender } = renderHook(
      ({ period }) => useGridNav({ rows, columns: CURRENT_COLUMNS, currentPeriod: period }),
      { initialProps: { period: "2026-07-01" } },
    );
    act(() => result.current.setActiveByCell("APT-A", "cleaningOwner"));
    expect(result.current.active).not.toBeNull();
    rerender({ period: "2026-08-01" });
    expect(result.current.active).toBeNull();
  });

  it("same period rerender does not reset the active cell", () => {
    const rows = [partitioned("APT-A", ["L1"])];
    const { result, rerender } = renderHook(
      ({ period }) => useGridNav({ rows, columns: CURRENT_COLUMNS, currentPeriod: period }),
      { initialProps: { period: "2026-07-01" } },
    );
    act(() => result.current.setActiveByCell("APT-A", "cleaningOwner"));
    rerender({ period: "2026-07-01" }); // same period
    expect(result.current.active?.columnId).toBe("cleaningOwner");
  });

  it("stale-pos drift (Fix 2): a rows re-order (vacant-toggle/refetch) keeps the active cell on its OWN cellKey, never a different cell", () => {
    // Two partitioned units. Seat the active cell on APT-B's cleaningOwner
    // (physically the SECOND unit row). Then re-render with the rows reordered
    // (APT-B first) — as a show-vacant toggle / background refetch would. A nav
    // that keyed the active position on the raw rowIndex would now resolve that
    // same rowIndex to APT-A's cleaningOwner (WRONG cell → Esc reverts the wrong
    // cell / commit moves from the wrong origin). The active cell must stay
    // pinned to its stable cellKey.
    const A = partitioned("APT-A", ["L1"]);
    const B = partitioned("APT-B", ["L2"]);
    const { result, rerender } = renderHook(
      ({ rows }) => useGridNav({ rows, columns: CURRENT_COLUMNS, currentPeriod: PERIOD }),
      { initialProps: { rows: [A, B] } },
    );
    act(() => result.current.setActiveByCell("APT-B", "cleaningOwner"));
    expect(result.current.active?.cellKey).toBe("APT-B");
    // Reorder the rows (B before A) — navRows re-derives, rowIndex 1 now maps to A.
    rerender({ rows: [B, A] });
    // Robust to re-derivation: still APT-B's cleaningOwner, NOT APT-A's.
    expect(result.current.active?.cellKey).toBe("APT-B");
    expect(result.current.active?.columnId).toBe("cleaningOwner");
    expect(result.current.isActive("APT-B", "cleaningOwner")).toBe(true);
    expect(result.current.isActive("APT-A", "cleaningOwner")).toBe(false);
  });

  it("stale-pos (Fix 2): when the active cell's row disappears from navRows, active resolves to null (never a stray cell)", () => {
    const A = partitioned("APT-A", ["L1"]);
    const B = partitioned("APT-B", ["L2"]);
    const { result, rerender } = renderHook(
      ({ rows }) => useGridNav({ rows, columns: CURRENT_COLUMNS, currentPeriod: PERIOD }),
      { initialProps: { rows: [A, B] } },
    );
    act(() => result.current.setActiveByCell("APT-B", "cleaningOwner"));
    expect(result.current.active?.cellKey).toBe("APT-B");
    // APT-B is filtered out entirely (e.g. hidden by a filter). The active cell
    // must clear, never silently point at APT-A which now sits at that rowIndex.
    rerender({ rows: [A] });
    expect(result.current.active).toBeNull();
  });

  it("isActive, activeNavCell and reset reflect and clear the active position", () => {
    const rows = [partitioned("APT-A", ["L1"])];
    const { result } = renderHook(() =>
      useGridNav({ rows, columns: CURRENT_COLUMNS, currentPeriod: PERIOD }),
    );
    act(() => result.current.setActiveByCell("APT-A", "cleaningOwner"));
    expect(result.current.isActive("APT-A", "cleaningOwner")).toBe(true);
    expect(result.current.isActive("APT-A", "cleaningTenant")).toBe(false);
    expect(result.current.activeNavCell()?.columnId).toBe("cleaningOwner");
    act(() => result.current.reset());
    expect(result.current.active).toBeNull();
    expect(result.current.activeNavCell()).toBeNull();
    expect(result.current.isActive("APT-A", "cleaningOwner")).toBe(false);
  });

  // ── Task 1: rectBetween — pure mouse-drag rectangle ──────────────────────
  // Geometry of a `partitioned` unit (cleaningBearer=owner, so the tenant sides
  // are inactive-bearer blanks):
  //   unit row APT-A: rental(ro), cleaningOwner, tnbOwner, airOwner, …  (NO
  //     previousKwh/currentKwh — those are subRow-grain structural blanks here)
  //   sub row  L1   : rental(ro), previousKwh, currentKwh, amount(ro)
  // Column order (columns.ts): unitCode 0, rental 1, cleaningOwner 2,
  //   cleaningTenant 3, tnbOwner 4, previousKwh 5, …

  it("rectBetween full block: returns every navigable cell in the row×col span, not just corners", () => {
    // Rectangle {APT-A, cleaningOwner}(row0,col2) → {L1, previousKwh}(row1,col5).
    // Span rows 0-1 × cols cleaningOwner..previousKwh. The navigable cells inside
    // are: row0 cleaningOwner, row0 tnbOwner (a NON-corner block cell), row1
    // previousKwh — 3 cells, proving the whole block is returned, not just the
    // two dragged corners.
    const rows = [partitioned("APT-A", ["L1"])];
    const { result } = renderHook(() =>
      useGridNav({ rows, columns: CURRENT_COLUMNS, currentPeriod: PERIOD }),
    );
    const cells = result.current.rectBetween(
      { cellKey: "APT-A", columnId: "cleaningOwner" },
      { cellKey: "L1", columnId: "previousKwh" },
    );
    expect(cells.length).toBeGreaterThan(2); // more than the two corners
    expect(cells).toContainEqual({ cellKey: "APT-A", columnId: "cleaningOwner" });
    expect(cells).toContainEqual({ cellKey: "L1", columnId: "previousKwh" });
    expect(cells).toContainEqual({ cellKey: "APT-A", columnId: "tnbOwner" }); // non-corner block cell
  });

  it("rectBetween omits blanks: a structural-blank column is absent, read-only cells present", () => {
    // Single-row rectangle {APT-A, rental}(col1, read-only) → {APT-A, tnbOwner}(col4).
    // Span cols rental, cleaningOwner, cleaningTenant, tnbOwner on the unit row.
    // cleaningTenant is an inactive-bearer structural blank (cleaningBearer=owner)
    // → must be omitted. The read-only `rental` cell must be present.
    const rows = [partitioned("APT-A", ["L1"])];
    const { result } = renderHook(() =>
      useGridNav({ rows, columns: CURRENT_COLUMNS, currentPeriod: PERIOD }),
    );
    const cells = result.current.rectBetween(
      { cellKey: "APT-A", columnId: "rental" },
      { cellKey: "APT-A", columnId: "tnbOwner" },
    );
    expect(cells.some((c) => c.columnId === "cleaningTenant")).toBe(false); // blank omitted
    expect(cells).toContainEqual({ cellKey: "APT-A", columnId: "rental" }); // read-only kept
    expect(cells).toContainEqual({ cellKey: "APT-A", columnId: "cleaningOwner" });
    expect(cells).toContainEqual({ cellKey: "APT-A", columnId: "tnbOwner" });
  });

  it("rectBetween disappeared endpoint: returns [] when an endpoint is not in navRows", () => {
    const rows = [partitioned("APT-A", ["L1"])];
    const { result } = renderHook(() =>
      useGridNav({ rows, columns: CURRENT_COLUMNS, currentPeriod: PERIOD }),
    );
    expect(
      result.current.rectBetween(
        { cellKey: "GHOST", columnId: "cleaningOwner" },
        { cellKey: "APT-A", columnId: "cleaningOwner" },
      ),
    ).toEqual([]);
  });
});
