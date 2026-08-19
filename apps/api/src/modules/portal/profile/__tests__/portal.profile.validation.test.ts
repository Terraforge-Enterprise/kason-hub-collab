import { describe, it, expect } from "vitest";
import { updatePortalProfileSchema } from "../portal.profile.validation";

describe("updatePortalProfileSchema", () => {
  it("normalizes phone to canonical", () => {
    const r = updatePortalProfileSchema.parse({ phone: "012-345 6789" });
    expect(r.phone).toBe("60123456789");
  });

  it("accepts empty phone as null", () => {
    const r = updatePortalProfileSchema.parse({ phone: "" });
    expect(r.phone).toBeNull();
  });

  it("rejects invalid phone with canonical message", () => {
    const result = updatePortalProfileSchema.safeParse({ phone: "xyz" });
    expect(result.success).toBe(false);
    if (!result.success) {
      const flat = result.error.flatten();
      const fields = flat.fieldErrors as unknown as Record<string, string[] | undefined>;
      const msg = fields.phone?.[0] ?? flat.formErrors[0];
      expect(msg).toBe("Enter a valid Malaysian mobile number");
    }
  });

  it("rejects empty body (no fields)", () => {
    expect(() => updatePortalProfileSchema.parse({})).toThrow();
  });

  it("accepts a single fullName field", () => {
    expect(() =>
      updatePortalProfileSchema.parse({ fullName: "Test Name" }),
    ).not.toThrow();
  });
});
