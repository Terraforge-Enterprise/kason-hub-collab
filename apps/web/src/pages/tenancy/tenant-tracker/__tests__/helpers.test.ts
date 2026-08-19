import { describe, expect, it } from "vitest";
import { formatRM0 } from "@/components/format";
import { displayPhone } from "../phone-display";

// classifySearch + prefs coverage was removed with the Tenant Tracker UI
// (2026-08-06). formatRM0 + displayPhone stay covered — both are still
// imported by live surfaces (grid formatting / parties detail panels).

describe("formatRM0", () => {
  it("whole-ringgit, no decimals", () => {
    expect(formatRM0(1800)).toBe("RM 1,800");
    expect(formatRM0(1234.56)).toBe("RM 1,235");
    expect(formatRM0(null)).toBe("RM 0");
  });
});

describe("displayPhone (spec §4.1)", () => {
  it("formats canonical", () => {
    expect(displayPhone("60133456780")).toBe("+60 13-345 6780");
  });
  it("formats legacy +60 rows identically", () => {
    expect(displayPhone("+60133456780")).toBe("+60 13-345 6780");
  });
  it("renders invalid values verbatim (e.g. 015 with 7-digit subscriber)", () => {
    expect(displayPhone("+60153456789")).toBe("+60153456789");
  });
});
