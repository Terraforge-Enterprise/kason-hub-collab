import { describe, it, expect } from "vitest";
import { formatDateTimeMY, formatCents } from "../format";

describe("formatDateTimeMY", () => {
  it("renders a UTC instant in Asia/Kuala_Lumpur (+8)", () => {
    // 03:07 UTC → 11:07 in KL.
    const out = formatDateTimeMY("2026-06-30T03:07:00.000Z");
    expect(out).toContain("11:07");
    expect(out).not.toContain("03:07");
  });
  it("returns a dash for nullish", () => {
    expect(formatDateTimeMY(null)).toBe("-");
    expect(formatDateTimeMY(undefined)).toBe("-");
  });
});

describe("formatCents", () => {
  it("formats integer cents as RM with 2 decimals", () => {
    expect(formatCents(155000)).toBe("RM 1,550.00");
  });
  it("formats zero cents", () => {
    expect(formatCents(0)).toBe("RM 0.00");
  });
  it("formats negative cents with locale hyphen-minus", () => {
    expect(formatCents(-500)).toBe("RM -5.00");
  });
  it("falls back to RM 0.00 for non-finite input instead of rendering RM NaN", () => {
    expect(formatCents(NaN)).toBe("RM 0.00");
    expect(formatCents(undefined as unknown as number)).toBe("RM 0.00");
  });
});
