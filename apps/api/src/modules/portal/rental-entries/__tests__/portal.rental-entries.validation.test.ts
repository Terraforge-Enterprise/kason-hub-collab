import { describe, it, expect } from "vitest";
import { createRentalEntrySchema } from "../portal.rental-entries.validation";

const baseValid = {
  propertyId: "11111111-1111-4111-8111-111111111111",
  unitCode: "A-12-01",
  unitType: "apartment",
  // depositMonths + utilitiesDepositMonths are now required on every rental entry.
  depositMonths: 2,
  utilitiesDepositMonths: 0.5,
};

describe("createRentalEntrySchema", () => {
  it("accepts a minimum valid payload", () => {
    expect(createRentalEntrySchema.safeParse(baseValid).success).toBe(true);
  });

  it("accepts a full payload with optional fields", () => {
    expect(createRentalEntrySchema.safeParse({
      ...baseValid,
      bedrooms: 3,
      bathrooms: 2,
      floorArea: 950,
      furnishingLevel: "fully_furnished",
      baseRentAmount: 2500,
      depositMonths: 2,
      amenities: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
      publishedTitle: "Cozy 3-bed in KLCC",
      photoKeys: ["uploads/1.jpg", "uploads/2.jpg"],
    }).success).toBe(true);
  });

  it("rejects empty unitCode", () => {
    expect(createRentalEntrySchema.safeParse({ ...baseValid, unitCode: "" }).success).toBe(false);
  });

  it("rejects unknown top-level keys (strict)", () => {
    expect(createRentalEntrySchema.safeParse({ ...baseValid, weird: 1 }).success).toBe(false);
  });

  it("accepts decimal bathrooms (e.g. 1.5)", () => {
    expect(createRentalEntrySchema.safeParse({ ...baseValid, bathrooms: 1.5 }).success).toBe(true);
  });

  it("rejects too many photoKeys", () => {
    const tooMany = Array(35).fill("uploads/x.jpg");
    expect(createRentalEntrySchema.safeParse({ ...baseValid, photoKeys: tooMany }).success).toBe(false);
  });

  it("rejects non-UUID strings in amenities (Phase 1 lockdown)", () => {
    const result = createRentalEntrySchema.safeParse({
      ...baseValid,
      amenities: ["Pool", "Gym"],
    });
    expect(result.success).toBe(false);
  });

  it("accepts UUIDs in amenities", () => {
    const result = createRentalEntrySchema.safeParse({
      ...baseValid,
      amenities: ["11111111-1111-4111-8111-aaaaaaaaaaaa"],
    });
    expect(result.success).toBe(true);
  });

  it("defaults to [] when amenities omitted", () => {
    const result = createRentalEntrySchema.safeParse(baseValid);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.amenities).toEqual([]);
  });

  it("rejects payload missing depositMonths", () => {
    const { depositMonths: _drop, ...rest } = baseValid;
    expect(createRentalEntrySchema.safeParse(rest).success).toBe(false);
  });

  it("rejects payload missing utilitiesDepositMonths", () => {
    const { utilitiesDepositMonths: _drop, ...rest } = baseValid;
    expect(createRentalEntrySchema.safeParse(rest).success).toBe(false);
  });
});
