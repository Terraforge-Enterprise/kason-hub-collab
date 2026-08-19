/**
 * Component tests for the read-only tenant address rows on the admin
 * reservation detail page's Applicant card (spec R4 / plan Task 8).
 *
 * The admin and portal Applicant cards are byte-identical (same JSX body),
 * so this test file exercises the admin page only; Task 8 applies the same
 * six rows to the portal page.
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
vi.mock("@/api/reservations", async () => {
  const actual = await vi.importActual<typeof import("@/api/reservations")>(
    "@/api/reservations",
  );
  return {
    ...actual,
    getReservation: (id: string) => mockGetReservation(id),
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
  applicantOverrides: Partial<ReservationDto["applicant"]> = {},
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
      nationality: null,
      occupation: null,
      monthlyIncome: null,
      emergencyContactName: null,
      emergencyContactPhone: null,
      emergencyContactRelation: null,
      ...applicantOverrides,
    },
    documents: [],
    signedAt: "2026-05-02T00:00:00.000Z",
    signedPdfDownloadUrl: "https://signed.example/x.pdf",
    customTerms: [],
    approvalNote: null,
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

describe("ReservationDetailPage — Applicant address rows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setAuthRole("admin");
    mockGetReservationEditHistory.mockResolvedValue({ entries: [] });
  });

  it("renders the tenant address when present", async () => {
    mockGetReservation.mockResolvedValue(
      makeReservation({
        addressLine1: "12, Jalan Bukit Bintang",
        addressLine2: null,
        city: "Kuala Lumpur",
        postcode: "55100",
        state: "Selangor",
        country: "Malaysia",
      }),
    );

    render(wrapWithRoute());

    expect(await screen.findByText("12, Jalan Bukit Bintang")).toBeInTheDocument();
    expect(screen.getByText("Kuala Lumpur")).toBeInTheDocument();
    expect(screen.getByText("55100")).toBeInTheDocument();
    expect(screen.getByText("Selangor")).toBeInTheDocument();
    expect(screen.getByText("Malaysia")).toBeInTheDocument();
  });

  it("is null-safe for legacy reservations with no address on file", async () => {
    mockGetReservation.mockResolvedValue(makeReservation());

    render(wrapWithRoute());

    // Full name renders (card body reached the non-empty branch).
    expect(await screen.findByText("John Tan")).toBeInTheDocument();
    // Address rows all fall back to the em dash placeholder; must not throw.
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(6);
  });
});
