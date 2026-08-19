import { describe, it, expect } from "vitest";
import { fillReservationSchema, uploadUrlSchema } from "../validation";

const baseFill = {
  applicantFullName: "ALICE TAN",
  applicantNric: "900101-14-5678",
  applicantContact: "+60123456789",
  applicantEmail: "alice@example.com",
  applicantAddressLine1: "12 Jalan Satu",
  applicantCity: "Kuala Lumpur",
  applicantPostcode: "55100",
  applicantState: "Selangor",
  applicantCountry: "Malaysia",
};

describe("fillReservationSchema new fields", () => {
  it("accepts new fields", () => {
    const r = fillReservationSchema.safeParse({
      ...baseFill,
      nationality: "Malaysian",
      emergencyContactName: "Bob Tan",
      emergencyContactPhone: "+60129999999",
      occupation: "Engineer",
      monthlyIncome: "5000.50",
    });
    expect(r.success).toBe(true);
  });
  it("rejects missing nationality", () => {
    const r = fillReservationSchema.safeParse({
      ...baseFill,
      emergencyContactName: "Bob Tan",
      emergencyContactPhone: "+60129999999",
    });
    expect(r.success).toBe(false);
  });
});

describe("uploadUrlSchema", () => {
  it("rejects bad mime", () => {
    const r = uploadUrlSchema.safeParse({
      kind: "ic_front",
      contentType: "video/mp4",
      filename: "x.mp4",
    });
    expect(r.success).toBe(false);
  });
});
