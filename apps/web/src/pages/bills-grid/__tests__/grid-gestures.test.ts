// Excel-Web V2 — platform-aware pointer/click gesture resolution. Pure unit
// tests; `isMac` is injected so both platforms are covered deterministically
// (the module's runtime IS_MAC is `false` under jsdom).
import { describe, it, expect } from "vitest";
import { resolvePointerGesture, resolveClickMods, commandPressed, isContextTrigger } from "../grid-gestures";

const evt = (o: Partial<{ button: number; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }>) => ({
  button: 0,
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...o,
});

describe("grid-gestures — commandPressed (platform multi-select key)", () => {
  it("is Ctrl on Windows/Linux, Cmd on macOS", () => {
    expect(commandPressed(evt({ ctrlKey: true }), false)).toBe(true); // win/linux ctrl
    expect(commandPressed(evt({ metaKey: true }), false)).toBe(false); // win/linux cmd ≠ multi
    expect(commandPressed(evt({ metaKey: true }), true)).toBe(true); // mac cmd
    expect(commandPressed(evt({ ctrlKey: true }), true)).toBe(false); // mac ctrl ≠ multi
  });
});

describe("grid-gestures — resolvePointerGesture", () => {
  it("plain left click → select with no modifiers", () => {
    expect(resolvePointerGesture(evt({ button: 0 }), false)).toEqual({
      kind: "select",
      mods: { shift: false, ctrl: false },
    });
  });

  it("shift+left click → select with shift", () => {
    expect(resolvePointerGesture(evt({ button: 0, shiftKey: true }), false)).toEqual({
      kind: "select",
      mods: { shift: true, ctrl: false },
    });
  });

  it("Ctrl+click on Windows/Linux → select with ctrl (multi-select)", () => {
    expect(resolvePointerGesture(evt({ button: 0, ctrlKey: true }), false)).toEqual({
      kind: "select",
      mods: { shift: false, ctrl: true },
    });
  });

  it("Cmd+click on macOS → select with ctrl (multi-select)", () => {
    expect(resolvePointerGesture(evt({ button: 0, metaKey: true }), true)).toEqual({
      kind: "select",
      mods: { shift: false, ctrl: true },
    });
  });

  it("Cmd(meta)+click on Windows/Linux → select but NOT multi-select", () => {
    expect(resolvePointerGesture(evt({ button: 0, metaKey: true }), false)).toEqual({
      kind: "select",
      mods: { shift: false, ctrl: false },
    });
  });

  it("Ctrl+click on macOS → context (mac Ctrl-click is a right-click), never select", () => {
    expect(resolvePointerGesture(evt({ button: 0, ctrlKey: true }), true)).toEqual({
      kind: "context",
      mods: { shift: false, ctrl: false },
    });
  });

  it("right button → context on every platform", () => {
    expect(resolvePointerGesture(evt({ button: 2 }), false).kind).toBe("context");
    expect(resolvePointerGesture(evt({ button: 2 }), true).kind).toBe("context");
  });

  it("middle button → ignore (grid claims nothing)", () => {
    expect(resolvePointerGesture(evt({ button: 1 }), false).kind).toBe("ignore");
  });

  it("Alt is reserved — an Alt+click resolves to a plain select, never a fill or multi-select", () => {
    expect(resolvePointerGesture(evt({ button: 0, altKey: true }), false)).toEqual({
      kind: "select",
      mods: { shift: false, ctrl: false },
    });
  });
});

describe("grid-gestures — isContextTrigger", () => {
  it("right button anywhere, or mac Ctrl-click", () => {
    expect(isContextTrigger(evt({ button: 2 }), false)).toBe(true);
    expect(isContextTrigger(evt({ button: 0, ctrlKey: true }), true)).toBe(true); // mac
    expect(isContextTrigger(evt({ button: 0, ctrlKey: true }), false)).toBe(false); // win/linux
    expect(isContextTrigger(evt({ button: 0, metaKey: true, ctrlKey: true }), true)).toBe(false); // mac Cmd+Ctrl = multi, not context
  });
});

describe("grid-gestures — resolveClickMods", () => {
  it("mirrors the platform command key", () => {
    expect(resolveClickMods(evt({ ctrlKey: true }), false)).toEqual({ shift: false, ctrl: true });
    expect(resolveClickMods(evt({ metaKey: true }), false)).toEqual({ shift: false, ctrl: false });
    expect(resolveClickMods(evt({ metaKey: true, shiftKey: true }), true)).toEqual({ shift: true, ctrl: true });
  });
});
