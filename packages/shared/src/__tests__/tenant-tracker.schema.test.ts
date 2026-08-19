// occupiedOnly MUST parse query-string literals correctly. z.coerce.boolean()
// is Boolean(input) — "false" would coerce to true and permanently enable
// hide-vacant (spec §3.3 blocker). These literal cases pin the fix.
import { describe, expect, it } from "vitest";
import { tenantTrackerListQuerySchema } from "../schemas/tenant-tracker";

describe("tenantTrackerListQuerySchema.occupiedOnly", () => {
  it('parses "true" / "1" as true', () => {
    expect(tenantTrackerListQuerySchema.parse({ occupiedOnly: "true" }).occupiedOnly).toBe(true);
    expect(tenantTrackerListQuerySchema.parse({ occupiedOnly: "1" }).occupiedOnly).toBe(true);
  });

  it('parses "false" / "0" as false — NOT Boolean("false")', () => {
    expect(tenantTrackerListQuerySchema.parse({ occupiedOnly: "false" }).occupiedOnly).toBe(false);
    expect(tenantTrackerListQuerySchema.parse({ occupiedOnly: "0" }).occupiedOnly).toBe(false);
  });

  it("absent → undefined (off)", () => {
    expect(tenantTrackerListQuerySchema.parse({}).occupiedOnly).toBeUndefined();
  });

  it("rejects garbage", () => {
    expect(tenantTrackerListQuerySchema.safeParse({ occupiedOnly: "yes" }).success).toBe(false);
  });
});
