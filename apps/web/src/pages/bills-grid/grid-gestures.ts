// Bills & Expenses Grid — Excel-Web interaction: platform-aware pointer/keyboard
// gesture resolution. Pure (no DOM, no React). This is the SINGLE place that maps
// raw mouse/key modifiers to a grid action, so the "one gesture → one action,
// no double-firing with the browser" contract lives in one tested unit.
//
// Platform rules (Excel Web parity, user-locked):
//   - Windows/Linux: Ctrl is the multi-select modifier; Ctrl+click stays a click.
//   - macOS:         Cmd (meta) is the multi-select modifier; Ctrl+click is a
//                    RIGHT-CLICK (the OS/browser raise a contextmenu), so it must
//                    NOT run cell selection.
//   - Alt/Option:    reserved — never the retired fill, never a native-selection
//                    trigger. An Alt-held click/drag resolves to a PLAIN gesture.

// jsdom yields no Mac signal (platform "" / a non-Mac userAgent), so IS_MAC is
// deterministically `false` under vitest — the existing ctrl-drag tests keep
// treating Ctrl+click as multi-select. Real macOS Safari/Chrome set
// navigator.platform / userAgentData.platform to "MacIntel"/"macOS".
export const IS_MAC =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad|iPod/i.test(
    (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData?.platform ||
      navigator.platform ||
      navigator.userAgent ||
      "",
  );

/** The resolved selection modifiers. `ctrl` is the PLATFORM multi-select modifier
 * (Cmd on macOS, Ctrl elsewhere) — folded here so the rest of the grid never
 * re-derives platform semantics. */
export interface GestureMods {
  shift: boolean;
  ctrl: boolean;
}

interface RawPointer {
  button: number;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey?: boolean;
}

/** Is the platform multi-select command key held? Cmd on macOS, Ctrl elsewhere. */
export function commandPressed(e: { ctrlKey: boolean; metaKey: boolean }, isMac = IS_MAC): boolean {
  return isMac ? e.metaKey : e.ctrlKey;
}

/** True when a pointer event must be treated as a context (right-click) trigger:
 * the right button anywhere, OR — on macOS only — a Ctrl+click with no Cmd. */
export function isContextTrigger(e: RawPointer, isMac = IS_MAC): boolean {
  if (e.button === 2) return true;
  if (isMac && e.ctrlKey && !e.metaKey && e.button === 0) return true;
  return false;
}

export type PointerGestureKind = "select" | "context" | "ignore";
export interface ResolvedPointerGesture {
  kind: PointerGestureKind;
  mods: GestureMods;
}

/**
 * Resolve a raw pointerdown into a grid gesture:
 *   - "context": right-click / macOS Ctrl-click → the grid's context handler owns
 *     it; cell selection MUST NOT run (no left-drag start, no selection collapse).
 *   - "select": primary-button press → cell selection with resolved {shift,ctrl}.
 *     Alt is deliberately ignored (reserved) — an Alt+click/drag resolves to a
 *     plain selection, never a fill, and never a native text-selection.
 *   - "ignore": any non-primary, non-right button (middle-click etc.).
 */
export function resolvePointerGesture(e: RawPointer, isMac = IS_MAC): ResolvedPointerGesture {
  if (isContextTrigger(e, isMac)) return { kind: "context", mods: { shift: false, ctrl: false } };
  if (e.button !== 0) return { kind: "ignore", mods: { shift: false, ctrl: false } };
  return { kind: "select", mods: { shift: e.shiftKey, ctrl: commandPressed(e, isMac) } };
}

/** Resolve the {shift,ctrl} mods for a plain click's activate path (platform-aware). */
export function resolveClickMods(
  e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean },
  isMac = IS_MAC,
): GestureMods {
  return { shift: e.shiftKey, ctrl: commandPressed(e, isMac) };
}
