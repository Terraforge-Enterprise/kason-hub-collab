// P4 (Excel MOUSE selection, V2) Task 2 — useMultiSelection producer hook.
// Holds `committed: SelectionCell[]` + `rect: {anchor, focus} | null`; every
// gesture recomputes `selectCells(dedupe(committed ∪ rectBetween(rect)))` and
// drives `setActive`. Pure of DOM, NO money write.
//
// The hook's three collaborators are STUBBED as spies (per the brief): a
// deterministic `rectBetween` (so the expected union is computable without the
// heavy navRows machinery — Task 1 already covers the real rectangle), and
// `setActive`/`selectCells` spies whose CALL ARGUMENTS are the assertions. We
// assert the actual union arg handed to `selectCells` after each gesture.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useMultiSelection } from "../use-multi-selection";
import type { CellRef } from "../use-grid-nav";
import type { SelectionCell } from "../use-grid-selection";

// ---- fixtures ---------------------------------------------------------------
// `CellRef.columnId` is the strict `ColumnId` union, so fixtures use real column
// ids (the four cells are pairwise distinct by cellKey+columnId). `rectBetween`
// is stubbed, so these need only typecheck — no navRows geometry is involved.
const A1: CellRef = { cellKey: "apt-A", columnId: "cleaningOwner" };
const D4: CellRef = { cellKey: "apt-D", columnId: "currentKwh" };
const A25: CellRef = { cellKey: "apt-A", columnId: "wifiOwner" };
const C1: CellRef = { cellKey: "apt-C", columnId: "cleaningOwner" };

const sc = (r: CellRef): SelectionCell => ({ cellKey: r.cellKey, columnId: r.columnId });
const dedupeKey = (c: SelectionCell) => `${c.cellKey}:${c.columnId}`;
const keys = (cells: SelectionCell[]) => cells.map(dedupeKey).sort();

/**
 * A deterministic `rectBetween` stub. For endpoints (a,b) it returns the two
 * corner cells [a, b] (deduped when a===b → [a]) — a stand-in "rectangle" that
 * is enough to prove the UNION composition (committed ∪ rect) + dedupe without
 * re-testing Task 1's real geometry. A special "GHOST" cellKey models the
 * disappeared-rect case: any rect touching it flattens to [].
 */
function makeRectBetween() {
  return vi.fn((a: CellRef, b: CellRef): SelectionCell[] => {
    if (a.cellKey === "GHOST" || b.cellKey === "GHOST") return [];
    if (a.cellKey === b.cellKey && a.columnId === b.columnId) return [sc(a)];
    return [sc(a), sc(b)];
  });
}

interface Spies {
  rectBetween: ReturnType<typeof makeRectBetween>;
  setActive: ReturnType<typeof vi.fn>;
  selectCells: ReturnType<typeof vi.fn>;
}
let spies: Spies;
function setup() {
  spies = {
    rectBetween: makeRectBetween(),
    setActive: vi.fn(),
    selectCells: vi.fn(),
  };
  const utils = renderHook(() => useMultiSelection(spies));
  return utils;
}
/** The cells passed to the LAST `selectCells` call. */
function lastUnion(): SelectionCell[] {
  const calls = spies.selectCells.mock.calls;
  return calls[calls.length - 1]?.[0] ?? [];
}

beforeEach(() => setup());

// ---- tests ------------------------------------------------------------------
describe("useMultiSelection — plain pointerdown", () => {
  it("plain pointerdown clears committed, opens a single-cell rect, activates", () => {
    const { result } = renderHook(() => useMultiSelection(spies));
    act(() => result.current.onCellPointerDown(A1, { shift: false, ctrl: false }));
    // rect = {anchor:A1, focus:A1} → rectBetween(A1,A1) = [A1]; committed empty.
    expect(keys(lastUnion())).toEqual(keys([sc(A1)]));
    expect(spies.setActive).toHaveBeenCalledWith(A1.cellKey, A1.columnId);
  });
});

describe("useMultiSelection — plain drag = rectangle", () => {
  it("plain drag = rectangle: pointerdown then enter a far cell selects the full block", () => {
    const { result } = renderHook(() => useMultiSelection(spies));
    act(() => result.current.onCellPointerDown(A1, { shift: false, ctrl: false }));
    act(() => result.current.onCellPointerEnter(D4));
    // rect grew to {anchor:A1, focus:D4} → rectBetween(A1,D4) = [A1, D4] (the block).
    expect(spies.rectBetween).toHaveBeenCalledWith(A1, D4);
    expect(keys(lastUnion())).toEqual(keys([sc(A1), sc(D4)]));
  });

  it("pointerup folds the current rect into committed and keeps the same union", () => {
    const { result } = renderHook(() => useMultiSelection(spies));
    act(() => result.current.onCellPointerDown(A1, { shift: false, ctrl: false }));
    act(() => result.current.onCellPointerEnter(D4));
    act(() => result.current.onPointerUp());
    // Union unchanged after fold — {A1, D4}.
    expect(keys(lastUnion())).toEqual(keys([sc(A1), sc(D4)]));
  });
});

describe("useMultiSelection — ctrl+click toggles", () => {
  it("ctrl+click toggles: adds a disjoint cell, then a repeat ctrl+click removes it", () => {
    const { result } = renderHook(() => useMultiSelection(spies));
    // Seed A25 as committed via a plain-down + pointerup fold.
    act(() => result.current.onCellPointerDown(A25, { shift: false, ctrl: false }));
    act(() => result.current.onPointerUp()); // committed now {A25}
    // Ctrl-down C1 → fold rect (A25 already committed), toggle-ADD C1, open rect {C1,C1}.
    act(() => result.current.onCellPointerDown(C1, { shift: false, ctrl: true }));
    expect(keys(lastUnion())).toEqual(keys([sc(A25), sc(C1)]));
    expect(spies.setActive).toHaveBeenLastCalledWith(C1.cellKey, C1.columnId);
    // Ctrl-down C1 AGAIN → toggle-REMOVE C1; union collapses to {A25}.
    act(() => result.current.onCellPointerDown(C1, { shift: false, ctrl: true }));
    expect(keys(lastUnion())).toEqual(keys([sc(A25)]));
  });

  it("ctrl-before-shift: shift+ctrl together behaves as CTRL (toggle-add), not shift-extend", () => {
    const { result } = renderHook(() => useMultiSelection(spies));
    act(() => result.current.onCellPointerDown(A1, { shift: false, ctrl: false })); // rect {A1}
    act(() => result.current.onPointerUp()); // committed {A1}
    // shift AND ctrl set → CTRL branch: toggle-add C1, NOT a shift-extend of A1→C1.
    act(() => result.current.onCellPointerDown(C1, { shift: true, ctrl: true }));
    expect(keys(lastUnion())).toEqual(keys([sc(A1), sc(C1)]));
    // A shift-extend would have produced rectBetween(A1,C1)=[A1,C1] with committed
    // untouched — here committed==={A1,C1} and the OPEN rect is {C1,C1}, so a
    // subsequent same-cell enter keeps the union stable at {A1,C1}.
    act(() => result.current.onCellPointerEnter(C1));
    expect(keys(lastUnion())).toEqual(keys([sc(A1), sc(C1)]));
  });
});

describe("useMultiSelection — shift extend", () => {
  it("shift pointerdown extends the open rect's focus (spanning from the anchor) and leaves committed untouched", () => {
    const { result } = renderHook(() => useMultiSelection(spies));
    // committed {A25} (plain-down + pointerup fold), then a fresh plain rect at A1.
    act(() => result.current.onCellPointerDown(A25, { shift: false, ctrl: false }));
    act(() => result.current.onPointerUp()); // committed {A25}, rect null
    act(() => result.current.onCellPointerDown(A1, { shift: false, ctrl: false })); // plain → committed CLEARED, rect {A1}
    // Shift-down D4 extends the OPEN rect's focus from anchor A1 → rect {A1,D4}.
    act(() => result.current.onCellPointerDown(D4, { shift: true, ctrl: false }));
    expect(spies.rectBetween).toHaveBeenLastCalledWith(A1, D4);
    expect(keys(lastUnion())).toEqual(keys([sc(A1), sc(D4)]));
  });

  it("shift pointerdown with NO open rect anchors at the clicked cell", () => {
    const { result } = renderHook(() => useMultiSelection(spies));
    act(() => result.current.onCellPointerDown(D4, { shift: true, ctrl: false }));
    // No prior rect → anchor=focus=D4 → union [D4].
    expect(keys(lastUnion())).toEqual(keys([sc(D4)]));
  });
});

describe("useMultiSelection — drag-grow guard", () => {
  it("onCellPointerEnter is a no-op when no rect is open (after pointerup/reset)", () => {
    const { result } = renderHook(() => useMultiSelection(spies));
    act(() => result.current.reset());
    const before = spies.selectCells.mock.calls.length;
    act(() => result.current.onCellPointerEnter(D4)); // no open rect → ignored
    expect(spies.selectCells.mock.calls.length).toBe(before);
  });
});

describe("useMultiSelection — collapse clears", () => {
  it("collapse clears: collapseTo(cell) clears committed and selects exactly [cell]", () => {
    const { result } = renderHook(() => useMultiSelection(spies));
    // Build committed {A25} (plain-down + pointerup fold) + an open rect {C1..D4}.
    act(() => result.current.onCellPointerDown(A25, { shift: false, ctrl: false }));
    act(() => result.current.onPointerUp()); // committed {A25}, rect null
    act(() => result.current.onCellPointerDown(C1, { shift: false, ctrl: true })); // toggle-add → committed {A25,C1}, rect {C1}
    act(() => result.current.onCellPointerEnter(D4)); // rect grows {C1,D4} — union {A25,C1,D4}
    // collapseTo(A1) must CLEAR committed {A25,C1} AND the rect, selecting only [A1].
    act(() => result.current.collapseTo(A1));
    expect(spies.selectCells).toHaveBeenLastCalledWith([sc(A1)]);
    expect(keys(lastUnion())).toEqual(keys([sc(A1)]));
  });

  it("collapseTo(null) clears everything → selectCells([])", () => {
    const { result } = renderHook(() => useMultiSelection(spies));
    act(() => result.current.onCellPointerDown(A1, { shift: false, ctrl: false }));
    act(() => result.current.onCellPointerEnter(D4));
    act(() => result.current.collapseTo(null));
    expect(spies.selectCells).toHaveBeenLastCalledWith([]);
    expect(keys(lastUnion())).toEqual([]);
  });
});

describe("useMultiSelection — disappeared rect no crash", () => {
  it("disappeared rect no crash: a rect whose rectBetween returns [] is excluded from the union", () => {
    const GHOST: CellRef = { cellKey: "GHOST", columnId: "maintenanceFee" };
    const { result } = renderHook(() => useMultiSelection(spies));
    // Seed committed {A25} cleanly: plain-down then pointerup folds the rect in.
    act(() => result.current.onCellPointerDown(A25, { shift: false, ctrl: false }));
    act(() => result.current.onPointerUp()); // committed {A25}, rect null
    // Open a rect on the GHOST endpoints WITHOUT clearing committed: shift-down
    // (rect null → anchor=focus=GHOST). rectBetween(GHOST,GHOST) returns [] (the
    // endpoint no longer resolves in navRows), so the union is committed only.
    act(() => result.current.onCellPointerDown(GHOST, { shift: true, ctrl: false }));
    expect(keys(lastUnion())).toEqual(keys([sc(A25)])); // GHOST contributes nothing
    // pointerup folds the empty rect — must not crash on the [] fold.
    expect(() => act(() => result.current.onPointerUp())).not.toThrow();
    // Folding an empty rect leaves committed {A25} — union still excludes GHOST.
    expect(keys(lastUnion())).toEqual(keys([sc(A25)]));
  });
});

describe("useMultiSelection — select all", () => {
  it("selectAll replaces the selection with the given cells (deduped) and clears any open rect", () => {
    const { result } = renderHook(() => useMultiSelection(spies));
    // Open a rect first (would otherwise re-materialise into the union).
    act(() => result.current.onCellPointerDown(A1, { shift: false, ctrl: false }));
    // Ctrl/Cmd+A hands the full cell set (with a duplicate) → deduped union.
    act(() => result.current.selectAll([sc(A1), sc(C1), sc(A1)]));
    expect(keys(lastUnion())).toEqual(keys([sc(A1), sc(C1)]));
    // The open rect was cleared, so a subsequent drag-enter is a no-op.
    const before = spies.selectCells.mock.calls.length;
    act(() => result.current.onCellPointerEnter(D4));
    expect(spies.selectCells.mock.calls.length).toBe(before);
  });
});

describe("useMultiSelection — reset", () => {
  it("reset clears committed + rect (next enter is a no-op, union pristine on next down)", () => {
    const { result } = renderHook(() => useMultiSelection(spies));
    act(() => result.current.onCellPointerDown(A1, { shift: false, ctrl: false }));
    act(() => result.current.onCellPointerEnter(D4));
    act(() => result.current.reset());
    act(() => result.current.onCellPointerDown(C1, { shift: false, ctrl: false }));
    // A fresh plain down after reset → committed empty, rect {C1} → union [C1].
    expect(keys(lastUnion())).toEqual(keys([sc(C1)]));
  });
});
