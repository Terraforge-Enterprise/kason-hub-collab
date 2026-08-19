import { describe, it, expect } from "vitest";
import { formatDateMY } from "../format";

describe("formatDateMY", () => {
  it("pretty MY date: ISO → '1 Jul 2026'", () => {
    expect(formatDateMY("2026-07-01")).toBe("1 Jul 2026");
    expect(formatDateMY("2026-07-01T09:30:00.000Z")).toBe("1 Jul 2026");
  });
  it("null date → '-'", () => {
    expect(formatDateMY(null)).toBe("-");
    expect(formatDateMY(undefined)).toBe("-");
  });
  it("invalid date → '-'", () => {
    expect(formatDateMY("not-a-date")).toBe("-");
  });
});
