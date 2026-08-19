import { describe, it, expect } from "vitest";
import { createCarparkSchema, assignCarparkSchema } from "../carpark";

// Note: Zod v4 enforces RFC 4122 version/variant bits on .uuid(); use a valid v4 UUID fixture.
const TEST_UUID = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";

describe("carpark schemas", () => {
  it("accepts a valid bay registration", () => {
    const r = createCarparkSchema.safeParse({
      apartmentId: TEST_UUID,
      label: "P-12",
      monthlyRate: "120.00",
    });
    expect(r.success).toBe(true);
  });
  it("rejects an empty label", () => {
    const r = createCarparkSchema.safeParse({
      apartmentId: TEST_UUID,
      label: "",
      monthlyRate: "120.00",
    });
    expect(r.success).toBe(false);
  });
  it("requires at least one carpark in an assignment batch", () => {
    const r = assignCarparkSchema.safeParse({ tenancyId: TEST_UUID, carparks: [] });
    expect(r.success).toBe(false);
  });
});
