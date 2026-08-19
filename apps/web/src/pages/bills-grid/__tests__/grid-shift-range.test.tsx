// P4 Task 6 — Shift-range keyboard/click selection feeding useGridSelection.range.
//
// Shift+arrow extends a RECTANGULAR range from the anchor (the active cell when
// Shift was first held) to the current focus; the rectangle flattens into the
// EXISTING useGridSelection.range (so the count/sum badge, colour-fill,
// ctrl-fill, hasSelection and isCellSelected consumers keep working). Read-only
// cells are includable (for the count/sum readout, R8); a plain (non-shift)
// move collapses the range to the single active cell (R7).
//
// Fixtures mirror use-grid-nav.test.tsx / nav-cells.test.tsx (full valid
// GridRow / GridEntryDto / GridSubRow shapes only — never a simplified §16
// stand-in). Column facts that make the rectangle testable on a whole-unit row
// (owner bearers): the enumerated unit-row cells in visibleColumns order are
//   [rental(read-only), cleaningOwner, tnbOwner, previousKwh, currentKwh,
//    amount(read-only), airOwner, wifiOwner, maintenanceFee, …expense totals].
// cleaningTenant/airTenant/wifiTenant are inapplicable (owner bearer) → they are
// structural blanks omitted from any rectangle that spans across them.
import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { GridRow, GridEntryDto, GridBearerConfigDto, GridSubRow } from "@/api/bills-grid";
import { useGridNav } from "../use-grid-nav";
import { useGridSelection } from "../use-grid-selection";
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

/** A whole-unit row (inline reading + read-only rental LockedCell) with owner
 * bearers — the horizontal fixture whose enumerated unit-row cells span
 * rental → cleaningOwner → tnbOwner → previousKwh …. */
function wholeUnit(apartmentId: string): GridRow {
  return makeRow({
    apartmentId,
    entry: makeEntry({}),
    isWholeUnit: true,
    subRows: [makeSubRow({ listingId: `L-${apartmentId}`, rental: "3000.00" })],
  });
}

const PERIOD = "2026-07-01";

describe("Task 6 — Shift-range selection into useGridSelection.range", () => {
  it("shift extends range: from cleaningOwner, Shift+Right x2 selects the 3-cell rectangle (count 3)", () => {
    const rows = [wholeUnit("APT-A")];
    const { result } = renderHook(() => ({
      nav: useGridNav({ rows, columns: CURRENT_COLUMNS, currentPeriod: PERIOD }),
      sel: useGridSelection(),
    }));
    act(() => result.current.nav.setActiveByCell("APT-A", "cleaningOwner"));
    // Shift+Right twice: focus walks cleaningOwner → tnbOwner → previousKwh.
    act(() => result.current.sel.selectCells(result.current.nav.extendRange("right")));
    act(() => result.current.sel.selectCells(result.current.nav.extendRange("right")));
    // Rectangle over the single unit row, columnId span cleaningOwner→previousKwh
    // (cleaningTenant is a structural blank, omitted): 3 cells.
    expect(result.current.sel.count).toBe(3);
    const cols = result.current.sel.range.map((c) => c.columnId).sort();
    expect(cols).toEqual(["cleaningOwner", "previousKwh", "tnbOwner"]);
    // Unit-grain cells (cleaningOwner/tnbOwner) key on the apartmentId; the
    // inline meter cell (previousKwh) keys on its sub-row listingId — the
    // rectangle carries each cell's OWN write-target cellKey, exactly as the
    // enumerator produced it.
    const byCol = new Map(result.current.sel.range.map((c) => [c.columnId, c.cellKey]));
    expect(byCol.get("cleaningOwner")).toBe("APT-A");
    expect(byCol.get("tnbOwner")).toBe("APT-A");
    expect(byCol.get("previousKwh")).toBe("L-APT-A"); // inline sub-row listingId
  });

  it("range includes read-only cell: Shift+Left from cleaningOwner spans the read-only rental", () => {
    const rows = [wholeUnit("APT-A")];
    const { result } = renderHook(() => ({
      nav: useGridNav({ rows, columns: CURRENT_COLUMNS, currentPeriod: PERIOD }),
      sel: useGridSelection(),
    }));
    act(() => result.current.nav.setActiveByCell("APT-A", "cleaningOwner"));
    act(() => result.current.sel.selectCells(result.current.nav.extendRange("left")));
    // Column span rental(read-only) → cleaningOwner, both on the unit row.
    const cols = result.current.sel.range.map((c) => c.columnId).sort();
    expect(cols).toEqual(["cleaningOwner", "rental"]);
    expect(result.current.sel.count).toBe(2);
  });

  it("range spans rows (vertical): Shift+Down from A's cleaningOwner selects A+B in that column", () => {
    const rows = [wholeUnit("APT-A"), wholeUnit("APT-B")];
    const { result } = renderHook(() => ({
      nav: useGridNav({ rows, columns: CURRENT_COLUMNS, currentPeriod: PERIOD }),
      sel: useGridSelection(),
    }));
    act(() => result.current.nav.setActiveByCell("APT-A", "cleaningOwner"));
    act(() => result.current.sel.selectCells(result.current.nav.extendRange("down")));
    expect(result.current.sel.count).toBe(2);
    const keys = result.current.sel.range.map((c) => c.cellKey).sort();
    expect(keys).toEqual(["APT-A", "APT-B"]);
    expect(result.current.sel.range.every((c) => c.columnId === "cleaningOwner")).toBe(true);
  });

  it("plain move collapses: an existing shift-range collapses to the single active cell on a plain arrow move", () => {
    const rows = [wholeUnit("APT-A")];
    const { result } = renderHook(() => ({
      nav: useGridNav({ rows, columns: CURRENT_COLUMNS, currentPeriod: PERIOD }),
      sel: useGridSelection(),
    }));
    act(() => result.current.nav.setActiveByCell("APT-A", "cleaningOwner"));
    // Build a range first.
    act(() => result.current.sel.selectCells(result.current.nav.extendRange("right")));
    expect(result.current.sel.count).toBe(2);
    // Plain (non-shift) move: page collapses the range to the single active cell.
    act(() => {
      result.current.nav.move("right");
    });
    act(() => {
      const a = result.current.nav.active!;
      result.current.sel.selectCells([{ cellKey: a.cellKey, columnId: a.columnId }]);
    });
    expect(result.current.sel.count).toBe(1);
    expect(result.current.sel.range[0].columnId).toBe(result.current.nav.active!.columnId);
  });

  it("re-anchors: after a plain move clears the anchor, the next Shift-range anchors at the NEW active cell", () => {
    const rows = [wholeUnit("APT-A")];
    const { result } = renderHook(() => ({
      nav: useGridNav({ rows, columns: CURRENT_COLUMNS, currentPeriod: PERIOD }),
      sel: useGridSelection(),
    }));
    act(() => result.current.nav.setActiveByCell("APT-A", "cleaningOwner"));
    // extendRight: focus walks cleaningOwner → tnbOwner (anchor cleaningOwner).
    act(() => result.current.sel.selectCells(result.current.nav.extendRange("right")));
    // Plain move clears the anchor and advances focus tnbOwner → previousKwh.
    act(() => result.current.nav.move("right"));
    expect(result.current.nav.active?.columnId).toBe("previousKwh");
    // Fresh Shift-range: anchor is the NEW active cell (previousKwh), NOT the old
    // cleaningOwner — a 2-cell rectangle previousKwh→currentKwh, not a wider one.
    act(() => result.current.sel.selectCells(result.current.nav.extendRange("right")));
    expect(result.current.sel.count).toBe(2);
    const cols = result.current.sel.range.map((c) => c.columnId).sort();
    expect(cols).toEqual(["currentKwh", "previousKwh"]);
  });
});
