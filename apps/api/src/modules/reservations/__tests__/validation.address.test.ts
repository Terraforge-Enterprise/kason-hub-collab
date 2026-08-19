import { describe, it, expect } from "vitest";
import { fillReservationSchema } from "../validation";

const BASE = {
  applicantFullName: "John Tan",
  applicantNric: "900101011234",
  applicantContact: "+60123456789",
  applicantEmail: "john@example.com",
  applicantAddressLine1: "12, Jalan Bukit Bintang",
  applicantCity: "Kuala Lumpur",
  applicantPostcode: "55100",
  applicantState: "Wilayah Persekutuan Kuala Lumpur",
  nationality: "Malaysian",
  emergencyContactName: "Jane Doe",
  emergencyContactPhone: "+60123456789",
};

describe("fillReservationSchema — address fields", () => {
  it("accepts a valid address and defaults country to Malaysia", () => {
    const parsed = fillReservationSchema.parse(BASE);
    expect(parsed.applicantCountry).toBe("Malaysia");
    expect(parsed.applicantAddressLine1).toBe("12, Jalan Bukit Bintang");
  });

  it("treats applicantAddressLine2 as optional", () => {
    const parsed = fillReservationSchema.parse(BASE);
    expect(parsed.applicantAddressLine2).toBeUndefined();
  });

  it("rejects an over-length city (>60)", () => {
    const bad = { ...BASE, applicantCity: "K".repeat(61) };
    expect(() => fillReservationSchema.parse(bad)).toThrow();
  });

  it("rejects a missing required address field", () => {
    const { applicantCity, ...missing } = BASE;
    expect(() => fillReservationSchema.parse(missing)).toThrow();
  });
});
