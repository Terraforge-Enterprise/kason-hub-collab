/**
 * Fix 2 (final-review, flag-off parity): the legacy (flag-off) "Create
 * tenancy" card's reservation picker used to offer both "signed" and
 * "pending_customer" reservations. createTenancyService now unconditionally
 * rejects a non-signed reservation with 400 RESERVATION_NOT_SIGNED, so a
 * flag-off admin picking a pending_customer reservation would 400 on submit
 * -- a flag-off behavior regression introduced by the reservation-gating
 * work. The legacy card must only ever offer "signed" reservations the
 * server will actually accept.
 */
import { describe, it, expect } from "vitest";
import { assignableReservationsForLegacyCard } from "../tenancies-page";
import type { ReservationDto } from "@/api/reservations";

function makeReservation(overrides: Partial<ReservationDto> & { id: string }): ReservationDto {
  return {
    referenceCode: `RES-${overrides.id}`,
    status: "signed",
    issuedAt: "2026-01-01T00:00:00Z",
    expiresAt: "2030-01-01T00:00:00Z",
    property: { id: "p-1", name: "Sky Residences" },
    unit: { id: "u-1", unitCode: "A-101" },
    carPark: null,
    proposedMoveIn: "2026-02-01",
    proposedMoveOut: null,
    specialRemarks: null,
    charges: {
      reservationDeposit: "500.00",
      documentationFee: "100.00",
      rentalDeposit: "2400.00",
      utilityDeposit: "300.00",
      accessCardDeposit: "50.00",
    },
    agreedMonthlyRent: "2400.00",
    applicant: {
      fullName: null,
      nric: null,
      contact: null,
      email: null,
      addressLine1: null,
      addressLine2: null,
      city: null,
      postcode: null,
      state: null,
      country: null,
      nationality: null,
      occupation: null,
      monthlyIncome: null,
      emergencyContactName: null,
      emergencyContactPhone: null,
      emergencyContactRelation: null,
    },
    documents: [],
    signedAt: null,
    signedPdfDownloadUrl: null,
    customTerms: [],
    approvalNote: null,
    ...overrides,
  };
}

describe("assignableReservationsForLegacyCard", () => {
  it("excludes a pending_customer reservation", () => {
    const pending = makeReservation({ id: "res-pending", status: "pending_customer" });
    const out = assignableReservationsForLegacyCard([pending]);
    expect(out.find((r) => r.id === "res-pending")).toBeUndefined();
  });

  it("still includes a signed reservation with a recorded agreed rent", () => {
    const signed = makeReservation({ id: "res-signed", status: "signed" });
    const out = assignableReservationsForLegacyCard([signed]);
    expect(out.find((r) => r.id === "res-signed")).toBeTruthy();
  });

  it("excludes a signed reservation with no recorded agreed rent", () => {
    const signedNoRent = makeReservation({
      id: "res-no-rent",
      status: "signed",
      agreedMonthlyRent: null,
    });
    const out = assignableReservationsForLegacyCard([signedNoRent]);
    expect(out.find((r) => r.id === "res-no-rent")).toBeUndefined();
  });
});
