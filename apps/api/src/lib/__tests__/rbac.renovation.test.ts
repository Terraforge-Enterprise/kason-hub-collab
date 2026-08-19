import { describe, it, expect } from "vitest";
import { canSeeCommission, renovationClaimSelectFor } from "../rbac";

/**
 * Pins the role-aware select shape for RenovationClaim. Service tests mock
 * the repository, so the field stripping in `renovationClaimSelectFor`
 * itself is otherwise never directly exercised — a refactor that drops
 * `packagePrice` from the manager shape (or leaks `splits` into the editor
 * shape) would silently regress without these tests.
 */
describe("renovationClaimSelectFor", () => {
  const SENSITIVE_KEYS = [
    "packagePrice",
    "monthlyOffsetAmount",
    "splits",
    "documents",
  ] as const;

  it("editor: strips commission fields", () => {
    const shape = renovationClaimSelectFor("editor") as Record<string, unknown>;
    for (const key of SENSITIVE_KEYS) {
      expect(shape).not.toHaveProperty(key);
    }
    // Sanity: editor still gets metadata.
    expect(shape).toHaveProperty("id");
    expect(shape).toHaveProperty("status");
    expect(shape).toHaveProperty("submittedById");
  });

  it("manager: includes all commission fields", () => {
    const shape = renovationClaimSelectFor("manager") as Record<string, unknown>;
    for (const key of SENSITIVE_KEYS) {
      expect(shape).toHaveProperty(key);
    }
  });

  it("admin: matches manager shape (canSeeCommission is true)", () => {
    expect(canSeeCommission("admin")).toBe(true);
    const shape = renovationClaimSelectFor("admin") as Record<string, unknown>;
    for (const key of SENSITIVE_KEYS) {
      expect(shape).toHaveProperty(key);
    }
  });
});
