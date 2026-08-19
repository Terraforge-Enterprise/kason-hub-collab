/**
 * Component tests for the admin reservation-detail "Identity Documents" card
 * + new applicant profile fields (spec R4 / plan Task 10).
 *
 * Mirrors reservation-detail-address.test.tsx's render + mock idiom.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth")>("@/lib/auth");
  return {
    ...actual,
    useAuth: vi.fn(),
    getStoredUser: vi.fn(() => null),
    clearStoredAuth: vi.fn(),
  };
});

const mockGetReservation = vi.fn();
const mockGetReservationDocViewUrl = vi.fn();
vi.mock("@/api/reservations", async () => {
  const actual = await vi.importActual<typeof import("@/api/reservations")>(
    "@/api/reservations",
  );
  return {
    ...actual,
    getReservation: (id: string) => mockGetReservation(id),
    getReservationDocViewUrl: (id: string, docId: string) =>
      mockGetReservationDocViewUrl(id, docId),
    cancelReservation: vi.fn(),
    approveReservation: vi.fn(),
    rejectReservation: vi.fn(),
  };
});

const mockGetReservationEditHistory = vi.fn();
vi.mock("@/api/admin-edit-reservation", () => ({
  adminEditReservation: vi.fn(),
  getReservationEditHistory: (...args: unknown[]) =>
    (mockGetReservationEditHistory as (...a: unknown[]) => unknown)(...args),
}));

import { useAuth } from "@/lib/auth";
import type { ReservationDto } from "@/api/reservations";
import ReservationDetailPage from "../reservation-detail-page";

const mockUseAuth = useAuth as unknown as ReturnType<typeof vi.fn>;

// ── Fixtures ───────────────────────────────────────────────────────────────

function makeReservation(
  overrides: Partial<ReservationDto> = {},
  documents: ReservationDto["documents"] = [],
): ReservationDto {
  return {
    id: "res-1",
    referenceCode: "RES-00001",
    status: "signed",
    issuedAt: "2026-05-01T00:00:00.000Z",
    expiresAt: "2026-05-08T00:00:00.000Z",
    property: { id: "p1", name: "The Sky Residences" },
    unit: { id: "u1", unitCode: "A-101" },
    carPark: "P-12",
    proposedMoveIn: "2026-09-01T00:00:00.000Z",
    proposedMoveOut: null,
    specialRemarks: null,
    charges: {
      reservationDeposit: "500.00",
      documentationFee: "100.00",
      rentalDeposit: "2400.00",
      utilityDeposit: "300.00",
      accessCardDeposit: "50.00",
    },
    agreedMonthlyRent: "2200.00",
    applicant: {
      fullName: "John Tan",
      nric: "900101-01-1234",
      contact: "012-3456789",
      email: "j@x.com",
      addressLine1: null,
      addressLine2: null,
      city: null,
      postcode: null,
      state: null,
      country: null,
      nationality: "Malaysian",
      occupation: "Engineer",
      monthlyIncome: "5000.00",
      emergencyContactName: "Jane Tan",
      emergencyContactPhone: "012-9998888",
      emergencyContactRelation: "Sister",
    },
    documents,
    signedAt: "2026-05-02T00:00:00.000Z",
    signedPdfDownloadUrl: "https://signed.example/x.pdf",
    customTerms: [],
    approvalNote: null,
    ...overrides,
  };
}

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

function wrapWithRoute(qc: QueryClient = makeQueryClient()) {
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/admin/reservations/res-1"]}>
        <Routes>
          <Route path="/admin/reservations/:id" element={<ReservationDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function setAuthRole(role: "admin" | "manager" | "editor") {
  mockUseAuth.mockReturnValue({
    user: {
      id: "u-current",
      fullName: "Current User",
      email: "current@example.com",
      role,
      orgId: "org1",
    },
    setAuth: vi.fn(),
    clearAuth: vi.fn(),
    isAuthenticated: true,
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("ReservationDetailPage — Identity Documents card + profile fields", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setAuthRole("admin");
    mockGetReservationEditHistory.mockResolvedValue({ entries: [] });
  });

  it("shows uploaded slot with a View button for a present document", async () => {
    mockGetReservation.mockResolvedValue(
      makeReservation({}, [
        {
          id: "doc-1",
          kind: "passport_front",
          filename: "passport-front.jpg",
          uploadedAt: "2026-05-01T00:00:00.000Z",
        },
      ]),
    );

    render(wrapWithRoute());

    expect(await screen.findByText("Passport (front)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Uploaded.*View/ })).toBeInTheDocument();

    // New profile KeyValues on the Applicant card.
    expect(screen.getByText("Malaysian")).toBeInTheDocument();
    expect(screen.getByText("Engineer")).toBeInTheDocument();
    expect(screen.getByText("RM 5000.00")).toBeInTheDocument();
    expect(screen.getByText("Jane Tan")).toBeInTheDocument();
    expect(screen.getByText("012-9998888")).toBeInTheDocument();
    expect(screen.getByText("Sister")).toBeInTheDocument();
  });

  it("shows empty slot as Not provided with no View button", async () => {
    mockGetReservation.mockResolvedValue(makeReservation({}, []));

    render(wrapWithRoute());

    expect(await screen.findByText("Passport (front)")).toBeInTheDocument();
    // All four slots are empty.
    expect(screen.getAllByText("Not provided")).toHaveLength(4);
    expect(
      screen.queryByRole("button", { name: /Uploaded.*View/ }),
    ).not.toBeInTheDocument();
  });
});
