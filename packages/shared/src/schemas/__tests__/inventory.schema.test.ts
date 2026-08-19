import { describe, it, expect } from "vitest";
import { updateUnitSchema } from "../inventory";

const unitId = crypto.randomUUID();
const ownerPartyId = crypto.randomUUID();

describe("updateUnitSchema — ownerPartyId", () => {
  it("accepts ownerPartyId as a valid UUID", () => {
    const r = updateUnitSchema.safeParse({ unitId, ownerPartyId });
    expect(r.success).toBe(true);
  });

  it("accepts ownerPartyId as null (clearing the owner)", () => {
    const r = updateUnitSchema.safeParse({ unitId, ownerPartyId: null });
    expect(r.success).toBe(true);
  });

  it("accepts omitted ownerPartyId (field is optional)", () => {
    const r = updateUnitSchema.safeParse({ unitId });
    expect(r.success).toBe(true);
  });

  it("rejects ownerPartyId as a non-UUID string", () => {
    const r = updateUnitSchema.safeParse({ unitId, ownerPartyId: "not-a-uuid" });
    expect(r.success).toBe(false);
  });
});
