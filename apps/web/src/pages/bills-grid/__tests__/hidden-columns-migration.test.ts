// One-time repair of a stored hidden-columns preference (2026-08-14, review finding 5).
//
// From bd80276a (2026-07-27) until the bearer fix, the AIR "Tenant" column was
// PERMANENTLY blank — its applicability keyed on a legacy value the Setting drawer could
// no longer write. Hiding a column that never shows anything is exactly what a tidy admin
// would do, and `hiddenColumns` is per-user localStorage that outlives the deploy
// (use-grid-selection.ts) and filters what reaches the grid (bills-grid-page.tsx).
//
// Now that the column carries the water bill for every tenant-borne unit — which is the
// SEEDED DEFAULT for both listing modes — such a user would open the grid to "—" in the
// Owner cell and no cell anywhere to read or type the amount into. The money column would
// simply be gone, with nothing on screen explaining why.
//
// So the stored preference is repaired ONCE. It is not a permanent ban: an admin who
// hides the column again afterwards keeps it hidden, because the migration records that
// it ran rather than re-asserting itself on every load.
import { describe, expect, it, beforeEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { unhideRelocatedAirColumn, useGridSelection } from "../use-grid-selection";
import { loadPref, savePref } from "@/lib/view-prefs";

const NS = "bills-grid";

describe("unhideRelocatedAirColumn — the pure rule", () => {
  it("drops airTenant when it was hidden", () => {
    expect(unhideRelocatedAirColumn(["airTenant"])).toEqual([]);
  });

  it("leaves every other hidden column exactly as it was", () => {
    expect(unhideRelocatedAirColumn(["rental", "airTenant", "wifiTenant"])).toEqual(["rental", "wifiTenant"]);
  });

  it("is a no-op when airTenant was never hidden", () => {
    const stored = ["rental", "wifiTenant"];
    expect(unhideRelocatedAirColumn(stored)).toEqual(stored);
  });

  it("handles an empty preference", () => {
    expect(unhideRelocatedAirColumn([])).toEqual([]);
  });
});

describe("useGridSelection — the migration runs once, then gets out of the way", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("un-hides airTenant for a user who hid it while it was blank", () => {
    savePref(NS, "hiddenColumns", ["rental", "airTenant"]);

    const { result } = renderHook(() => useGridSelection());

    expect(result.current.hiddenColumns).toEqual(["rental"]);
    // Persisted, not just in memory — otherwise it would re-run on every mount.
    expect(loadPref<string[]>(NS, "hiddenColumns", [])).toEqual(["rental"]);
  });

  it("does NOT re-unhide it on a later mount — a deliberate re-hide sticks", () => {
    savePref(NS, "hiddenColumns", ["airTenant"]);
    renderHook(() => useGridSelection()); // migration runs here

    // The admin now hides it again on purpose, with the column working.
    savePref(NS, "hiddenColumns", ["airTenant"]);
    const { result } = renderHook(() => useGridSelection());

    expect(result.current.hiddenColumns).toEqual(["airTenant"]);
  });

  it("touches nothing for a user with no stored preference", () => {
    const { result } = renderHook(() => useGridSelection());
    expect(result.current.hiddenColumns).toEqual([]);
  });

  it("does not record itself as done when the repair could not be persisted", () => {
    // savePref swallows quota errors by design (view-prefs.ts), and this namespace also
    // stores cellColours, which can fill the quota. Flagging before the repair landed
    // would strand the profile in exactly the state the migration exists to undo:
    // "already repaired" recorded, the money column still hidden, and no second chance.
    savePref(NS, "hiddenColumns", ["airTenant"]);
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key: string) {
      if (key === "bills-grid:hiddenColumns") throw new DOMException("QuotaExceededError");
      // Let every other key (the done-flag included) write normally, so the test proves
      // the ORDER guard rather than a blanket storage outage.
      return Storage.prototype.getItem.call(this, key) as unknown as void;
    });

    renderHook(() => useGridSelection());
    setItem.mockRestore();

    expect(loadPref<boolean>(NS, "airTenantUnhideDone", false)).toBe(false);
    // Next mount, with storage healthy again, still repairs.
    const { result } = renderHook(() => useGridSelection());
    expect(result.current.hiddenColumns).toEqual([]);
  });
});

describe("a corrupt stored preference must not white-screen the grid", () => {
  // localStorage is user-controlled and `loadPref` CASTS the JSON.parse result without
  // validating it (view-prefs.ts) — its internal try/catch cannot help, because the throw
  // would happen after it returns. This state runs inside a useState initializer, so a
  // TypeError here takes down the whole bills-grid page rather than one cell.
  beforeEach(() => {
    localStorage.clear();
  });

  it.each([
    ["an object", '{"airTenant":true}'],
    ["a string", '"airTenant"'],
    ["a number", "42"],
    ["null", "null"],
    ["malformed JSON", "{not json"],
  ])("survives %s where an array was expected", (_label, raw) => {
    localStorage.setItem("bills-grid:hiddenColumns", raw);

    const { result } = renderHook(() => useGridSelection());

    expect(result.current.hiddenColumns).toEqual([]);
  });

  it("keeps the string entries out of a mixed array and drops the rest", () => {
    localStorage.setItem("bills-grid:hiddenColumns", JSON.stringify(["rental", 7, null, "airTenant", { a: 1 }]));

    const { result } = renderHook(() => useGridSelection());

    expect(result.current.hiddenColumns).toEqual(["rental"]);
  });
});
