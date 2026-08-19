// UI Task 4 — six Excel affordances (drag-select, ctrl-fill, colour fill,
// hide-column, column filter, in-app fullscreen) + Escape safety (R32).
// HIGH-risk money/safety guards, each with its own failure-path test:
//   1. ctrl-fill MUST exclude billed/locked cells from the write.
//   2. colour fill writes ONLY to localStorage — NEVER a `fetch`.
//   3. "full screen" is an in-app `fixed inset-0 z-50` overlay — NEVER
//      `element.requestFullscreen()` (native Fullscreen API hands Escape to
//      the browser, which would violate R32).
//   4. Escape never closes the grid and never flushes the staged buffer.
//   5. Amount cells accept no formula.
import { useMemo, useState } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, renderHook, act, within, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { GridRow, GridEntryDto, GridBearerConfigDto, GridResponse } from "@/api/bills-grid";
import { GridTable } from "../grid-table";
import { GridToolbar } from "../grid-toolbar";
import { CURRENT_COLUMNS } from "../columns";
import { parseAmountCell } from "../cell-parser";
import { useGridKeyboard } from "../use-grid-keyboard";
import { useFullscreenZoom } from "../use-fullscreen-zoom";
import { applyFilters } from "../use-column-filter";
import { useGridSelection } from "../use-grid-selection";
import { loadPref, loadCellColours } from "@/lib/view-prefs";
import { AuthContext, type User } from "@/lib/auth";

// ── Task 4 (Excel MOUSE selection V2) page-level harness: the ONLY additions to
// this otherwise hook/component-direct file. The new "ctrl-drag adds range not
// fill" test (acceptance row 4) renders the WHOLE page, so it needs the same
// api/toast/export mocks bills-grid-page.test.tsx uses. Existing tests here
// import only TYPES from these modules (or render <GridTable> directly), so the
// mocks are inert for them. `@/lib/view-prefs` is deliberately NOT mocked — the
// existing colour/fullscreen tests round-trip real jsdom localStorage. ─────────
const fetchGridMock = vi.fn();
const saveEntryMock = vi.fn();
const saveReadingsMock = vi.fn();
const billRowsMock = vi.fn();
const getBearerConfigMock = vi.fn();
const listExpensesMock = vi.fn();
const listAttachmentsMock = vi.fn();
vi.mock("@/api/bills-grid", async () => {
  const actual = await vi.importActual<typeof import("@/api/bills-grid")>("@/api/bills-grid");
  return {
    ...actual,
    fetchGrid: (...a: unknown[]) => fetchGridMock(...a),
    saveEntry: (...a: unknown[]) => saveEntryMock(...a),
    saveReadings: (...a: unknown[]) => saveReadingsMock(...a),
    billRows: (...a: unknown[]) => billRowsMock(...a),
    getBearerConfig: (...a: unknown[]) => getBearerConfigMock(...a),
    listExpenses: (...a: unknown[]) => listExpensesMock(...a),
    listAttachments: (...a: unknown[]) => listAttachmentsMock(...a),
  };
});
vi.mock("../export-xlsx", () => ({ exportGridToXlsx: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import BillsGridPage from "../bills-grid-page";

// ── fixtures (mirrors grid-table.test.tsx's helpers — full valid shapes only,
// never a simplified GridRow that would mask a §16 contract regression) ──────

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
    // OWNER-borne AIR ("absorbed") on purpose: these tests use airOwner as a convenient
    // EDITABLE anchor cell, and since 2026-08-14 the AIR bearer decides which of the two
    // AIR columns renders (cell-applicability.ts). Tenant-borne AIR would move the
    // editable cell to airTenant and this file's subject would vanish.
    airPattern: "absorbed",
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
    airPattern: "absorbed", // see makeEntry above
    cleaningBearer: "owner",
    wifiBearer: "owner",
    maintenanceFeeBearer: "owner",
    cleaningRecurringAmount: "0.00",
    isLocked: false,
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

describe("bills-grid Excel affordances (UI Task 4)", () => {
  // (a) ───────────────────────────────────────────────────────────────────────
  it('"drag-select" tracks a range with live count 3 / sum 60.00 (numeric cells only)', () => {
    const { result } = renderHook(() => useGridSelection());
    // Task 5: range population goes through `selectCells` in one call —
    // `useMultiSelection` (the page's live drag producer) now assembles the
    // full rectangle before handing it to this hook via `selectCells`; the
    // old accretive onPointerDown/onPointerMove/onPointerUp mechanism is
    // removed. Assertions (count/sum) are unchanged from before the swap.
    act(() => {
      result.current.selectCells([
        { cellKey: "APT1", columnId: "rental", value: 10 },
        { cellKey: "APT2", columnId: "rental", value: 20 },
        { cellKey: "APT3", columnId: "rental", value: 30 },
      ]);
    });
    expect(result.current.count).toBe(3);
    expect(result.current.sum.toFixed(2)).toBe("60.00");
  });

  // (b) ───────────────────────────────────────────────────────────────────────
  it('"ctrl-fill" fills 3 unlocked target cells, staging value 100 for each', () => {
    const { result } = renderHook(() => useGridSelection());
    const writes = result.current.fill(
      100,
      [
        { cellKey: "APT1", apartmentId: "APT1", columnId: "rental" },
        { cellKey: "APT2", apartmentId: "APT2", columnId: "rental" },
        { cellKey: "APT3", apartmentId: "APT3", columnId: "rental" },
      ],
      () => false,
    );
    expect(writes).toHaveLength(3);
    expect(writes.every((w) => w.value === 100)).toBe(true);
  });

  // (c) ───────────────────────────────────────────────────────────────────────
  it('"colour fill" persists under bills-grid:cellColours + cells carry the bg', () => {
    const { result } = renderHook(() => useGridSelection());
    act(() => {
      result.current.setColour([{ cellKey: "APT1", columnId: "rental", periodMonth: "2026-07-01" }], "#fecaca");
    });

    const raw = localStorage.getItem("bills-grid:cellColours");
    expect(raw).not.toBeNull();
    const stored = JSON.parse(raw as string) as Record<string, string>;
    expect(stored["APT1:rental:2026-07-01"]).toBe("#fecaca");

    // "cells carry the bg": a cell reading the persisted map applies it as a background.
    function PaintedCell() {
      const colours = loadCellColours("bills-grid");
      return <div data-testid="painted-cell" style={{ backgroundColor: colours["APT1:rental:2026-07-01"] }} />;
    }
    render(<PaintedCell />);
    expect(screen.getByTestId("painted-cell")).toHaveStyle({ backgroundColor: "rgb(254, 202, 202)" });
  });

  // (d) ───────────────────────────────────────────────────────────────────────
  it('"hide column" re-show retains staged edits (hide is view-state, never a mutation)', async () => {
    // Task 6: rental is read-only now (no <input> to stage into) — this
    // hide/re-show-retains-edit test uses tnbOwner (still editable, and unlike
    // cleaningOwner it has no recurring auto-fill seed, so its input starts
    // empty); hide-column view-state works identically for any column.
    const user = userEvent.setup();
    const row = makeRow({ entry: makeEntry({}), subRows: [] });

    function Harness() {
      const { hiddenColumns, hideColumn } = useGridSelection();
      const visibleColumns = CURRENT_COLUMNS.filter((c) => !hiddenColumns.includes(c.id));
      return (
        <div>
          <button onClick={() => hideColumn("tnbOwner")}>toggle tnb</button>
          <GridTable rows={[row]} columns={visibleColumns} />
        </div>
      );
    }

    render(<Harness />);
    const input = screen.getByTestId("cell-tnbOwner").querySelector("input") as HTMLInputElement;
    await user.type(input, "500");
    expect(screen.getByDisplayValue("500")).toBeInTheDocument();

    await user.click(screen.getByText("toggle tnb"));
    expect(screen.queryByTestId("cell-tnbOwner")).toBeNull();

    await user.click(screen.getByText("toggle tnb"));
    expect(screen.getByDisplayValue("500")).toBeInTheDocument();
  });

  // (e) ───────────────────────────────────────────────────────────────────────
  it('"column filter intersects" unitCode PV9 × July-only → only PV9 rows + July strip', () => {
    const rows = [
      makeRow({ apartmentId: "A1", unitCode: "PV9 A-13-13" }),
      makeRow({ apartmentId: "A2", unitCode: "PV10 B-2-2" }),
    ];
    const periods = ["2026-05-01", "2026-06-01", "2026-07-01"];
    const { rows: filteredRows, periods: filteredPeriods } = applyFilters(
      rows,
      periods,
      { unitCode: "PV9" },
      { from: "2026-07-01", to: "2026-07-01" },
    );
    expect(filteredRows.map((r) => r.apartmentId)).toEqual(["A1"]);
    expect(filteredPeriods).toEqual(["2026-07-01"]);
  });

  // (f) ───────────────────────────────────────────────────────────────────────
  // R3 (2026-07-12): the table zoom-scale control (−/%/+) was removed — only
  // the full-viewport "Fullscreen"/"Exit Fullscreen" overlay remains.
  it('"no zoom control" toolbar renders no Zoom in/Zoom out control and no % readout', () => {
    render(
      <GridToolbar
        periods={[]}
        selectedPeriods={[]}
        onPeriodsChange={() => {}}
        anchorMonth="2026-07-01"
        currentBillingMonth="2026-07-01"
        onStepMonth={() => {}}
        onAnchorMonthChange={() => {}}
        properties={[]}
        propertyId="all"
        onPropertyChange={() => {}}
        dirtyCount={0}
        onSave={() => {}}
        canUndo={false}
        canRedo={false}
        undoDepth={0}
        redoDepth={0}
        onUndo={() => {}}
        onRedo={() => {}}
        selectedRowCount={0}
        onBill={() => {}}
        canBillPeriod
        canExport={false}
        onExport={() => {}}
        columnFilters={{}}
        onColumnFilterChange={() => {}}
        dateRange={{ from: null, to: null }}
        onDateRangeChange={() => {}}
        maximized={false}
        onToggleMaximized={() => {}}
        hasSelection={false}
        onApplyColour={() => {}}
        columns={CURRENT_COLUMNS}
        hiddenColumns={[]}
        onToggleColumn={() => {}}
        showVacant={false}
        onToggleShowVacant={() => {}}
      />,
    );

    expect(screen.queryByRole("button", { name: "Zoom in" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Zoom out" })).toBeNull();
    expect(screen.queryByText(/^\d+%$/)).toBeNull();
  });

  // (g) ───────────────────────────────────────────────────────────────────────
  // Bug: the "Columns · Show/Hide" dropdown (absolute z-20, trapped inside the
  // toolbar's own backdrop-blur stacking context) paints BEHIND the grid's
  // sticky thead (z-20/z-30, promoted to the page-root stacking context because
  // grid-region is not itself a stacking context). Raising the dropdown's own
  // z-index cannot escape the toolbar context — the whole toolbar must sit above
  // the header (z-30), i.e. carry `relative z-40`.
  it('"columns menu above sticky header" toolbar root carries relative z-40 so its Show/Hide dropdown clears the z-30 sticky thead', () => {
    render(
      <GridToolbar
        periods={[]}
        selectedPeriods={[]}
        onPeriodsChange={() => {}}
        anchorMonth="2026-07-01"
        currentBillingMonth="2026-07-01"
        onStepMonth={() => {}}
        onAnchorMonthChange={() => {}}
        properties={[]}
        propertyId="all"
        onPropertyChange={() => {}}
        dirtyCount={0}
        onSave={() => {}}
        canUndo={false}
        canRedo={false}
        undoDepth={0}
        redoDepth={0}
        onUndo={() => {}}
        onRedo={() => {}}
        selectedRowCount={0}
        onBill={() => {}}
        canBillPeriod
        canExport={false}
        onExport={() => {}}
        columnFilters={{}}
        onColumnFilterChange={() => {}}
        dateRange={{ from: null, to: null }}
        onDateRangeChange={() => {}}
        maximized={false}
        onToggleMaximized={() => {}}
        hasSelection={false}
        onApplyColour={() => {}}
        columns={CURRENT_COLUMNS}
        hiddenColumns={[]}
        onToggleColumn={() => {}}
        showVacant={false}
        onToggleShowVacant={() => {}}
      />,
    );
    const toolbar = screen.getByTestId("grid-toolbar");
    expect(toolbar.className).toMatch(/\brelative\b/);
    expect(toolbar.className).toMatch(/\bz-40\b/);
  });

  it('"fullscreen overlay toggles" Fullscreen sets the fixed inset-0 z-50 overlay class, Exit Fullscreen clears it, both persisted via savePref', async () => {
    const user = userEvent.setup();

    function Harness() {
      const { maximized, toggleMaximized } = useFullscreenZoom();
      return (
        <div>
          <div data-testid="overlay" className={maximized ? "fixed inset-0 z-50" : ""} />
          <button onClick={toggleMaximized}>{maximized ? "Exit Fullscreen" : "Fullscreen"}</button>
        </div>
      );
    }

    render(<Harness />);
    expect(screen.getByTestId("overlay").className).not.toContain("fixed inset-0 z-50");

    await user.click(screen.getByText("Fullscreen"));
    expect(screen.getByTestId("overlay").className).toContain("fixed inset-0 z-50");
    expect(loadPref("bills-grid", "maximized", false)).toBe(true);

    await user.click(screen.getByText("Exit Fullscreen"));
    expect(screen.getByTestId("overlay").className).not.toContain("fixed inset-0 z-50");
    expect(loadPref("bills-grid", "maximized", false)).toBe(false);
  });

  // ── failure-path / safety tests ─────────────────────────────────────────────

  it('"no formula" =SUM(A1:A3) rejected "Amounts only", nothing staged', () => {
    const result = parseAmountCell("=SUM(A1:A3)");
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toBe("Amounts only");

    const staged: Record<string, number> = {};
    function stage(cellKey: string, raw: string) {
      const parsed = parseAmountCell(raw);
      if (parsed.ok) staged[cellKey] = parsed.value;
    }
    stage("APT1:rental", "=SUM(A1:A3)");
    expect(Object.keys(staged)).toHaveLength(0);
  });

  it('"fill excludes locked" ctrl-fill spanning a billed row excludes the locked cells (unit AND sub-row cells, resolved by apartment)', () => {
    const { result } = renderHook(() => useGridSelection());
    const lockedApartmentIds = new Set(["APT2"]); // billedAt != null / lockState === "locked"
    const writes = result.current.fill(
      250,
      [
        { cellKey: "APT1", apartmentId: "APT1", columnId: "rental" },
        { cellKey: "APT2", apartmentId: "APT2", columnId: "rental" }, // unit cell, locked apartment — excluded
        { cellKey: "APT3", apartmentId: "APT3", columnId: "rental" },
        // sub-row cell: cellKey is a listingId (never a lock-map key), but its
        // OWNING apartment (APT2) is billed — must still be excluded (this is
        // the namespace-ambiguity gap the apartment-scoped resolution closes).
        { cellKey: "LISTING-42", apartmentId: "APT2", columnId: "amount" },
      ],
      (apartmentId) => lockedApartmentIds.has(apartmentId),
    );
    expect(writes.map((w) => w.cellKey)).toEqual(["APT1", "APT3"]);
    expect(writes).toHaveLength(2);
  });

  it('"fill fail-closed on non-boolean" ctrl-fill excludes a cell whose isRowLocked returns a truthy non-boolean (e.g. row.billedAt ISO string) instead of `true`', () => {
    const { result } = renderHook(() => useGridSelection());
    // Mimics a future caller passing `(apartmentId) => row.billedAt` directly
    // instead of `row.billedAt !== null` — a truthy ISO string for the locked
    // apartment, `false` for the unlocked ones. Only a strict `=== false`
    // check keeps this fail-closed; `!== true` would let the string through.
    const writes = result.current.fill(
      250,
      [
        { cellKey: "APT1", apartmentId: "APT1", columnId: "rental" },
        { cellKey: "APT2", apartmentId: "APT2", columnId: "rental" }, // locked, non-boolean truthy return — must be excluded
        { cellKey: "APT3", apartmentId: "APT3", columnId: "rental" },
      ],
      (apartmentId) => (apartmentId === "APT2" ? "2026-07-01T00:00:00Z" : false),
    );
    expect(writes.map((w) => w.cellKey)).toEqual(["APT1", "APT3"]);
    expect(writes).toHaveLength(2);
  });

  it('"colour never posts" colour fill triggers ZERO network requests', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const { result } = renderHook(() => useGridSelection());
    act(() => {
      result.current.setColour([{ cellKey: "APT9", columnId: "wifiOwner", periodMonth: "2026-07-01" }], "#bfdbfe");
    });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('"column filter empty" zero-match → "No rows match" empty state (+ Export disabled hook)', () => {
    const rows = [makeRow({ apartmentId: "A1", unitCode: "PV9 A-13-13" })];
    const { rows: filteredRows } = applyFilters(
      rows,
      ["2026-07-01"],
      { unitCode: "ZZZ-NO-MATCH" },
      { from: null, to: null },
    );
    expect(filteredRows).toHaveLength(0);

    function Harness() {
      return (
        <div>
          {filteredRows.length === 0 ? <p>No rows match</p> : null}
          <button disabled={filteredRows.length === 0}>Export</button>
        </div>
      );
    }
    render(<Harness />);
    expect(screen.getByText("No rows match")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export" })).toBeDisabled();
  });

  it('"fullscreen escape" maximized + Escape → stays maximized (requestFullscreen never called)', async () => {
    const user = userEvent.setup();
    const requestFullscreenSpy = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "requestFullscreen", {
      value: requestFullscreenSpy,
      configurable: true,
      writable: true,
    });

    function Harness() {
      const { maximized, toggleMaximized } = useFullscreenZoom();
      const gridRef = useGridKeyboard({ cancelActiveEdit: () => {}, closeTransientPopover: () => false });
      return (
        <div
          ref={gridRef}
          tabIndex={0}
          data-testid="grid-container"
          className={maximized ? "fixed inset-0 z-50" : ""}
        >
          <button onClick={toggleMaximized}>maximize</button>
        </div>
      );
    }

    render(<Harness />);
    await user.click(screen.getByText("maximize"));
    const container = screen.getByTestId("grid-container");
    expect(container.className).toContain("fixed inset-0 z-50");

    container.focus();
    await user.keyboard("{Escape}");

    expect(screen.getByTestId("grid-container").className).toContain("fixed inset-0 z-50");
    expect(requestFullscreenSpy).not.toHaveBeenCalled();
  });

  it('"escape reverts cell" mid-edit + Escape → cell reverts, grid open, staged-buffer length unchanged', async () => {
    const user = userEvent.setup();

    function Harness() {
      // One previously-COMMITTED staged edit — must be unaffected by Escape.
      const [staged] = useState<Record<string, string>>({ "APT1:rental": "1000.00" });
      // The active cell's uncommitted in-progress value.
      const [activeValue, setActiveValue] = useState("999.00");
      const originalValue = "999.00";
      const [gridOpen] = useState(true);

      const gridRef = useGridKeyboard({
        cancelActiveEdit: () => setActiveValue(originalValue),
        closeTransientPopover: () => false,
      });

      return (
        <div ref={gridRef} tabIndex={0} data-testid="grid">
          <input
            data-testid="active-cell"
            value={activeValue}
            onChange={(e) => setActiveValue(e.target.value)}
          />
          <span data-testid="staged-count">{Object.keys(staged).length}</span>
          <span data-testid="grid-open">{String(gridOpen)}</span>
        </div>
      );
    }

    render(<Harness />);
    const grid = screen.getByTestId("grid");
    const input = screen.getByTestId("active-cell") as HTMLInputElement;

    grid.focus();
    await user.clear(input);
    await user.type(input, "50");
    expect(input.value).toBe("50");

    grid.focus();
    await user.keyboard("{Escape}");

    expect(screen.getByTestId("active-cell")).toHaveValue("999.00");
    expect(screen.getByTestId("staged-count").textContent).toBe("1");
    expect(screen.getByTestId("grid-open").textContent).toBe("true");
  });

  // "escape after async mount" (regression) ──────────────────────────────────
  // Reproduces the exact bug shape from the R32 review: `opts` is memoized
  // (stable identity across renders) and the grid container mounts only
  // after a state flip (ui-10 renders the grid only once `fetchGrid`
  // resolves — an async mount). Against the OLD `useEffect([container,
  // opts])` implementation this never binds the Escape listener, because a
  // `useRef` container object never changes identity, so the effect runs
  // once while `container.current` is still `null`, bails, and never re-runs
  // once the node actually mounts. The callback-ref fix has no such race:
  // React invokes the ref callback exactly when the node mounts.
  it('"escape after async mount" (regression) memoized opts + late-mounted grid container still cancels the active edit', async () => {
    const user = userEvent.setup();
    const cancelActiveEdit = vi.fn();

    function Harness() {
      const [mounted, setMounted] = useState(false);
      const opts = useMemo(() => ({ cancelActiveEdit, closeTransientPopover: () => false }), []);
      const gridRef = useGridKeyboard(opts);
      return (
        <div>
          <button onClick={() => setMounted(true)}>mount grid</button>
          {mounted && (
            <div ref={gridRef} tabIndex={0} data-testid="grid-container">
              grid content
            </div>
          )}
        </div>
      );
    }

    render(<Harness />);
    // The grid container does not exist at first paint — mount it via a
    // later state flip, same as ui-10's post-`fetchGrid` render.
    await user.click(screen.getByText("mount grid"));
    const container = screen.getByTestId("grid-container");

    container.focus();
    await user.keyboard("{Escape}");

    expect(cancelActiveEdit).toHaveBeenCalledTimes(1);
    // R32: the surface stays open — Escape never dismisses the grid.
    expect(screen.getByTestId("grid-container")).toBeInTheDocument();
  });

  // "drag-select sum" mixed numeric+text ──────────────────────────────────────
  it('"drag-select sum" MIXED numeric+text selection contributes 0 for text (no NaN, no concat)', () => {
    const { result } = renderHook(() => useGridSelection());
    // Task 5: same selectCells swap as the test above — mechanism only,
    // same count/sum/no-NaN assertions.
    act(() => {
      result.current.selectCells([
        { cellKey: "APT1", columnId: "rental", value: 10 },
        { cellKey: "APT2", columnId: "unitCode", value: null }, // text cell, non-numeric
        { cellKey: "APT3", columnId: "rental", value: 30 },
      ]);
    });
    expect(result.current.count).toBe(3);
    expect(result.current.sum).toBe(40);
    expect(Number.isNaN(result.current.sum)).toBe(false);
  });

  // "editable numeric cell rejects formula" (R31 D11 — wired into GridTable
  // itself). Task 6: rental + amount are BOTH read-only now (no EditableCell),
  // so the formula-rejection gate is exercised on tnbOwner — still an editable
  // numeric cell that routes through EditableCell's parseAmountCell, and (unlike
  // cleaningOwner) it has no recurring auto-fill seed so the input starts empty. ──
  it('"editable numeric cell rejects formula" a leading "=" is rejected inline at cell-tnbOwner — "Amounts only" shown, NOT staged; partial/normal numbers stage fine', async () => {
    const user = userEvent.setup();
    const onCellEdit = vi.fn();
    const row = makeRow({ entry: makeEntry({}) });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} onCellEdit={onCellEdit} />);

    const input = within(screen.getByTestId("cell-tnbOwner")).getByRole("textbox") as HTMLInputElement;

    // A pasted (or single-shot typed) formula is rejected outright — never
    // staged. A real paste fires ONE onChange with the full pasted string,
    // which fireEvent.change mirrors here.
    fireEvent.change(input, { target: { value: "=SUM(A1)" } });
    expect(input.value).toBe(""); // rejected — controlled input stays at its seed
    expect(onCellEdit).not.toHaveBeenCalled();
    expect(screen.getByText("Amounts only")).toBeInTheDocument();

    // Partial/in-progress numeric typing is never blocked.
    await user.type(input, "1.");
    expect(input.value).toBe("1.");
    expect(onCellEdit).toHaveBeenLastCalledWith(row.apartmentId, "tnbOwner", "1.");
    expect(screen.queryByText("Amounts only")).not.toBeInTheDocument();

    await user.type(input, "5");
    expect(input.value).toBe("1.5");
    expect(onCellEdit).toHaveBeenLastCalledWith(row.apartmentId, "tnbOwner", "1.5");

    await user.clear(input);
    await user.type(input, "50.00");
    expect(input.value).toBe("50.00");
    expect(onCellEdit).toHaveBeenLastCalledWith(row.apartmentId, "tnbOwner", "50.00");
    expect(screen.queryByText("Amounts only")).not.toBeInTheDocument();
  });

  // ── Task 4 (Excel MOUSE selection V2): ctrl-drag is now ADD-RANGE, not FILL.
  // This is the sole PAGE-level test in this file (the acceptance row 4 seam) —
  // it renders BillsGridPage and proves a ctrl-drag GROWS the selection (a
  // second range's worth of data-selected cells appears) while writing NOTHING
  // (no saveEntry/saveReadings broadcast into the dragged cells; the retired
  // ctrl-fill money path is gone). ───────────────────────────────────────────
  describe("Task 4 — ctrl-drag adds range (fill retired)", () => {
    const TEST_USER: User = { id: "u1", fullName: "Admin", email: "a@x.test", role: "manager", orgId: "org-1" };

    function pageRow(apartmentId: string, unitCode: string, tnbTotal: string): GridRow {
      return makeRow({
        apartmentId,
        unitCode,
        isWholeUnit: true,
        entry: makeEntry({ tnbTotal, cleaning: "80.00", airSelangor: "40.00", wifi: "60.00", maintenanceFee: "50.00" }),
        subRows: [
          {
            listingId: `${apartmentId}-room-1`,
            tenancyId: `${apartmentId}-ten-1`,
            partyName: "Tenant",
            previousKwh: "100.00",
            currentKwh: "150.00",
            amount: "25.00",
            ratePerKwh: "0.5000",
            rateConfigured: true,
            rental: "1200.00",
          },
        ],
      });
    }

    function pageResponse(rows: GridRow[]): GridResponse {
      return { period: "2026-07-01", periods: ["2026-07-01"], rows };
    }

    function renderPage() {
      const qc = new QueryClient({
        defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, refetchOnMount: false } },
      });
      return render(
        <QueryClientProvider client={qc}>
          <AuthContext.Provider value={{ user: TEST_USER, setAuth: () => {}, clearAuth: () => {}, isAuthenticated: true }}>
            <MemoryRouter initialEntries={["/billing/tenant-owner-billing"]}>
              <BillsGridPage />
            </MemoryRouter>
          </AuthContext.Provider>
        </QueryClientProvider>,
      );
    }

    beforeEach(() => {
      fetchGridMock.mockReset();
      saveEntryMock.mockReset();
      saveReadingsMock.mockReset();
      billRowsMock.mockReset();
      getBearerConfigMock.mockReset();
      listExpensesMock.mockReset();
      listAttachmentsMock.mockReset();
      getBearerConfigMock.mockResolvedValue({
        apartmentId: "apt-1", tnbPattern: "recharged", airPattern: "recharged",
        cleaningBearer: "owner", wifiBearer: "owner", maintenanceFeeBearer: "owner",
        cleaningRecurringAmount: "80.00", isLocked: false, updatedAt: null,
      });
      listExpensesMock.mockResolvedValue({ items: [], total: "0.00" });
      listAttachmentsMock.mockResolvedValue({ items: [] });
    });

    it("ctrl-drag adds range not fill", async () => {
      fetchGridMock.mockResolvedValue(
        pageResponse([
          pageRow("apt-1", "A-1", "50.00"),
          pageRow("apt-2", "A-2", "20.00"),
          pageRow("apt-3", "A-3", "30.00"),
        ]),
      );
      renderPage();

      await screen.findByText("A-1");

      // First selection: plain-drag a single cell in row0. (cleaning/WiFi are
      // read-only now, so airOwner is the editable anchor subject.)
      const anchor = screen.getAllByTestId("cell-airOwner")[0];
      fireEvent.pointerDown(anchor);
      fireEvent.pointerUp(anchor);
      await waitFor(() => {
        expect(screen.getAllByTestId("cell-airOwner")[0]).toHaveAttribute("data-selected", "true");
      });
      const beforeCount = screen.getAllByTestId("cell-airOwner").filter(
        (c) => c.getAttribute("data-selected") === "true",
      ).length
        + screen.getAllByTestId("cell-tnbOwner").filter((c) => c.getAttribute("data-selected") === "true").length;

      // Second gesture: ctrl-drag from row1 tnbOwner across to row2 tnbOwner —
      // a DISJOINT block. ctrl folds the first cell into committed and opens a
      // fresh rect, so the union GROWS (more data-selected cells).
      const tnb = screen.getAllByTestId("cell-tnbOwner");
      fireEvent.pointerDown(tnb[1], { ctrlKey: true });
      fireEvent.pointerEnter(tnb[2]);
      fireEvent.pointerUp(tnb[2]);

      await waitFor(() => {
        expect(screen.getAllByTestId("cell-tnbOwner")[1]).toHaveAttribute("data-selected", "true");
      });
      // The original cell is still selected (ctrl ADDED, never replaced) …
      expect(screen.getAllByTestId("cell-airOwner")[0]).toHaveAttribute("data-selected", "true");
      // … and the total selected count grew (a second range was added).
      const afterCount = screen.getAllByTestId("cell-airOwner").filter(
        (c) => c.getAttribute("data-selected") === "true",
      ).length
        + screen.getAllByTestId("cell-tnbOwner").filter((c) => c.getAttribute("data-selected") === "true").length;
      expect(afterCount).toBeGreaterThan(beforeCount);

      // NOTHING was filled/broadcast into the dragged cells — no staged write,
      // so the Save button stays at its bare (no dirty-count) label and no
      // saveEntry/saveReadings ever fired (ctrl-fill retired).
      expect(screen.getByRole("button", { name: /^save/i })).toHaveTextContent(/^Save$/);
      expect(saveEntryMock).not.toHaveBeenCalled();
      expect(saveReadingsMock).not.toHaveBeenCalled();
      // The dragged tnbOwner cells still show their own seed, not a filled value.
      expect(within(screen.getAllByTestId("cell-tnbOwner")[2]).getByRole("textbox")).toHaveValue("30.00");
    });
  });
});
