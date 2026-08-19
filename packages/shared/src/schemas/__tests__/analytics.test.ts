import { describe, it, expect } from "vitest";
import { analyticsQuerySchema, unitMiniStatQuerySchema, ANALYTICS_WINDOWS, RECURRING_THRESHOLD } from "../analytics";

// Zod v4's .uuid() enforces RFC-9562 variant bits (4th group starts with 8-b).
// "11111111-1111-1111-1111-111111111111" fails because the 4th group "1111"
// violates the variant constraint. Use a valid RFC-9562 UUID instead.
const VALID_UUID = "00000000-0000-4000-8000-000000000001";

describe("analyticsQuerySchema", () => {
  it("defaults window to 12mo", () => {
    expect(analyticsQuerySchema.parse({})).toEqual({ window: "12mo" });
  });
  it("accepts a valid window + uuid propertyId", () => {
    const r = analyticsQuerySchema.parse({ window: "30d", propertyId: VALID_UUID });
    expect(r.window).toBe("30d");
    expect(r.propertyId).toBe(VALID_UUID);
  });
  it("rejects an unknown window, a non-uuid propertyId, and unknown keys (.strict)", () => {
    expect(() => analyticsQuerySchema.parse({ window: "7d" })).toThrow();
    expect(() => analyticsQuerySchema.parse({ propertyId: "not-a-uuid" })).toThrow();
    expect(() => analyticsQuerySchema.parse({ window: "30d", bogus: 1 })).toThrow();
  });
});

describe("unitMiniStatQuerySchema", () => {
  it("defaults window to 12mo and rejects extra keys", () => {
    expect(unitMiniStatQuerySchema.parse({})).toEqual({ window: "12mo" });
    expect(() => unitMiniStatQuerySchema.parse({ propertyId: "x" })).toThrow();
  });
});

describe("constants", () => {
  it("exposes the 4 windows and a recurrence threshold of 3", () => {
    expect(ANALYTICS_WINDOWS).toEqual(["30d", "90d", "12mo", "all"]);
    expect(RECURRING_THRESHOLD).toBe(3);
  });
});
