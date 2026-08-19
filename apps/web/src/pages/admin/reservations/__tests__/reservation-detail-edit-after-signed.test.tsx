/**
 * Component tests for the admin Edit-after-Signed flow on the reservation
 * detail page (spec §5.3 / plan Task 8).
 *
 * Covers:
 *  - Edit button visibility rules (admin role + signed status only)
 *  - Edit-history "Edited (N times)" pill renders when history is non-empty
 *  - The EditAfterSignedDialog enforces the ≥10-char reason rule
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

// Mock the reservation detail fetch + the API endpoints the dialog calls.
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

const mockAdminEditReservation = vi.fn();
const mockGetReservationEditHistory = vi.fn();
vi.mock("@/api/admin-edit-reservation", () => ({
  adminEditReservation: (...args: unknown[]) =>
    (mockAdminEditReservation as (...a: unknown[]) => unknown)(...args),
  getReservationEditHistory: (...args: unknown[]) =>
    (mockGetReservationEditHistory as (...a: unknown[]) => unknown)(...args),
}));

import { useAuth } from "@/lib/auth";
import type { ReservationDto, ReservationStatus } from "@/api/reservations";
import ReservationDetailPage from "../reservation-detail-page";
import { EditAfterSignedDialog } from "../edit-after-signed-dialog";

const mockUseAuth = useAuth as unknown as ReturnType<typeof vi.fn>;

// ── Fixtures ───────────────────────────────────────────────────────────────

function makeReservation(overrides: Partial<ReservationDto> = {}): ReservationDto {
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
      fullName: "Tenant Smith",
      nric: "900101-14-2222",
      contact: "+60198765432",
      email: "tenant@example.test",
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

function wrap(ui: React.ReactNode, qc: QueryClient = makeQueryClient()) {
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/admin/reservations/res-1"]}>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
}

// Variant that mounts the page under a real Route so useParams() resolves
// the :id segment from the URL — without this, useParams returns {} and the
// query is disabled.
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

describe("ReservationDetailPage — Edit button visibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetReservationEditHistory.mockResolvedValue({ entries: [] });
  });

  it("shows the Edit button for admin role on signed reservations", async () => {
    setAuthRole("admin");
    mockGetReservation.mockResolvedValue(makeReservation({ status: "signed" }));
    render(wrapWithRoute());
    expect(await screen.findByRole("button", { name: /^edit$/i })).toBeInTheDocument();
  });

  it("shows the Edit button for admin role on pending_customer reservations", async () => {
    // GAP-B1: pre-sign typo fixes are also audited (action=admin_edit_pending_customer).
    // The tenant already has the sign link, so the same trust-impact applies.
    setAuthRole("admin");
    mockGetReservation.mockResolvedValue(makeReservation({ status: "pending_customer" }));
    render(wrapWithRoute());
    expect(await screen.findByRole("button", { name: /^edit$/i })).toBeInTheDocument();
  });

  it("hides the Edit button for non-admin roles even on signed reservations", async () => {
    setAuthRole("manager");
    mockGetReservation.mockResolvedValue(makeReservation({ status: "signed" }));
    render(wrapWithRoute());
    // Wait for the page to load (Property card renders the property name)
    expect(await screen.findByText("The Sky Residences")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^edit$/i })).not.toBeInTheDocument();
  });

  it("hides the Edit button for admin role on statuses outside the editable set", async () => {
    setAuthRole("admin");
    // signed + pending_customer are the editable set (see ADMIN_EDITABLE_STATUSES
    // in apps/api/src/modules/reservations/service.ts). Everything else stays
    // gated.
    const nonEditableStatuses: ReservationStatus[] = [
      "pending_approval",
      "needs_amendment",
      "cancelled",
      "expired",
    ];
    for (const status of nonEditableStatuses) {
      mockGetReservation.mockResolvedValue(makeReservation({ status }));
      const { unmount } = render(wrapWithRoute());
      expect(await screen.findByText("The Sky Residences")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^edit$/i })).not.toBeInTheDocument();
      unmount();
    }
  });
});

describe("ReservationDetailPage — 'Edited (N times)' pill", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setAuthRole("admin");
    mockGetReservation.mockResolvedValue(makeReservation({ status: "signed" }));
  });

  it("does NOT render the pill when history is empty", async () => {
    mockGetReservationEditHistory.mockResolvedValue({ entries: [] });
    render(wrapWithRoute());
    expect(await screen.findByRole("button", { name: /^edit$/i })).toBeInTheDocument();
    expect(screen.queryByText(/edited \(/i)).not.toBeInTheDocument();
  });

  it("renders 'Edited (N times)' with the correct count when history is non-empty", async () => {
    mockGetReservationEditHistory.mockResolvedValue({
      entries: [
        {
          id: "a1",
          createdAt: "2026-05-10T03:00:00.000Z",
          actorName: "Alice Admin",
          reason: "typo correction per email",
        },
        {
          id: "a2",
          createdAt: "2026-05-11T03:00:00.000Z",
          actorName: "Bob Admin",
          reason: "deposit fix per call log",
        },
      ],
    });
    render(wrapWithRoute());
    const pill = await screen.findByText(/edited \(2 times\)/i);
    expect(pill).toBeInTheDocument();
  });

  it("uses singular 'time' when there is exactly one entry", async () => {
    mockGetReservationEditHistory.mockResolvedValue({
      entries: [
        {
          id: "a1",
          createdAt: "2026-05-10T03:00:00.000Z",
          actorName: "Alice Admin",
          reason: "typo correction per email",
        },
      ],
    });
    render(wrapWithRoute());
    expect(await screen.findByText(/edited \(1 time\)/i)).toBeInTheDocument();
  });
});

describe("EditAfterSignedDialog — reason validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects submission when reason is shorter than 10 chars and surfaces inline error", async () => {
    const onSaved = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();

    render(
      wrap(
        <EditAfterSignedDialog
          open={true}
          onClose={onClose}
          reservation={makeReservation()}
          onSaved={onSaved}
        />,
      ),
    );

    // Type 5 chars (too short).
    const reasonField = screen.getByPlaceholderText(/tenant typo correction/i);
    await user.type(reasonField, "short");

    // Click Save changes.
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    // Inline validation message visible.
    expect(
      await screen.findByText(/reason must be at least 10 characters/i),
    ).toBeInTheDocument();
    // The API call must NOT have fired.
    expect(mockAdminEditReservation).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("calls adminEditReservation with the diff'd patch and reason when valid", async () => {
    const onSaved = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();
    mockAdminEditReservation.mockResolvedValue({ id: "res-1" });

    render(
      wrap(
        <EditAfterSignedDialog
          open={true}
          onClose={onClose}
          reservation={makeReservation()}
          onSaved={onSaved}
        />,
      ),
    );

    // Change applicantFullName.
    const nameField = screen.getByDisplayValue("Tenant Smith");
    await user.clear(nameField);
    await user.type(nameField, "Tenant Corrected Name");

    // Valid 10+ char reason.
    const reasonField = screen.getByPlaceholderText(/tenant typo correction/i);
    await user.type(reasonField, "valid ten char reason here");

    await user.click(screen.getByRole("button", { name: /save changes/i }));

    // Wait for the mutation.
    await vi.waitFor(() => {
      expect(mockAdminEditReservation).toHaveBeenCalledTimes(1);
    });
    const args = mockAdminEditReservation.mock.calls[0];
    expect(args[0]).toBe("res-1");
    // Input is force-uppercased on every keystroke so what gets sent to the
    // API matches the convention printed on the reservation PDF (NRIC-style
    // caps, per Kason 22 May 1:05am client request).
    expect(args[1]).toEqual({ applicantFullName: "TENANT CORRECTED NAME" });
    expect(args[2]).toBe("valid ten char reason here");
    expect(onSaved).toHaveBeenCalledTimes(1);
  });
});
