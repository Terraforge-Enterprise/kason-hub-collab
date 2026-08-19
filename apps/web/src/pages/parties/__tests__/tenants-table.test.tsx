import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

// ── Mocks ─────────────────────────────────────────────────────────────────────

// Mock TenantDetailPanel to avoid mounting its real deps (useTenantDetail, etc.)
vi.mock("@/pages/parties/tenant-detail-panel", () => ({
  TenantDetailPanel: ({ partyId }: { partyId: string }) =>
    React.createElement(
      "div",
      { "data-testid": `tenant-panel-${partyId}` },
      "Tenant Detail Panel",
    ),
}));

vi.mock("@/pages/parties/tenants-action-dialogs", () => ({
  EditTenantDialog: ({ open }: { open: boolean }) =>
    open ? React.createElement("div", null, "Edit Dialog") : null,
  BlacklistTenantDialog: ({ open }: { open: boolean }) =>
    open ? React.createElement("div", null, "Blacklist Dialog") : null,
  ResolveBlacklistTenantDialog: ({ open }: { open: boolean }) =>
    open ? React.createElement("div", null, "Resolve Blacklist Dialog") : null,
  DeleteTenantDialog: ({ open }: { open: boolean }) =>
    open ? React.createElement("div", null, "Delete Dialog") : null,
  CreateTenantDialog: () => null,
}));

// AssignTenantToUnitDialog is a SEPARATE module from tenants-action-dialogs
// (Task 1), so it needs its own stub. Row-wiring tests only need to confirm
// the row passes `open` + the row's `tenant.id` through — not the dialog's
// internal behavior (covered by assign-tenant-to-unit-dialog.test.tsx).
vi.mock("@/pages/parties/assign-tenant-to-unit-dialog", () => ({
  AssignTenantToUnitDialog: ({ open, tenant }: { open: boolean; tenant: { id: string } }) =>
    open ? React.createElement("div", { "data-testid": "assign-tenant-dialog" }, tenant.id) : null,
}));

vi.mock("@/lib/auth", () => ({
  getStoredUser: vi.fn(() => ({ id: "u1", fullName: "Test", role: "admin" })),
  clearStoredAuth: vi.fn(),
  getAdminToken: vi.fn(() => null),
  getPortalToken: vi.fn(() => null),
}));

// Sonner — toast calls in mutation handlers
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  }),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { TenantTable } from "../tenants-table";
import type { TenantListItem } from "../tenants-table";

// ── Fixture ───────────────────────────────────────────────────────────────────

const TENANT: TenantListItem = {
  id: "t-1",
  displayName: "Lim Wei Ming",
  legalName: null,
  primaryEmail: "lim@example.com",
  primaryPhone: "+60123456789",
  formattedPhone: "+60 12-345 6789",
  occupation: "Software Engineer",
  status: "active",
  isBlacklisted: false,
  createdAt: "2026-01-15T10:00:00.000Z",
  nationality: null,
  employerName: null,
  monthlyIncome: null,
  idType: null,
  idNumber: null,
  blacklistReason: null,
  deletable: false,
};

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

describe("TenantTable — expand-in-place row", () => {
  it("chevron button starts with aria-expanded=false", () => {
    render(<TenantTable tenants={[TENANT]} />, { wrapper: makeWrapper() });

    const chevron = screen.getByRole("button", { name: /expand Lim Wei Ming/i });
    expect(chevron).toHaveAttribute("aria-expanded", "false");
  });

  it("clicking chevron expands the row and mounts TenantDetailPanel", () => {
    render(<TenantTable tenants={[TENANT]} />, { wrapper: makeWrapper() });

    const chevron = screen.getByRole("button", { name: /expand Lim Wei Ming/i });
    fireEvent.click(chevron);

    expect(chevron).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("tenant-panel-t-1")).toBeInTheDocument();
  });

  it("clicking chevron a second time collapses and unmounts the panel", () => {
    render(<TenantTable tenants={[TENANT]} />, { wrapper: makeWrapper() });

    const chevron = screen.getByRole("button", { name: /expand Lim Wei Ming/i });
    fireEvent.click(chevron);
    expect(chevron).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(chevron);
    expect(chevron).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("tenant-panel-t-1")).not.toBeInTheDocument();
  });

  it("the ⋯ actions menu is still present after expand", () => {
    render(<TenantTable tenants={[TENANT]} />, { wrapper: makeWrapper() });

    // The ⋯ menu trigger should be present regardless of expand state
    expect(
      screen.getByRole("button", { name: /actions for Lim Wei Ming/i }),
    ).toBeInTheDocument();

    const chevron = screen.getByRole("button", { name: /expand Lim Wei Ming/i });
    fireEvent.click(chevron);

    // Still present after expansion
    expect(
      screen.getByRole("button", { name: /actions for Lim Wei Ming/i }),
    ).toBeInTheDocument();
  });

  it("clicking anywhere on the row (not just the chevron) expands the panel", () => {
    render(<TenantTable tenants={[TENANT]} />, { wrapper: makeWrapper() });

    // Click a non-interactive part of the row — the tenant's name.
    fireEvent.click(screen.getByText("Lim Wei Ming"));

    expect(screen.getByTestId("tenant-panel-t-1")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /collapse Lim Wei Ming/i }),
    ).toHaveAttribute("aria-expanded", "true");
  });

  it("clicking the row body a second time collapses the panel", () => {
    render(<TenantTable tenants={[TENANT]} />, { wrapper: makeWrapper() });

    fireEvent.click(screen.getByText("Lim Wei Ming"));
    expect(screen.getByTestId("tenant-panel-t-1")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Lim Wei Ming"));
    expect(screen.queryByTestId("tenant-panel-t-1")).not.toBeInTheDocument();
  });

  it("opening the ⋯ actions menu does not expand the row", () => {
    render(<TenantTable tenants={[TENANT]} />, { wrapper: makeWrapper() });

    // The actions cell stops propagation, so clicking ⋯ must not toggle expand.
    fireEvent.click(screen.getByRole("button", { name: /actions for Lim Wei Ming/i }));
    expect(screen.queryByTestId("tenant-panel-t-1")).not.toBeInTheDocument();
  });
});

describe("TenantTable — hasReservation tag (T11/R3)", () => {
  it('renders a "Has reservation" tag when hasReservation is true', () => {
    render(<TenantTable tenants={[{ ...TENANT, hasReservation: true }]} />, {
      wrapper: makeWrapper(),
    });
    expect(screen.getByText("Has reservation")).toBeInTheDocument();
  });

  it('does not render the "Has reservation" tag when hasReservation is false', () => {
    render(<TenantTable tenants={[{ ...TENANT, hasReservation: false }]} />, {
      wrapper: makeWrapper(),
    });
    expect(screen.queryByText("Has reservation")).not.toBeInTheDocument();
  });

  it('does not render the "Has reservation" tag when hasReservation is absent (undefined)', () => {
    render(<TenantTable tenants={[TENANT]} />, { wrapper: makeWrapper() });
    expect(screen.queryByText("Has reservation")).not.toBeInTheDocument();
  });
});

describe("TenantTable — Assign to Unit (R1)", () => {
  it("renders Assign to Unit item and opens AssignTenantToUnitDialog for the row", () => {
    render(<TenantTable tenants={[TENANT]} />, { wrapper: makeWrapper() });

    fireEvent.click(screen.getByRole("button", { name: /actions for Lim Wei Ming/i }));
    const item = screen.getByRole("menuitem", { name: /assign to unit/i });
    expect(item).toBeInTheDocument();

    fireEvent.click(item);

    // The dialog is scoped to the row: the stub receives open=true + this
    // row's tenant.id (no party picker — that's the real dialog's job,
    // covered by assign-tenant-to-unit-dialog.test.tsx).
    expect(screen.getByTestId("assign-tenant-dialog")).toHaveTextContent("t-1");
  });

  it("Assign to Unit present regardless of blacklist state", () => {
    render(<TenantTable tenants={[{ ...TENANT, isBlacklisted: true }]} />, {
      wrapper: makeWrapper(),
    });

    fireEvent.click(screen.getByRole("button", { name: /actions for Lim Wei Ming/i }));

    // Blacklisted rows show "Resolve blacklist" instead of Deactivate/Blacklist,
    // but Assign to Unit is unconditional — it must still appear.
    expect(screen.getByRole("menuitem", { name: /resolve blacklist/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /assign to unit/i })).toBeInTheDocument();
  });
});

describe("TenantTable — property/unit search + sub-line (R3/R4)", () => {
  const withUnit: TenantListItem = {
    ...TENANT, id: "t-2", displayName: "Unit Tenant",
    units: [{ propertyName: "Tower B", unitCode: "B-08-08" }],
  };
  const noUnit: TenantListItem = {
    ...TENANT, id: "t-3", displayName: "Homeless Tenant", units: [],
  };

  it("renders a property·unit sub-line under the name", () => {
    render(<TenantTable tenants={[withUnit]} />, { wrapper: makeWrapper() });
    expect(screen.getByText("Tower B · B-08-08")).toBeInTheDocument();
  });

  it('renders "(no unit)" when the tenant has no units', () => {
    render(<TenantTable tenants={[noUnit]} />, { wrapper: makeWrapper() });
    expect(screen.getByText("(no unit)")).toBeInTheDocument();
  });

  it("joins multiple units with a comma in the sub-line", () => {
    const twoUnits: TenantListItem = {
      ...TENANT, id: "t-4", displayName: "Two Unit Tenant",
      units: [
        { propertyName: "Tower A", unitCode: "A-01-01" },
        { propertyName: "Tower B", unitCode: "B-08-08" },
      ],
    };
    render(<TenantTable tenants={[twoUnits]} />, { wrapper: makeWrapper() });
    expect(screen.getByText("Tower A · A-01-01, Tower B · B-08-08")).toBeInTheDocument();
  });

  it("filters rows by property name typed into the search bar", () => {
    render(<TenantTable tenants={[withUnit, noUnit]} />, { wrapper: makeWrapper() });
    fireEvent.change(screen.getByLabelText("Search tenants"), { target: { value: "Tower B" } });
    expect(screen.getByText("Unit Tenant")).toBeInTheDocument();
    expect(screen.queryByText("Homeless Tenant")).not.toBeInTheDocument();
  });

  it("filters rows by unit code typed into the search bar", () => {
    render(<TenantTable tenants={[withUnit, noUnit]} />, { wrapper: makeWrapper() });
    fireEvent.change(screen.getByLabelText("Search tenants"), { target: { value: "B-08-08" } });
    expect(screen.getByText("Unit Tenant")).toBeInTheDocument();
    expect(screen.queryByText("Homeless Tenant")).not.toBeInTheDocument();
  });

  it("shows the updated search placeholder mentioning property and unit", () => {
    render(<TenantTable tenants={[TENANT]} />, { wrapper: makeWrapper() });
    expect(
      screen.getByPlaceholderText("Search name, email, phone, occupation, property, or unit"),
    ).toBeInTheDocument();
  });
});
