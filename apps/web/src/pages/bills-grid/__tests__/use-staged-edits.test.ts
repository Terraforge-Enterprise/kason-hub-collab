// UI Task 9 — crash resilience: sessionStorage staged-edit buffer.
// D5 (no auto-save) means this buffer is the ONLY copy of unsaved work, so it
// must persist to sessionStorage (per-TAB, dies with the tab — NOT localStorage,
// which is durable view state used by view-prefs.ts for a different lifetime),
// survive a remount, clear cleanly, and never let a private-mode sessionStorage
// failure interrupt in-memory editing.
import { describe, expect, it, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useStagedEdits, stagedKey } from "../use-staged-edits";

const PERIOD = "2026-07";
const OTHER_PERIOD = "2026-08";

beforeEach(() => {
  sessionStorage.clear();
});

describe("useStagedEdits", () => {
  it("persists — stage() writes into sessionStorage under stagedKey(period)", () => {
    const { result } = renderHook(() => useStagedEdits(PERIOD));

    act(() => {
      result.current.stage("apt-1:unit-2", "tnb", "123.45");
    });

    const raw = sessionStorage.getItem(stagedKey(PERIOD));
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string)).toEqual({ "apt-1:unit-2:tnb": "123.45" });
  });

  it("restores — a populated sessionStorage buffer survives remount (staged + dirtyCount 1)", () => {
    sessionStorage.setItem(
      stagedKey(PERIOD),
      JSON.stringify({ "apt-1:unit-2:tnb": "999.00" }),
    );

    const { result } = renderHook(() => useStagedEdits(PERIOD));

    expect(result.current.staged).toEqual({ "apt-1:unit-2:tnb": "999.00" });
    expect(result.current.dirtyCount).toBe(1);
  });

  it("clear — resets dirtyCount to 0 and removes the sessionStorage key", () => {
    const { result } = renderHook(() => useStagedEdits(PERIOD));

    act(() => {
      result.current.stage("apt-1:unit-2", "tnb", "123.45");
    });
    expect(result.current.dirtyCount).toBe(1);

    act(() => {
      result.current.clear();
    });

    expect(result.current.dirtyCount).toBe(0);
    expect(sessionStorage.getItem(stagedKey(PERIOD))).toBeNull();
  });

  it("unstage — removes exactly one key + persists; the rest of the buffer is untouched (Task 5)", () => {
    const { result } = renderHook(() => useStagedEdits(PERIOD));

    act(() => {
      result.current.stage("apt-1", "cleaningOwner", "42");
      result.current.stage("apt-1", "tnbOwner", "150.00");
    });
    expect(result.current.dirtyCount).toBe(2);

    act(() => {
      result.current.unstage("apt-1", "cleaningOwner");
    });

    // in-memory: only the un-staged key is gone.
    expect(result.current.staged).toEqual({ "apt-1:tnbOwner": "150.00" });
    expect(result.current.dirtyCount).toBe(1);
    // persisted: sessionStorage mirrors the same removal (survives remount).
    expect(JSON.parse(sessionStorage.getItem(stagedKey(PERIOD)) as string)).toEqual({
      "apt-1:tnbOwner": "150.00",
    });
  });

  it("unstage — removing a key that isn't staged is a safe no-op (idempotent re-run, Task 5)", () => {
    const { result } = renderHook(() => useStagedEdits(PERIOD));
    act(() => {
      result.current.stage("apt-1", "tnbOwner", "150.00");
    });

    act(() => {
      result.current.unstage("apt-1", "cleaningOwner"); // never staged
    });
    expect(result.current.staged).toEqual({ "apt-1:tnbOwner": "150.00" });

    // re-running the same unstage a second time changes nothing (idempotent).
    act(() => {
      result.current.unstage("apt-1", "tnbOwner");
      result.current.unstage("apt-1", "tnbOwner");
    });
    expect(result.current.staged).toEqual({});
    expect(result.current.dirtyCount).toBe(0);
  });

  it("private mode — a throwing sessionStorage.setItem does not throw and the in-memory buffer still holds the edit", () => {
    const setItemSpy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new DOMException("QuotaExceededError");
      });

    const { result } = renderHook(() => useStagedEdits(PERIOD));

    expect(() => {
      act(() => {
        result.current.stage("apt-1:unit-2", "tnb", "123.45");
      });
    }).not.toThrow();

    expect(result.current.staged).toEqual({ "apt-1:unit-2:tnb": "123.45" });
    expect(result.current.dirtyCount).toBe(1);

    setItemSpy.mockRestore();
  });

  it("resyncs — a live period change loads the new period's buffer and never contaminates the old period's key", () => {
    // The new period already has its own persisted buffer from a prior session.
    sessionStorage.setItem(
      stagedKey(OTHER_PERIOD),
      JSON.stringify({ "apt-9:unit-1:tnb": "50.00" }),
    );

    const { result, rerender } = renderHook(
      (period: string) => useStagedEdits(period),
      { initialProps: PERIOD },
    );

    act(() => {
      result.current.stage("apt-1:unit-2", "tnb", "123.45");
    });
    expect(result.current.staged).toEqual({ "apt-1:unit-2:tnb": "123.45" });

    // Mount stays alive (no remount) — only the `period` argument changes.
    rerender(OTHER_PERIOD);

    // (a) staged now reflects the NEW period's buffer, not the old period's edits.
    expect(result.current.staged).toEqual({ "apt-9:unit-1:tnb": "50.00" });
    expect(result.current.dirtyCount).toBe(1);

    act(() => {
      result.current.stage("apt-9:unit-1", "wifi", "88.00");
    });

    // (b) staging on the new period writes only to the new period's stagedKey —
    // the old period's persisted buffer is untouched.
    expect(JSON.parse(sessionStorage.getItem(stagedKey(OTHER_PERIOD)) as string)).toEqual({
      "apt-9:unit-1:tnb": "50.00",
      "apt-9:unit-1:wifi": "88.00",
    });
    expect(JSON.parse(sessionStorage.getItem(stagedKey(PERIOD)) as string)).toEqual({
      "apt-1:unit-2:tnb": "123.45",
    });
  });
});
