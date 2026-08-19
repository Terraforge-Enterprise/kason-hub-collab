import { describe, it, expect } from "vitest";
import { redactForLog, planRowChange } from "./normalize-phones.mts";

describe("normalize-phones helpers", () => {
  it("redactForLog masks all but last 4 digits", () => {
    expect(redactForLog("60123456789")).toMatch(/\*+6789/);
    expect(redactForLog("+60123456789")).toMatch(/\*+6789/);
  });

  it("redactForLog handles empty input", () => {
    expect(redactForLog("")).toBe("");
  });

  it("planRowChange returns null when already canonical", () => {
    expect(planRowChange("60123456789")).toBeNull();
  });

  it("planRowChange returns canonical for legacy +60", () => {
    expect(planRowChange("+60123456789")).toEqual({
      from: "+60123456789",
      to: "60123456789",
    });
  });

  it("planRowChange returns canonical for separator-bearing legacy values", () => {
    expect(planRowChange("+60 12-345 6789")).toEqual({
      from: "+60 12-345 6789",
      to: "60123456789",
    });
  });

  it("planRowChange returns null for unparseable input", () => {
    expect(planRowChange("garbage")).toBeNull();
  });

  it("planRowChange returns null for null/undefined", () => {
    expect(planRowChange(null)).toBeNull();
  });
});
