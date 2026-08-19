import { describe, it, expect } from "vitest";
import { phoneSchema, optionalPhoneSchema } from "../schemas/phone";

describe("phoneSchema", () => {
  it("normalizes valid input to canonical", () => {
    expect(phoneSchema.parse("012-345 6789")).toBe("60123456789");
    expect(phoneSchema.parse("+60123456789")).toBe("60123456789");
    expect(phoneSchema.parse("60102323513")).toBe("60102323513");
  });

  it("rejects invalid input with the canonical error message", () => {
    const result = phoneSchema.safeParse("xyz");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe(
        "Enter a valid Malaysian mobile number",
      );
    }
  });

  it("rejects landlines", () => {
    expect(phoneSchema.safeParse("0312345678").success).toBe(false);
  });

  it("does not leak the raw input via flatten()", () => {
    const result = phoneSchema.safeParse("not-a-phone-9999");
    expect(result.success).toBe(false);
    if (!result.success) {
      const flat = JSON.stringify(result.error.flatten());
      expect(flat).not.toContain("9999");
      expect(flat).not.toContain("not-a-phone");
    }
  });
});

describe("optionalPhoneSchema", () => {
  it("returns null for empty string, null, undefined", () => {
    expect(optionalPhoneSchema.parse("")).toBeNull();
    expect(optionalPhoneSchema.parse(null)).toBeNull();
    expect(optionalPhoneSchema.parse(undefined)).toBeNull();
  });

  it("normalizes valid input", () => {
    expect(optionalPhoneSchema.parse("012-345 6789")).toBe("60123456789");
  });

  it("rejects invalid non-empty input", () => {
    expect(optionalPhoneSchema.safeParse("xyz").success).toBe(false);
  });

  it("preserves the canonical error message for non-empty invalid input", () => {
    const result = optionalPhoneSchema.safeParse("xyz");
    expect(result.success).toBe(false);
    if (!result.success) {
      const flat = result.error.flatten();
      // The custom issue from `phoneSchema` lands at the root path → formErrors.
      // Fall back to any field-level error in case a future schema change
      // reshapes the path. Cast through `unknown` because the inferred
      // `fieldErrors` shape (keyed off `string | null`) confuses `Object.values`.
      const fieldMsgs = Object.values(
        flat.fieldErrors as unknown as Record<string, string[] | undefined>,
      );
      const msg = flat.formErrors[0] ?? fieldMsgs[0]?.[0];
      expect(msg).toBe("Enter a valid Malaysian mobile number");
    }
  });
});
