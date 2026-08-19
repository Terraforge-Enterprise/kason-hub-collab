/**
 * Unit tests for buildReservationBodyHtml — profile fields + documents-provided
 * acknowledgment line (Task 12). Pure function, no DB required.
 *
 * Run:
 *   cd apps/api && npx vitest run src/modules/reservations/__tests__/render-body.profile.test.ts
 */
import { describe, it, expect } from "vitest";
import { buildReservationBodyHtml, type BodyInput } from "../render-body";

function makeInput(overrides: Partial<BodyInput> = {}): BodyInput {
  return {
    applicant: {
      fullName: "Jane Doe",
      nric: "901010-14-5678",
      contact: "012-3456789",
      email: "jane@example.com",
      addressLine1: "12, Jalan Bukit Bintang",
      addressLine2: "Taman Desa",
      city: "Kuala Lumpur",
      postcode: "55100",
      state: "Wilayah Persekutuan Kuala Lumpur",
      country: "Malaysia",
      ...overrides.applicant,
    },
    property: {
      name: "Test Property",
      unitCode: "A-01-02",
      carPark: null,
    },
    schedule: {
      moveIn: new Date("2026-06-01"),
      moveOut: null,
      remarks: null,
    },
    section1: {
      reservationDeposit: "500",
      documentationFee: "200",
    },
    section2: {
      rentalDeposit: "1500",
      utilityDeposit: "300",
      accessCardDeposit: "50",
    },
    ...overrides,
  };
}

describe("buildReservationBodyHtml — profile fields + documents-provided line", () => {
  it("renders profile + docs line, no image", () => {
    const html = buildReservationBodyHtml(
      makeInput({
        applicant: {
          fullName: "Jane Doe",
          nric: "901010-14-5678",
          contact: "012-3456789",
          email: "jane@example.com",
          addressLine1: "12, Jalan Bukit Bintang",
          addressLine2: "Taman Desa",
          city: "Kuala Lumpur",
          postcode: "55100",
          state: "Wilayah Persekutuan Kuala Lumpur",
          country: "Malaysia",
          nationality: "Malaysian",
          occupation: "Engineer",
          monthlyIncome: "5000",
          emergencyContactName: "John Doe",
          emergencyContactPhone: "019-1234567",
          emergencyContactRelation: "Spouse",
        },
        documentsProvided: { passport: false, ic: true },
      }),
    );

    expect(html).toContain("Nationality");
    expect(html).toContain("Malaysian");
    expect(html).toContain("Occupation");
    expect(html).toContain("Engineer");
    expect(html).toContain("Monthly Income");
    expect(html).toContain("Emergency Contact");
    expect(html).toContain("John Doe");
    expect(html).toContain("Identity documents provided");
    expect(html).toContain("IC ✓");
    expect(html).not.toContain("<img");
  });

  it("renders when profile absent", () => {
    expect(() => buildReservationBodyHtml(makeInput())).not.toThrow();

    const html = buildReservationBodyHtml(makeInput());
    expect(html).toContain("Nationality");
    expect(html).toContain("Identity documents provided");
    expect(html).not.toContain("<img");
  });
});
