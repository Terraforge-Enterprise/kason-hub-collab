import { describe, it, expect } from "vitest";
import { summarizeStagedByUnit } from "../staged-summary";
import type { GridRow } from "@/api/bills-grid";

const rows = [
  { apartmentId: "apt-A", unitCode: "A-01", subRows: [{ listingId: "list-A1", tenancyId: "t", partyName: "Ali" }] },
  { apartmentId: "apt-B", unitCode: "B-02", subRows: [] },
] as unknown as GridRow[];

describe("summarizeStagedByUnit", () => {
  it("groups staged cells per owning unit with apartmentId + per-cell label/value (unit-grain + sub-row)", () => {
    const staged = {
      "apt-A:cleaningOwner": "10",     // unit-grain → A-01
      "list-A1:currentKwh": "42",      // sub-row of A-01 (tenant Ali)
      "apt-B:wifiOwner": "30",         // unit-grain → B-02
    };
    expect(summarizeStagedByUnit(staged, rows)).toEqual([
      {
        unitCode: "A-01",
        apartmentId: "apt-A",
        cellCount: 2,
        cells: [
          { cellKey: "apt-A", columnId: "cleaningOwner", label: "Cleaning Owner", value: "10" },
          // sub-row meter cell carries the room's tenant name to disambiguate
          { cellKey: "list-A1", columnId: "currentKwh", label: "TNB Current Meter (kwh) — Ali", value: "42" },
        ],
      },
      {
        unitCode: "B-02",
        apartmentId: "apt-B",
        cellCount: 1,
        cells: [{ cellKey: "apt-B", columnId: "wifiOwner", label: "WiFi Owner", value: "30" }],
      },
    ]);
  });

  it("orders a unit's cells by grid column, not staged-key insertion order", () => {
    // wifiOwner (later column) staged BEFORE cleaningOwner (earlier column).
    const staged = { "apt-A:wifiOwner": "30", "apt-A:cleaningOwner": "10" };
    const [unit] = summarizeStagedByUnit(staged, rows);
    expect(unit.cells.map((c) => c.columnId)).toEqual(["cleaningOwner", "wifiOwner"]);
  });

  it("preserves a cleared (blanked) cell as an empty-string value", () => {
    const staged = { "apt-A:tnbOwner": "   " }; // whitespace-only edit = a cleared cell
    const [unit] = summarizeStagedByUnit(staged, rows);
    expect(unit.cells[0]).toEqual({ cellKey: "apt-A", columnId: "tnbOwner", label: "TNB Owner", value: "" });
  });

  it("returns [] for an empty staged buffer", () => {
    expect(summarizeStagedByUnit({}, rows)).toEqual([]);
  });

  // The staged buffer lives in sessionStorage and is restored verbatim, so it
  // can outlive the units it references (a unit deleted by someone else, a DB
  // reset, a restored crash-recovery snapshot). Such a key must be flagged, not
  // dressed up as a unit whose code happens to look like a UUID.
  it("flags a staged edit whose apartment is absent from rows as unresolved", () => {
    const staged = { "apt-GONE:tnbOwner": "300", "apt-A:cleaningOwner": "10" };
    const out = summarizeStagedByUnit(staged, rows);
    const gone = out.find((u) => u.apartmentId === "apt-GONE");
    expect(gone?.unresolved).toBe(true);
    // The live unit alongside it stays untouched and un-flagged.
    expect(out.find((u) => u.apartmentId === "apt-A")?.unresolved).toBeUndefined();
  });

  // Safety valve: while rows are still loading (or a fetch failed and lastGood
  // is empty) EVERY key looks unresolvable. Flagging them all would tell the
  // user their real unsaved work is stale. Distinguishing is impossible here,
  // so nothing is flagged.
  it("flags nothing when rows is empty — cannot distinguish stale from not-yet-loaded", () => {
    const staged = { "apt-A:cleaningOwner": "10", "apt-GONE:tnbOwner": "300" };
    const out = summarizeStagedByUnit(staged, []);
    expect(out.every((u) => u.unresolved === undefined)).toBe(true);
  });

  it("skips a staged edit whose owning apartmentId is in excludeApartmentIds (mirrors handleSave's billedApartmentIds exclusion)", () => {
    const staged = {
      "apt-A:cleaningOwner": "10",     // unit-grain → A-01, excluded (billed)
      "list-A1:currentKwh": "42",      // sub-row of A-01, also excluded
      "apt-B:wifiOwner": "30",         // unit-grain → B-02, not excluded
    };
    expect(summarizeStagedByUnit(staged, rows, new Set(["apt-A"]))).toEqual([
      {
        unitCode: "B-02",
        apartmentId: "apt-B",
        cellCount: 1,
        cells: [{ cellKey: "apt-B", columnId: "wifiOwner", label: "WiFi Owner", value: "30" }],
      },
    ]);
  });

  it("resolves the real unitCode for a unit present in rows even when it would be filtered from the visible set", () => {
    // A staged-but-filtered-out unit: passing the FULL row set (as handleSave
    // does via lastGood.rows) must resolve "C-03" and never fall back to the
    // raw apartmentId/UUID, even though a caller's filtered/visible row set
    // (e.g. orderedRows) would have dropped this row entirely.
    const rowsIncludingFiltered = [
      ...rows,
      { apartmentId: "apt-C-uuid-1234", unitCode: "C-03", subRows: [] },
    ] as unknown as GridRow[];
    const staged = { "apt-C-uuid-1234:wifiOwner": "15" };
    expect(summarizeStagedByUnit(staged, rowsIncludingFiltered)).toEqual([
      {
        unitCode: "C-03",
        apartmentId: "apt-C-uuid-1234",
        cellCount: 1,
        cells: [{ cellKey: "apt-C-uuid-1234", columnId: "wifiOwner", label: "WiFi Owner", value: "15" }],
      },
    ]);
  });
});
