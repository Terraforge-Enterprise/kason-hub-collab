import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import React from "react";

// Mock the data + auth so the page renders deterministically.
vi.mock("@/api/reservations", () => ({ listReservations: vi.fn() }));
vi.mock("@/lib/auth", () => ({ useAuth: vi.fn() }));
vi.mock("./edit-after-signed-dialog", () => ({ EditAfterSignedDialog: () => null }));

import { listReservations } from "@/api/reservations";
import { useAuth } from "@/lib/auth";
import ReservationsListPage from "../reservations-list-page";

const listMock = vi.mocked(listReservations);
const authMock = vi.mocked(useAuth);

// A reservation whose status is NOT in the modelled ReservationStatus workflow
// (the clean owner-billing seed marks converted reservations "completed"). Before
// the defensive fallback this crashed the whole list at STATUS_BADGE[status].variant.
function makeCompletedReservation() {
  return {
    id: "r-1",
    referenceCode: "RES-001",
    status: "completed",
    issuedAt: "2026-06-01T00:00:00.000Z",
    expiresAt: "2026-07-01T00:00:00.000Z",
    property: { id: "p-1", name: "Vista Residence" },
    unit: { id: "u-1", unitCode: "A-10-04" },
    carPark: null,
    proposedMoveIn: "2026-06-15T00:00:00.000Z",
    proposedMoveOut: null,
    specialRemarks: null,
    charges: {
      reservationDeposit: "0",
      documentationFee: "0",
      rentalDeposit: "0",
      utilityDeposit: "0",
      accessCardDeposit: "0",
    },
    agreedMonthlyRent: null,
    applicant: { fullName: "Jane Tenant", nric: null, contact: null, email: null },
    signedAt: null,
    signedPdfDownloadUrl: null,
    customTerms: [],
    approvalNote: null,
  };
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ReservationsListPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockReturnValue({
    user: { id: "u", fullName: "Admin", email: "a@x.com", role: "admin", orgId: "o" },
    isAuthenticated: true,
    setAuth: vi.fn(),
    clearAuth: vi.fn(),
  } as never);
});

describe("ReservationsListPage — resilient to unmapped status", () => {
  it("renders a reservation with an unmodelled status ('completed') without crashing", async () => {
    listMock.mockResolvedValue([makeCompletedReservation()] as never);
    renderPage();

    // Row renders (reference code) and the status shows as a neutral badge —
    // instead of throwing on STATUS_BADGE[status].variant for the unmapped status.
    expect(await screen.findByText("RES-001")).toBeInTheDocument();
    expect(screen.getByText("completed")).toBeInTheDocument();
  });
});
