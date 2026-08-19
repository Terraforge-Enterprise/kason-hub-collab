import { useCallback, useRef } from "react";
import { commandPressed } from "./grid-gestures";
/**
 * R32: Escape must NOT close the grid / full-screen view. It cancels the active cell
 * edit (reverting that ONE cell) and closes transient popovers. It never dismisses the
 * surface and never flushes the staged-edit buffer. Scoped to the grid container so
 * unrelated app dialogs keep their own Escape.
 *
 * Callback-ref, not `useEffect([container, opts])`: the grid container can mount
 * AFTER first paint (e.g. the page shell renders the grid only once `fetchGrid`
 * resolves). A `useRef` container object never changes identity, so an effect keyed
 * on `[container, opts]` (with a memoized `opts`) would run once while
 * `container.current` is still `null`, bail, and never re-run once the node
 * actually mounts — the Escape listener would never attach. A ref callback is
 * invoked by React exactly when the node mounts/unmounts (and again whenever this
 * callback's identity changes, e.g. when `opts` changes), so there is no
 * mount-timing race to hide.
 */
// P4 Task 4: ArrowUp/Down/Left/Right → nav move direction. Kept as a module
// constant (stable identity, no per-event allocation).
const ARROW_DIR: Record<string, "up" | "down" | "left" | "right"> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};

export function useGridKeyboard(opts: {
  cancelActiveEdit: () => void;
  closeTransientPopover: () => boolean;
  // P4 Task 4: arrow-nav. OPTIONAL — absent ⇒ arrow keys fall through untouched
  // (byte-identical to the Escape-only listener). When present, the four arrows
  // move the active cell and preventDefault (so the grid container never
  // scrolls). Every OTHER key (Cmd/Ctrl+K, plain chars) still passes through,
  // so the layout-level search shortcut keeps working (R15 scope guard).
  onArrow?: (dir: "up" | "down" | "left" | "right") => void;
  // P4 Task 6: Shift+arrow range-extend. OPTIONAL — absent ⇒ Shift+arrow falls
  // back to a plain arrow move (byte-identical to Task 4). When present, a
  // Shift-held arrow EXTENDS a rectangular selection from the anchor instead of
  // collapsing to a single cell (R6/R7/R8). Selection only — NO money write.
  onRange?: (dir: "up" | "down" | "left" | "right") => void;
  // P4 Task 5: Excel commit-and-move. OPTIONAL — absent ⇒ Enter/Tab fall through
  // untouched (parity). When present, Enter commits + moves DOWN, Tab commits +
  // moves RIGHT, Shift inverts to up/left (mapped in the page handler). The
  // value is ALREADY staged by typing (the input's own onChange → handleCellEdit
  // chokepoint) — commit is STAGE-ONLY + MOVE and NEVER issues a network request
  // (Save stays the explicit persist step, R9). Sits BEFORE the Escape branch so
  // an Enter/Tab in the grid never leaks to a parent Dialog/Sheet.
  onCommitMove?: (dir: "down" | "right", shift: boolean) => void;
  // P4 Task 7: Delete/Backspace clear-by-grain (MONEY-CRITICAL). OPTIONAL —
  // absent ⇒ Delete/Backspace fall through untouched (parity). When present, the
  // page's onDelete clears the active cell (or the whole Shift-range) BY GRAIN,
  // routing every write through the handleCellEdit chokepoint (billed → skip,
  // meter → blank, staged → revert, saved-money → no-op+cue). Sits BEFORE the
  // Escape branch so a Delete/Backspace in the grid never leaks to a parent
  // Dialog/Sheet. No network request here — Save stays the explicit persist step.
  onDelete?: () => void;
  // Excel-Web V2 — edit-mode gate. OPTIONAL — absent ⇒ `false` (byte-identical
  // to the pre-V2 nav-always behaviour). When it returns TRUE (the user is
  // editing inside a cell input, entered via double-click / F2 / type-to-edit),
  // the grid RELEASES arrows/Home/End/Delete/chars/Cmd+A/Cmd+C back to the
  // browser so the input behaves like a normal text field (caret movement, text
  // selection). Only Enter/Tab (commit-and-move) and Escape (revert) stay
  // grid-owned in edit mode.
  isEditing?: () => boolean;
  // Excel-Web V2 — enter edit mode from the keyboard: F2, or the first printable
  // character typed on a selected cell (type-to-edit). OPTIONAL. A printable char
  // is NOT preventDefaulted, so it still reaches the focused input; onBeginEdit
  // only flips the mode so the NEXT arrow moves the caret, not the active cell.
  onBeginEdit?: () => void;
  // Excel-Web V2 — Ctrl/Cmd+A selects ALL grid cells (never the page's text).
  // OPTIONAL. Only fires in cell-select mode (not while editing a field). The
  // platform command key is Cmd on macOS, Ctrl elsewhere.
  onSelectAll?: () => void;
  // Excel-Web V2 — Ctrl/Cmd+C copies the selected rectangular range as TSV.
  // OPTIONAL. Returns TRUE when the grid handled the copy (so we preventDefault
  // the native copy); FALSE when it declined (nothing selected, a non-contiguous
  // selection cue was shown but native should stay, or the focused input has its
  // own text selection that native copy should win). Only fires in select mode.
  onCopy?: () => boolean;
  // Excel-Web V2 — undo/redo over the staged edit buffer. OPTIONAL. Cmd/Ctrl+Z =
  // undo, Cmd+Shift+Z / Ctrl+Y = redo. NAV mode ONLY — in edit mode the focused
  // input keeps the browser's native in-field undo (R9). No network request:
  // undo/redo only rewrite the in-memory staged buffer.
  onUndo?: () => void;
  onRedo?: () => void;
}) {
  const cleanupRef = useRef<(() => void) | null>(null);
  return useCallback(
    (el: HTMLElement | null) => {
      cleanupRef.current?.();
      cleanupRef.current = null;
      if (!el) return;
      const onKeyDown = (e: KeyboardEvent) => {
        // Excel-Web V2 edit-mode gate: while the user is editing INSIDE a cell
        // input, the input owns arrows/Home/End/Delete/chars/Cmd+A/Cmd+C (native
        // caret + text selection). The grid keeps ONLY Enter/Tab (commit-and-move)
        // and Escape (revert). All the select-mode branches below are skipped.
        const editing = opts.isEditing?.() ?? false;

        if (!editing) {
          // P4 Task 4 (R15): route the four arrows to nav BEFORE the Escape
          // branch. `preventDefault` stops the grid container from scrolling; we
          // do NOT stopPropagation (nav is grid-local, nothing above it acts on
          // arrows). A modifier key held with an arrow (e.g. Cmd+ArrowDown =
          // browser "scroll to bottom" / a global shortcut) is deliberately NOT
          // hijacked — only a bare arrow moves the active cell. Everything that
          // is neither a bare arrow nor Escape (Cmd/Ctrl+K, plain characters)
          // returns from here untouched, so the layout search still opens.
          const dir = ARROW_DIR[e.key];
          if (dir && opts.onArrow && !e.metaKey && !e.ctrlKey && !e.altKey) {
            // P4 Task 6 (R6/R7/R8): Shift+arrow EXTENDS a rectangular selection
            // from the anchor (onRange); a bare arrow moves the active cell and
            // COLLAPSES any range (onArrow). Shift is the ONLY modifier permitted
            // here — meta/ctrl/alt already returned above (global shortcuts).
            if (e.shiftKey && opts.onRange) opts.onRange(dir);
            else opts.onArrow(dir);
            e.preventDefault();
            return;
          }
          // P4 Task 7 (R9/R10): Delete/Backspace clear-by-grain — BEFORE the
          // Escape branch (so a Delete/Backspace in the grid never leaks to a
          // parent Dialog/Sheet). The page's onDelete clears the active cell or
          // the whole Shift-range by grain via the handleCellEdit chokepoint; it
          // never issues a network request (Save stays the explicit persist step).
          // preventDefault stops the browser's own Backspace "navigate back".
          if ((e.key === "Delete" || e.key === "Backspace") && opts.onDelete) {
            opts.onDelete();
            e.preventDefault();
            return;
          }
          // Excel-Web V2: Ctrl/Cmd+A → select ALL grid cells (never page text).
          // Platform command key (Cmd on macOS, Ctrl elsewhere); Shift/Alt-held
          // variants fall through (not select-all).
          if ((e.key === "a" || e.key === "A") && commandPressed(e) && !e.shiftKey && !e.altKey && opts.onSelectAll) {
            opts.onSelectAll();
            e.preventDefault();
            return;
          }
          // Excel-Web V2: Ctrl/Cmd+C → copy the selected rectangular range as
          // TSV. Only reached in navigation mode (edit mode released it to the
          // browser above, so in-field text copy still works). The page returns
          // FALSE (native copy wins) when nothing is selected — only
          // preventDefault when the grid actually produced the clipboard payload.
          if ((e.key === "c" || e.key === "C") && commandPressed(e) && !e.shiftKey && !e.altKey && opts.onCopy) {
            if (opts.onCopy()) e.preventDefault();
            return;
          }
          // Excel-Web V2: Cmd/Ctrl+Z = undo, Cmd+Shift+Z / Ctrl+Y = redo. NAV mode
          // only (edit mode released everything above, so the input keeps native
          // in-field undo, R9). Alt-held variants fall through (reserved).
          if ((e.key === "z" || e.key === "Z") && commandPressed(e) && !e.altKey && (opts.onUndo || opts.onRedo)) {
            if (e.shiftKey) {
              if (opts.onRedo) { opts.onRedo(); e.preventDefault(); return; }
            } else if (opts.onUndo) { opts.onUndo(); e.preventDefault(); return; }
          }
          if ((e.key === "y" || e.key === "Y") && commandPressed(e) && !e.shiftKey && !e.altKey && opts.onRedo) {
            opts.onRedo(); e.preventDefault(); return;
          }
          // Excel-Web V2: F2 enters edit mode (Excel's edit-cell key) so arrows
          // then move the caret INSIDE the input instead of the active cell.
          // Type-to-edit is deliberately NOT a trigger: on this always-live-input
          // grid, typing on a selected cell replaces its value (type-to-replace,
          // Task 5) but stays in SELECT mode — so Delete still clears-by-grain and
          // arrows still navigate. Only an explicit F2 / double-click opts into
          // in-cell caret editing (the user contract: caret works "while editing").
          if (e.key === "F2" && opts.onBeginEdit) {
            opts.onBeginEdit();
            e.preventDefault();
            return;
          }
        }

        // P4 Task 5 (R3): Enter/Tab commit-and-move — in BOTH modes (in edit mode
        // this also exits editing, via the page's active-cell change). The active
        // cell's value is already staged (typing routed through the input's
        // onChange → handleCellEdit); Enter/Tab ONLY move (down/right, Shift →
        // up/left in the page handler). No network request here — Save stays the
        // explicit persist step (R9). preventDefault stops the browser's own Tab
        // focus-traversal / Enter form-submit.
        if (e.key === "Enter" && opts.onCommitMove) {
          opts.onCommitMove("down", e.shiftKey);
          e.preventDefault();
          return;
        }
        if (e.key === "Tab" && opts.onCommitMove) {
          opts.onCommitMove("right", e.shiftKey);
          e.preventDefault();
          return;
        }
        if (e.key !== "Escape") return; // non-Escape keys pass through untouched
        if (opts.closeTransientPopover()) {
          e.stopPropagation();
          return;
        }
        opts.cancelActiveEdit();
        e.stopPropagation(); // do NOT let a parent Dialog/Sheet close the grid
        e.preventDefault();
      };
      el.addEventListener("keydown", onKeyDown);
      cleanupRef.current = () => el.removeEventListener("keydown", onKeyDown);
    },
    // opts change → new callback identity → React detaches the old ref (running
    // its cleanup) and attaches the new one to the same node.
    [opts],
  );
}
// Caller (ui-10): const gridRef = useGridKeyboard(opts); <div ref={gridRef}>…</div>
