import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, beforeEach } from "vitest";
import { useStagedEdits } from "../use-staged-edits";

beforeEach(() => sessionStorage.clear());

describe("useStagedEdits — undo/redo history", () => {
  it("undo removes the staged edit and returns its key; redo restores it (R1/R2)", () => {
    const { result } = renderHook(() => useStagedEdits("2026-07-01"));
    act(() => result.current.stage("a", "x", "5"));
    expect(result.current.staged["a:x"]).toBe("5");
    expect(result.current.canUndo).toBe(true);

    let keys: string[] = [];
    act(() => { keys = result.current.undo(); });
    expect(keys).toEqual(["a:x"]);
    expect(result.current.staged["a:x"]).toBeUndefined();
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(true);

    act(() => result.current.redo());
    expect(result.current.staged["a:x"]).toBe("5");
    expect(result.current.canRedo).toBe(false);
  });

  it("undo restores the PRIOR value, not just clears (over-write case)", () => {
    const { result } = renderHook(() => useStagedEdits("2026-07-01"));
    // seed a saved-then-restaged sequence on DIFFERENT cells so no coalescing
    act(() => result.current.stage("a", "x", "10"));
    act(() => result.current.stage("b", "x", "20"));
    act(() => result.current.stage("a", "y", "30")); // different key → new step
    act(() => result.current.undo()); // reverts a:y
    expect(result.current.staged["a:y"]).toBeUndefined();
    expect(result.current.staged["a:x"]).toBe("10");
    expect(result.current.staged["b:x"]).toBe("20");
  });

  it("coalesces consecutive same-cell edits into ONE undo step (R5)", () => {
    const { result } = renderHook(() => useStagedEdits("2026-07-01"));
    act(() => result.current.stage("a", "x", "5"));
    act(() => result.current.stage("a", "x", "50"));
    act(() => result.current.stage("a", "x", "500"));
    expect(result.current.undoDepth).toBe(1);
    act(() => result.current.undo());
    expect(result.current.staged["a:x"]).toBeUndefined(); // one undo → back to pre-edit
  });

  it("runBatch groups multiple edits into one undo step (R6)", () => {
    const { result } = renderHook(() => useStagedEdits("2026-07-01"));
    act(() =>
      result.current.runBatch(() => {
        result.current.stage("a", "x", "1");
        result.current.stage("b", "x", "2");
        result.current.stage("c", "x", "3");
      }),
    );
    expect(result.current.undoDepth).toBe(1);
    act(() => result.current.undo());
    expect(result.current.staged).toEqual({});
    act(() => result.current.redo());
    expect(result.current.staged).toEqual({ "a:x": "1", "b:x": "2", "c:x": "3" });
  });

  it("a batch that writes the SAME cell twice undoes to the pre-batch value", () => {
    const { result } = renderHook(() => useStagedEdits("2026-07-01"));
    act(() => result.current.stage("a", "x", "1")); // pre-batch value, its own step
    act(() =>
      result.current.runBatch(() => {
        result.current.stage("a", "x", "2");
        result.current.stage("a", "x", "3"); // same cell twice inside one batch
      }),
    );
    expect(result.current.staged["a:x"]).toBe("3");
    act(() => result.current.undo()); // undo the batch → back to the pre-batch "1", not "2"
    expect(result.current.staged["a:x"]).toBe("1");
    act(() => result.current.redo());
    expect(result.current.staged["a:x"]).toBe("3");
  });

  it("a new edit clears the redo stack (R4)", () => {
    const { result } = renderHook(() => useStagedEdits("2026-07-01"));
    act(() => result.current.stage("a", "x", "5"));
    act(() => result.current.undo());
    expect(result.current.canRedo).toBe(true);
    act(() => result.current.stage("b", "y", "9"));
    expect(result.current.canRedo).toBe(false);
  });

  it("clear() resets history (R8)", () => {
    const { result } = renderHook(() => useStagedEdits("2026-07-01"));
    act(() => result.current.stage("a", "x", "5"));
    act(() => result.current.clear());
    expect(result.current.canUndo).toBe(false);
    expect(result.current.staged).toEqual({});
  });

  it("switching period resets history (R8)", () => {
    const { result, rerender } = renderHook(({ p }: { p: string }) => useStagedEdits(p), {
      initialProps: { p: "2026-07-01" },
    });
    act(() => result.current.stage("a", "x", "5"));
    expect(result.current.canUndo).toBe(true);
    rerender({ p: "2026-08-01" });
    expect(result.current.canUndo).toBe(false);
  });

  it("still supports the existing stage/unstage/clear behavior (regression)", () => {
    const { result } = renderHook(() => useStagedEdits("2026-07-01"));
    act(() => result.current.stage("a", "x", "5"));
    expect(result.current.dirtyCount).toBe(1);
    act(() => result.current.unstage("a", "x"));
    expect(result.current.dirtyCount).toBe(0);
    expect(result.current.staged["a:x"]).toBeUndefined();
  });
});
