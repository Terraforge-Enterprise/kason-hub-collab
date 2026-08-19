/**
 * Component tests for the portal (agent) reservation-detail "Identity
 * documents" status line (spec R4 / plan Task 11).
 *
 * PII-minimization: the agent portal must show ONLY kind-presence booleans
 * (Passport ✓ / IC ✓) — never an image, filename-as-link, View button,
 * docId, or a view-url call. Mirrors the admin
 * reservation-detail.documents.test.tsx fixture/mock idiom.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockGetPortalReservation = vi.fn();
vi.mock("@/api/portal-reservations", async () => {
  const actual = await vi.importActual<typeof import("@/api/portal-reservations")>(
    "@/api/portal-reservations",
  );
  return {
    ...actual,
    getPortalReservation: (id: string) => mockGetPortalReservation(id),
    cancelPortalReservation: vi.fn(),
  };
});

import type { ReservationDto } from "@/api/portal-reservations";
import PortalReservationDetailPage from "../reservation-detail";

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
      <MemoryRouter initialEntries={["/portal/reservations/res-1"]}>
        <Routes>
          <Route path="/portal/reservations/:id" element={<PortalReservationDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("PortalReservationDetailPage — Identity documents status line (no images)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows provided, no images", async () => {
    mockGetPortalReservation.mockResolvedValue(
      makeReservation({}, [
        { id: "doc-1", kind: "ic_front", filename: "ic-front.jpg", uploadedAt: "2026-05-01T00:00:00.000Z" },
        { id: "doc-2", kind: "ic_back", filename: "ic-back.jpg", uploadedAt: "2026-05-01T00:00:00.000Z" },
      ]),
    );

    render(wrapWithRoute());

    expect(await screen.findByText(/IC ✓/)).toBeInTheDocument();

    // PII minimization: no View control, no image, no filename link, no docId text.
    expect(screen.queryByText(/View/i)).not.toBeInTheDocument();
    expect(document.querySelector("img")).not.toBeInTheDocument();
    expect(screen.queryByText("ic-front.jpg")).not.toBeInTheDocument();
    expect(screen.queryByText("doc-1")).not.toBeInTheDocument();
  });

  it("none uploaded", async () => {
    mockGetPortalReservation.mockResolvedValue(makeReservation({}, []));

    render(wrapWithRoute());

    expect(await screen.findByText("No identity documents uploaded")).toBeInTheDocument();
    expect(screen.queryByText(/View/i)).not.toBeInTheDocument();
    expect(document.querySelector("img")).not.toBeInTheDocument();
  });
});
