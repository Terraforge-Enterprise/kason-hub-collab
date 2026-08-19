import { describe, it, expect } from "vitest";
import { isActiveAdjustmentNote, ACTIVE_ADJUSTMENT_NOTE_STATUSES } from "../note-lifecycle";

describe("isActiveAdjustmentNote (canonical adjustment-lifecycle predicate)", () => {
  it("ISSUED is active", () => {
    expect(isActiveAdjustmentNote("ISSUED")).toBe(true);
  });

  it("DRAFT / CANCELLED / SUPERSEDED / VOIDED / unknown are inactive", () => {
    for (const s of ["DRAFT", "CANCELLED", "SUPERSEDED", "VOIDED", "issued", "offset", ""]) {
      expect(isActiveAdjustmentNote(s)).toBe(false);
    }
  });

  it("allowlist is exactly [ISSUED]", () => {
    expect([...ACTIVE_ADJUSTMENT_NOTE_STATUSES]).toEqual(["ISSUED"]);
  });
});
