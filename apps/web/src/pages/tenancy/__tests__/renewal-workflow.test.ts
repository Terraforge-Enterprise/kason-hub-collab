import { describe, expect, it } from "vitest";
import { daysUntilTenancyEnd } from "../renewal-workflow-dialog";

describe("renewal workflow timing", () => {
  it("enters the operation reminder exactly 60 days before tenancy end", () => {
    expect(daysUntilTenancyEnd("2026-10-21", new Date(2026, 7, 22, 16, 30))).toBe(60);
  });

  it("reports overdue tenancy ends as negative days", () => {
    expect(daysUntilTenancyEnd("2026-08-20", new Date(2026, 7, 22))).toBe(-2);
  });
});
