import { describe, it, expect } from "vitest";
import {
  createOwnerSchema,
  createTenantSchema,
  createAgentSchema,
  updateTenantSchema,
} from "../schemas/parties";

describe("parties primaryPhone normalization (createOwnerSchema)", () => {
  it("normalizes primaryPhone on parse", () => {
    const result = createOwnerSchema.parse({
      displayName: "Owner X",
      primaryPhone: "012-345 6789",
    });
    expect(result.primaryPhone).toBe("60123456789");
  });

  it("rejects invalid primaryPhone with canonical message", () => {
    const result = createOwnerSchema.safeParse({
      displayName: "Owner X",
      primaryPhone: "xyz",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const flat = result.error.flatten();
      const fields = flat.fieldErrors as unknown as Record<string, string[] | undefined>;
      const msg = fields.primaryPhone?.[0] ?? flat.formErrors[0];
      expect(msg).toBe("Enter a valid Malaysian mobile number");
    }
  });

  it("accepts empty string as null", () => {
    const result = createOwnerSchema.parse({
      displayName: "Owner X",
      primaryPhone: "",
    });
    expect(result.primaryPhone).toBeNull();
  });

  it("accepts undefined as null", () => {
    const result = createOwnerSchema.parse({
      displayName: "Owner X",
    });
    expect(result.primaryPhone).toBeNull();
  });
});

describe("parties primaryPhone normalization (createTenantSchema)", () => {
  it("normalizes primaryPhone on parse", () => {
    const result = createTenantSchema.parse({
      displayName: "Tenant Y",
      primaryPhone: "+60123456789",
    });
    expect(result.primaryPhone).toBe("60123456789");
  });

  it("rejects invalid primaryPhone with canonical message", () => {
    const result = createTenantSchema.safeParse({
      displayName: "Tenant Y",
      primaryPhone: "xyz",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const flat = result.error.flatten();
      const fields = flat.fieldErrors as unknown as Record<string, string[] | undefined>;
      const msg = fields.primaryPhone?.[0] ?? flat.formErrors[0];
      expect(msg).toBe("Enter a valid Malaysian mobile number");
    }
  });
});

describe("parties primaryPhone normalization (createAgentSchema)", () => {
  it("normalizes primaryPhone on parse", () => {
    const result = createAgentSchema.parse({
      displayName: "Agent Z",
      primaryPhone: "012 345 6789",
    });
    expect(result.primaryPhone).toBe("60123456789");
  });

  it("rejects invalid primaryPhone with canonical message", () => {
    const result = createAgentSchema.safeParse({
      displayName: "Agent Z",
      primaryPhone: "xyz",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const flat = result.error.flatten();
      const fields = flat.fieldErrors as unknown as Record<string, string[] | undefined>;
      const msg = fields.primaryPhone?.[0] ?? flat.formErrors[0];
      expect(msg).toBe("Enter a valid Malaysian mobile number");
    }
  });
});

describe("updateTenantSchema — monthlyIncome allows empty string (clear-to-null)", () => {
  it("accepts empty string so a cleared income field is sent to the backend for nulling", () => {
    // Zod v4 UUID validator requires version nibble [1-8]; use a valid v4 UUID.
    const result = updateTenantSchema.safeParse({
      partyId: "00000000-0000-4000-8000-000000000001",
      monthlyIncome: "",
    });
    expect(result.success).toBe(true);
  });
});
