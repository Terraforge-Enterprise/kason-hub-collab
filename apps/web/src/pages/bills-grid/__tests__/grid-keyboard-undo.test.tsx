// Undo/redo key bindings on useGridKeyboard: Cmd/Ctrl+Z = undo,
// Cmd+Shift+Z / Ctrl+Y = redo — NAV mode only (edit mode keeps native in-field undo).
import { useMemo } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { useGridKeyboard } from "../use-grid-keyboard";

function Harness(opts: {
  onUndo?: () => void;
  onRedo?: () => void;
  isEditing?: () => boolean;
}) {
  const stable = useMemo(
    () => ({
      onUndo: opts.onUndo,
      onRedo: opts.onRedo,
      isEditing: opts.isEditing,
      cancelActiveEdit: () => {},
      closeTransientPopover: () => false,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fixed identity for the whole test
    [],
  );
  const gridRef = useGridKeyboard(stable);
  return <div ref={gridRef} tabIndex={0} data-testid="grid" />;
}

describe("useGridKeyboard undo/redo bindings", () => {
  it("Cmd/Ctrl+Z fires onUndo and prevents default (R1)", () => {
    const onUndo = vi.fn();
    render(<Harness onUndo={onUndo} />);
    const el = screen.getByTestId("grid");
    const evt = new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true });
    el.dispatchEvent(evt);
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(evt.defaultPrevented).toBe(true);
  });

  it("Cmd/Ctrl+Shift+Z fires onRedo (R2)", () => {
    const onRedo = vi.fn();
    render(<Harness onRedo={onRedo} />);
    // commandPressed is platform-aware (Cmd on macOS, Ctrl elsewhere); the test env
    // is non-mac, so the platform command key here is Ctrl.
    fireEvent.keyDown(screen.getByTestId("grid"), { key: "z", ctrlKey: true, shiftKey: true });
    expect(onRedo).toHaveBeenCalledTimes(1);
  });

  it("Ctrl+Y fires onRedo (R2)", () => {
    const onRedo = vi.fn();
    render(<Harness onRedo={onRedo} />);
    fireEvent.keyDown(screen.getByTestId("grid"), { key: "y", ctrlKey: true });
    expect(onRedo).toHaveBeenCalledTimes(1);
  });

  it("does NOT fire onUndo while editing a cell — native in-field undo (R9)", () => {
    const onUndo = vi.fn();
    const onRedo = vi.fn();
    render(<Harness onUndo={onUndo} onRedo={onRedo} isEditing={() => true} />);
    const el = screen.getByTestId("grid");
    fireEvent.keyDown(el, { key: "z", ctrlKey: true });
    fireEvent.keyDown(el, { key: "z", metaKey: true, shiftKey: true });
    fireEvent.keyDown(el, { key: "y", ctrlKey: true });
    expect(onUndo).not.toHaveBeenCalled();
    expect(onRedo).not.toHaveBeenCalled();
  });

  it("a plain 'z' (no command key) does not fire undo", () => {
    const onUndo = vi.fn();
    render(<Harness onUndo={onUndo} />);
    fireEvent.keyDown(screen.getByTestId("grid"), { key: "z" });
    expect(onUndo).not.toHaveBeenCalled();
  });
});
