import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadCellColours, loadPref, savePref, saveCellColours } from "../view-prefs";

beforeEach(() => localStorage.clear());

describe("view-prefs", () => {
  it("round-trips a namespaced value", () => {
    savePref("bills-grid", "hiddenColumns", ["wifi", "maintenanceFee"]);
    expect(loadPref<string[]>("bills-grid", "hiddenColumns", [])).toEqual(["wifi", "maintenanceFee"]);
    expect(localStorage.getItem("bills-grid:hiddenColumns")).toBeTruthy();
  });

  it("does not throw when storage quota is exceeded", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("quota", "QuotaExceededError"); });
    expect(() => saveCellColours("bills-grid", { "a1:tnb:2026-07-01": "#d9ead3" })).not.toThrow();
    vi.restoreAllMocks();
  });

  it("returns {} for malformed JSON rather than throwing", () => {
    localStorage.setItem("bills-grid:cellColours", "{not json");
    expect(loadCellColours("bills-grid")).toEqual({});
  });
});
