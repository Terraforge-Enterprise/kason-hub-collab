import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

// ── Hoist mocks before module imports ─────────────────────────────────────────

const mockMutate = vi.hoisted(() => vi.fn());
const mockUseTenantDetail = vi.hoisted(() => vi.fn());
const mockEditTenantDialog = vi.hoisted(() => vi.fn());
const mockDisplayPhone = vi.hoisted(() => vi.fn((raw: string) => `formatted:${raw}`));

vi.mock("@/api/parties-detail", () => ({
  useTenantDetail: mockUseTenantDetail,
  useRevealPartyIc: () => ({
    mutate: mockMutate,
    isPending: false,
  }),
}));

// Minimal EditTenantDialog mock — hoisted so individual tests can override
// the implementation (e.g. to expose a close button for invalidation tests).
vi.mock("@/pages/parties/tenants-action-dialogs", () => ({
  EditTenantDialog: mockEditTenantDialog,
  BlacklistTenantDialog: vi.fn(() => null),
  CreateTenantDialog: vi.fn(() => null),
}));

vi.mock("@/pages/tenancy/tenant-tracker/phone-display", () => ({
  displayPhone: mockDisplayPhone,
}));

vi.mock("../portal-access-section", () => ({
  PortalAccessSection: () => React.createElement("div", null, "portal-access-section"),
}));

vi.mock("@/lib/auth", () => ({
  getStoredUser: vi.fn(() => ({ id: "u1", fullName: "Test", role: "admin" })),
  clearStoredAuth: vi.fn(),
  getAdminToken: vi.fn(() => null),
  getPortalToken: vi.fn(() => null),
}));

// ── Imports (after mock declarations) ────────────────────────────────────────

import { TenantDetailPanel } from "../tenant-detail-panel";
import type { TenantDetail } from "@/api/parties-detail";

// ── Fixture ───────────────────────────────────────────────────────────────────

const FIXTURE: TenantDetail = {
  id: "tenant-1",
  displayName: "Ali Hassan",
  legalName: "Ali bin Hassan",
  primaryEmail: "ali@example.com",
  primaryPhone: "+60123456789",
  formattedPhone: "+60 12-345 6789",
  whatsappPhone: "+60123456789",
  idType: "ic",
  idNumberMasked: "••••5678",
  nationality: "MY",
  gender: "male",
  dateOfBirth: "1990-01-01",
  occupation: "Software Engineer",
  employerName: "Tech Corp Sdn Bhd",
  employerAddress: "123 Jalan Tech, KL",
  monthlyIncome: "5000.00",
  emergencyContactName: "Siti Hassan",
  emergencyContactPhone: "+60198765432",
  emergencyContactRelation: "Mother",
  isBlacklisted: false,
  blacklistReason: null,
  status: "active",
  createdAt: "2026-01-15T10:00:00.000Z",
  hasActiveTenancy: false,
  portalUser: null,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: qc }, children);
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("TenantDetailPanel", () => {
  beforeEach(() => {
    mockMutate.mockReset();
    mockDisplayPhone.mockImplementation((raw: string) => `formatted:${raw}`);
    mockEditTenantDialog.mockImplementation(({ open }: { open: boolean }) =>
      open ? React.createElement("div", null, "Edit Tenant Dialog") : null,
    );
  });

  it("renders a loading skeleton while query is pending", () => {
    mockUseTenantDetail.mockReturnValue({
      isLoading: true,
      isError: false,
      data: undefined,
      error: null,
    });

    render(<TenantDetailPanel partyId="tenant-1" />, { wrapper: makeWrapper() });

    expect(screen.getByLabelText("Loading details")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /edit tenant/i })).not.toBeInTheDocument();
  });

  it("renders Occupation from the TenantDetail fixture", () => {
    mockUseTenantDetail.mockReturnValue({
      isLoading: false,
      isError: false,
      data: FIXTURE,
      error: null,
    });

    render(<TenantDetailPanel partyId="tenant-1" />, { wrapper: makeWrapper() });

    expect(screen.getByText("Software Engineer")).toBeInTheDocument();
  });

  it("renders Monthly income formatted with RM prefix", () => {
    mockUseTenantDetail.mockReturnValue({
      isLoading: false,
      isError: false,
      data: FIXTURE,
      error: null,
    });

    render(<TenantDetailPanel partyId="tenant-1" />, { wrapper: makeWrapper() });

    // formatRM(5000) → "RM 5,000.00" (or "RM 5000.00" in minimal-ICU envs)
    expect(screen.getByText(/RM\s[\d,]+\.00/)).toBeInTheDocument();
  });

  it("renders Gender", () => {
    mockUseTenantDetail.mockReturnValue({
      isLoading: false,
      isError: false,
      data: FIXTURE,
      error: null,
    });

    render(<TenantDetailPanel partyId="tenant-1" />, { wrapper: makeWrapper() });

    expect(screen.getByText("male")).toBeInTheDocument();
  });

  it("renders Emergency contact name and relation", () => {
    mockUseTenantDetail.mockReturnValue({
      isLoading: false,
      isError: false,
      data: FIXTURE,
      error: null,
    });

    render(<TenantDetailPanel partyId="tenant-1" />, { wrapper: makeWrapper() });

    expect(screen.getByText("Siti Hassan")).toBeInTheDocument();
    expect(screen.getByText("Mother")).toBeInTheDocument();
  });

  it("renders the masked IC via IcRevealField (Reveal button visible)", () => {
    mockUseTenantDetail.mockReturnValue({
      isLoading: false,
      isError: false,
      data: FIXTURE,
      error: null,
    });

    render(<TenantDetailPanel partyId="tenant-1" />, { wrapper: makeWrapper() });

    expect(screen.getByText("••••5678")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reveal/i })).toBeInTheDocument();
  });

  it("clicking Edit Tenant button opens EditTenantDialog", async () => {
    mockUseTenantDetail.mockReturnValue({
      isLoading: false,
      isError: false,
      data: FIXTURE,
      error: null,
    });

    render(<TenantDetailPanel partyId="tenant-1" />, { wrapper: makeWrapper() });

    // Dialog is not open initially
    expect(screen.queryByText("Edit Tenant Dialog")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Edit Tenant" }));

    await waitFor(() => {
      expect(screen.getByText("Edit Tenant Dialog")).toBeInTheDocument();
    });
  });

  it("renders an error alert when query fails", () => {
    mockUseTenantDetail.mockReturnValue({
      isLoading: false,
      isError: true,
      data: undefined,
      error: new Error("Not found"),
    });

    render(<TenantDetailPanel partyId="tenant-1" />, { wrapper: makeWrapper() });

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("Not found")).toBeInTheDocument();
  });

  it("renders — for null fields", () => {
    const sparse: TenantDetail = {
      ...FIXTURE,
      occupation: null,
      employerName: null,
      emergencyContactName: null,
      emergencyContactPhone: null,
      emergencyContactRelation: null,
      monthlyIncome: null,
    };

    mockUseTenantDetail.mockReturnValue({
      isLoading: false,
      isError: false,
      data: sparse,
      error: null,
    });

    render(<TenantDetailPanel partyId="tenant-1" />, { wrapper: makeWrapper() });

    // There should be at least one "—" placeholder for null fields
    const dashes = screen.getAllByText("—");
    expect(dashes.length).toBeGreaterThan(0);
  });

  it("formats whatsappPhone with displayPhone helper (not raw)", () => {
    mockUseTenantDetail.mockReturnValue({
      isLoading: false,
      isError: false,
      data: FIXTURE,
      error: null,
    });

    render(<TenantDetailPanel partyId="tenant-1" />, { wrapper: makeWrapper() });

    // displayPhone is mocked to return "formatted:<raw>"; FIXTURE.whatsappPhone = "+60123456789"
    expect(screen.getByText("formatted:+60123456789")).toBeInTheDocument();
  });

  it("renders the Portal Access section", async () => {
    mockUseTenantDetail.mockReturnValue({
      isLoading: false,
      isError: false,
      data: FIXTURE,
      error: null,
    });

    render(<TenantDetailPanel partyId="tenant-1" />, { wrapper: makeWrapper() });

    expect(await screen.findByText("portal-access-section")).toBeInTheDocument();
  });

  it("closing the Edit dialog invalidates the tenant detail query", async () => {
    // Override the dialog mock to expose a close button that triggers onOpenChange(false)
    mockEditTenantDialog.mockImplementation(
      ({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) =>
        open
          ? React.createElement(
              "div",
              null,
              "Edit Tenant Dialog",
              React.createElement("button", { onClick: () => onOpenChange(false) }, "Close dialog"),
            )
          : null,
    );

    mockUseTenantDetail.mockReturnValue({
      isLoading: false,
      isError: false,
      data: FIXTURE,
      error: null,
    });

    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 }, mutations: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");
    const Wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client: qc }, children);

    render(<TenantDetailPanel partyId="tenant-1" />, { wrapper: Wrapper });

    // Open the dialog
    fireEvent.click(screen.getByRole("button", { name: "Edit Tenant" }));
    await waitFor(() => expect(screen.getByText("Edit Tenant Dialog")).toBeInTheDocument());

    // Close the dialog via the mock's close button
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ["parties", "tenants", "tenant-1"] }),
      );
    });
  });
});
