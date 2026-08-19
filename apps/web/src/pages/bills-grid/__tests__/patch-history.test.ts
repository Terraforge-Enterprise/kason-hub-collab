import { describe, it, expect } from "vitest";
import { createPatchHistory } from "../patch-history";

const g = (key: string, prev: string | undefined, next: string | undefined) => [{ key, prev, next }];

describe("PatchHistory", () => {
  it("round-trips undo/redo (R1/R2)", () => {
    const h = createPatchHistory<string>();
    h.record(g("a:x", undefined, "1"));
    expect(h.canUndo()).toBe(true);
    expect(h.undo()).toEqual(g("a:x", undefined, "1")); // caller applies prev
    expect(h.canUndo()).toBe(false);
    expect(h.canRedo()).toBe(true);
    expect(h.redo()).toEqual(g("a:x", undefined, "1")); // caller applies next
    expect(h.canUndo()).toBe(true);
  });

  it("record clears the redo stack (R4)", () => {
    const h = createPatchHistory<string>();
    h.record(g("a:x", undefined, "1"));
    h.undo();
    expect(h.canRedo()).toBe(true);
    h.record(g("b:y", undefined, "2"));
    expect(h.canRedo()).toBe(false);
  });

  it("coalesces consecutive same-key edits into one step (R5)", () => {
    const h = createPatchHistory<string>();
    h.record(g("a:x", undefined, "5"), "a:x");
    h.record(g("a:x", "5", "50"), "a:x");
    h.record(g("a:x", "50", "500"), "a:x");
    expect(h.undoDepth()).toBe(1);
    expect(h.undo()).toEqual(g("a:x", undefined, "500")); // prev of first, next of last
  });

  it("does NOT coalesce a same-cell edit that FOLLOWS an undo (breaks the run)", () => {
    const h = createPatchHistory<string>();
    h.record(g("a:x", undefined, "9"), "a:x");
    h.record(g("b:y", undefined, "8"), "b:y");
    h.undo(); // undo b:y — an undo/redo happened, so the coalescing run must break
    h.record(g("a:x", "9", "7"), "a:x"); // new same-cell edit → its OWN step, not merged into "9"
    expect(h.undoDepth()).toBe(2);
    expect(h.undo()).toEqual(g("a:x", "9", "7")); // undoing it returns to "9", not the seed
  });

  it("does NOT coalesce across different keys", () => {
    const h = createPatchHistory<string>();
    h.record(g("a:x", undefined, "5"), "a:x");
    h.record(g("b:x", undefined, "6"), "b:x");
    expect(h.undoDepth()).toBe(2);
  });

  it("returns null on empty stacks (no throw)", () => {
    const h = createPatchHistory<string>();
    expect(h.undo()).toBeNull();
    expect(h.redo()).toBeNull();
    expect(h.canUndo()).toBe(false);
    expect(h.canRedo()).toBe(false);
  });

  it("caps history, dropping the oldest (R10)", () => {
    const h = createPatchHistory<string>(2);
    h.record(g("a", undefined, "1"));
    h.record(g("b", undefined, "2"));
    h.record(g("c", undefined, "3"));
    expect(h.undoDepth()).toBe(2);
    h.undo();
    h.undo();
    expect(h.canUndo()).toBe(false); // "a" was dropped
  });

  it("reset clears both stacks (R8)", () => {
    const h = createPatchHistory<string>();
    h.record(g("a", undefined, "1"));
    h.undo();
    h.reset();
    expect(h.canUndo()).toBe(false);
    expect(h.canRedo()).toBe(false);
  });
});
