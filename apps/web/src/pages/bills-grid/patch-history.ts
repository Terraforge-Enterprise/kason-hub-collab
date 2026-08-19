// Pure, framework-agnostic patch-based command history for a keyed buffer.
// A `Patch` is one key's before/after value; a `PatchGroup` is ONE logical undo
// step (a single-cell edit is 1 patch; a Delete/fill over N cells is N patches in
// one group). Nothing here knows about React or bills-grid — it is unit-tested in
// isolation and reusable for any `Record<string, V>` buffer.
//
// `undo()`/`redo()` do NOT mutate a buffer themselves — they return the group for
// the CALLER to apply (undo → set each key to `prev`; redo → set each key to
// `next`). This keeps the engine pure and lets the buffer owner control persistence
// and display sync.
export interface Patch<V = string> {
  key: string;
  prev: V | undefined; // undefined = key absent before the change
  next: V | undefined; // undefined = key removed by the change
}
export type PatchGroup<V = string> = Patch<V>[];

export interface PatchHistory<V = string> {
  /** Push one logical step. ALWAYS clears the redo stack (a new edit forks a new
   *  future). When `coalesceKey` matches the top step's single-patch key, the two
   *  merge into one step (consecutive edits to the same cell = one undo). */
  record(group: PatchGroup<V>, coalesceKey?: string): void;
  /** Move the top undo step to the redo stack and return it (apply each `prev`). */
  undo(): PatchGroup<V> | null;
  /** Move the top redo step back to the undo stack and return it (apply each `next`). */
  redo(): PatchGroup<V> | null;
  canUndo(): boolean;
  canRedo(): boolean;
  undoDepth(): number;
  redoDepth(): number;
  /** Clear both stacks (e.g. Save committed, or the period changed). */
  reset(): void;
}

export function createPatchHistory<V = string>(cap = 100): PatchHistory<V> {
  let undoStack: PatchGroup<V>[] = [];
  let redoStack: PatchGroup<V>[] = [];

  return {
    record(group, coalesceKey) {
      const hadRedo = redoStack.length > 0;
      redoStack = []; // any new edit discards the redo branch (R4)
      const top = undoStack[undoStack.length - 1];
      if (
        coalesceKey != null &&
        !hadRedo && // an intervening undo/redo BREAKS the coalescing run (real-editor behavior)
        group.length === 1 &&
        top &&
        top.length === 1 &&
        top[0].key === coalesceKey
      ) {
        // Merge consecutive same-cell edits into one step: keep the ORIGINAL prev,
        // take the LATEST next — undoing once returns the cell to its pre-edit value (R5).
        top[0] = { key: top[0].key, prev: top[0].prev, next: group[0].next };
        return;
      }
      undoStack.push(group);
      if (undoStack.length > cap) undoStack.shift(); // bound memory — drop oldest (R10)
    },
    undo() {
      const group = undoStack.pop();
      if (!group) return null;
      redoStack.push(group);
      return group;
    },
    redo() {
      const group = redoStack.pop();
      if (!group) return null;
      undoStack.push(group);
      return group;
    },
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
    undoDepth: () => undoStack.length,
    redoDepth: () => redoStack.length,
    reset() {
      undoStack = [];
      redoStack = [];
    },
  };
}
