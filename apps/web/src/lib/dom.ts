import type { KeyboardEvent as ReactKeyboardEvent } from "react";

/**
 * True when a keyboard event originated from an editable form control or
 * content-editable region. Use in keydown handlers on clickable wrappers
 * so Space/Enter inside child inputs is not swallowed.
 *
 * Why: synthetic events bubble through React's component tree even when
 * the DOM target is in a portal. Without this guard, an onKeyDown on a
 * row container that calls `e.preventDefault()` will block users from
 * typing a space inside an <input> rendered by a child <Dialog>.
 *
 * NOTE: dialog triggers belong in click filters, not keyboard filters —
 * keyboard interaction with a dialog trigger SHOULD open the dialog, so
 * we don't bail on them here.
 */
export function isEditableKeyTarget(
  e: ReactKeyboardEvent | KeyboardEvent,
): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  // Strict contenteditable match: only "true" or empty-string-implies-true
  // counts; "false" or "inherit" must NOT bail.
  const ce = t.closest("[contenteditable]") as HTMLElement | null;
  const ceActive =
    ce &&
    (ce.getAttribute("contenteditable") === "" ||
      ce.getAttribute("contenteditable") === "true");
  return !!t.closest("input, textarea, select") || !!ceActive;
}
