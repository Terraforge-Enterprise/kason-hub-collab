import { describe, it, expect } from "vitest";
import { canSeeCommission, salesClaimSelectFor } from "../rbac";

/**
 * Pins the role-aware select shape for SalesClaim. Service tests mock the
 * repository, so the field stripping in `salesClaimSelectFor` itself is
 * otherwise never directly exercised — a refactor that drops
 * `commissionValue` from the manager shape (or leaks `splits` into the
 * editor shape) would silently regress without these tests.
 */
describe("salesClaimSelectFor", () => {
  const SENSITIVE_KEYS = ["commissionValue", "computedAmount", "splits"] as const;

  it("editor: strips commission fields", () => {
    const shape = salesClaimSelectFor("editor") as Record<string, unknown>;
    for (const key of SENSITIVE_KEYS) {
      expect(shape).not.toHaveProperty(key);
    }
    // Sanity: editor still gets metadata.
    expect(shape).toHaveProperty("id");
    expect(shape).toHaveProperty("status");
    expect(shape).toHaveProperty("submittedById");
    expect(shape).toHaveProperty("commissionType");
    expect(shape).toHaveProperty("paymentType");
  });

  it("manager: includes all commission fields", () => {
    const shape = salesClaimSelectFor("manager") as Record<string, unknown>;
    for (const key of SENSITIVE_KEYS) {
      expect(shape).toHaveProperty(key);
    }
  });

  it("admin: matches manager shape (canSeeCommission is true)", () => {
    expect(canSeeCommission("admin")).toBe(true);
    const shape = salesClaimSelectFor("admin") as Record<string, unknown>;
    for (const key of SENSITIVE_KEYS) {
      expect(shape).toHaveProperty(key);
    }
  });
});
