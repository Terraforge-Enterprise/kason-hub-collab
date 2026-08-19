import { describe, it, expect } from "vitest";
import { canDelete, canApprove, canSeeCommission, atLeast } from "../rbac";

describe("rbac", () => {
  it("canDelete: only admin", () => {
    expect(canDelete("admin")).toBe(true);
    expect(canDelete("manager")).toBe(false);
    expect(canDelete("editor")).toBe(false);
  });

  it("canApprove: manager+", () => {
    expect(canApprove("admin")).toBe(true);
    expect(canApprove("manager")).toBe(true);
    expect(canApprove("editor")).toBe(false);
  });

  it("canSeeCommission: manager+", () => {
    expect(canSeeCommission("admin")).toBe(true);
    expect(canSeeCommission("manager")).toBe(true);
    expect(canSeeCommission("editor")).toBe(false);
  });

  it("atLeast returns true when role rank >= target", () => {
    expect(atLeast("admin", "manager")).toBe(true);
    expect(atLeast("manager", "admin")).toBe(false);
    expect(atLeast("editor", "editor")).toBe(true);
  });
});
