// UI Task 9 — nested GridErrorBoundary. React routes a thrown error to the
// NEAREST boundary, so this nested boundary catches grid render crashes before
// ChunkErrorBoundary (the outer net) ever sees them. It must NEVER touch
// sessionStorage — the staged buffer is the only copy of unsaved work under
// D5 (no auto-save), and the crash-recovery path must not destroy it.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GridErrorBoundary } from "../grid-error-boundary";

function Boom(): never {
  throw new Error("grid render crash");
}

beforeEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("GridErrorBoundary", () => {
  it("Reload grid panel — a child throw renders a 'Reload grid' button", () => {
    // Suppress the expected React error-boundary console.error noise.
    vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <GridErrorBoundary onReload={vi.fn()}>
        <Boom />
      </GridErrorBoundary>,
    );

    expect(screen.getByRole("button", { name: /reload grid/i })).toBeInTheDocument();
  });

  it("remounts without reloading the page — click fires onReload, never window.location.reload", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const reloadSpy = vi.fn();
    const user = userEvent.setup();
    // jsdom's window.location.reload is a non-configurable, non-writable own
    // property — it can't be vi.spyOn'd or reassigned directly. Swap the whole
    // `location` object for the duration of this test instead (same pattern as
    // lib/__tests__/api-client.test.ts), then restore it.
    const originalLocation = window.location;
    const windowReloadSpy = vi.fn();
    Object.defineProperty(window, "location", {
      value: { ...originalLocation, reload: windowReloadSpy },
      writable: true,
      configurable: true,
    });

    render(
      <GridErrorBoundary onReload={reloadSpy}>
        <Boom />
      </GridErrorBoundary>,
    );

    await user.click(screen.getByRole("button", { name: /reload grid/i }));

    expect(reloadSpy).toHaveBeenCalledTimes(1);
    expect(windowReloadSpy).not.toHaveBeenCalled();

    Object.defineProperty(window, "location", {
      value: originalLocation,
      writable: true,
      configurable: true,
    });
  });

  it("does not clear the staged buffer — a staged sessionStorage buffer survives a child throw untouched", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    sessionStorage.setItem("bills-grid:staged:2026-07", JSON.stringify({ "a:b:tnb": "1" }));

    render(
      <GridErrorBoundary onReload={vi.fn()}>
        <Boom />
      </GridErrorBoundary>,
    );

    expect(sessionStorage.getItem("bills-grid:staged:2026-07")).toBe(
      JSON.stringify({ "a:b:tnb": "1" }),
    );
  });
});
