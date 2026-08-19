import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

// ── Mocks ─────────────────────────────────────────────────────────────────────

// Mock OwnerDetailPanel to avoid mounting its real deps (useOwnerDetail, etc.)
vi.mock("@/pages/parties/owner-detail-panel", () => ({
  OwnerDetailPanel: ({ partyId }: { partyId: string }) =>
    React.createElement(
      "div",
      { "data-testid": `owner-panel-${partyId}` },
      "Owner Detail Panel",
    ),
}));

vi.mock("@/pages/parties/owners-action-dialogs", () => ({
  EditOwnerDialog: ({ open }: { open: boolean }) =>
    open ? React.createElement("div", null, "Edit Dialog") : null,
  BlacklistOwnerDialog: ({ open }: { open: boolean }) =>
    open ? React.createElement("div", null, "Blacklist Dialog") : null,
  ResolveBlacklistOwnerDialog: ({ open }: { open: boolean }) =>
    open ? React.createElement("div", null, "Resolve Blacklist Dialog") : null,
  DeleteOwnerDialog: ({ open }: { open: boolean }) =>
    open ? React.createElement("div", null, "Delete Dialog") : null,
  CreateOwnerDialog: () => null,
}));

// AssignOwnerToUnitDialog is a SEPARATE module from owners-action-dialogs
// (Task 3), so it needs its own stub. Row-wiring tests only need to confirm
// the row passes `open` + the row's `owner.id` through — not the dialog's
// internal behavior (covered by assign-owner-to-unit-dialog.test.tsx).
vi.mock("@/pages/parties/assign-owner-to-unit-dialog", () => ({
  AssignOwnerToUnitDialog: ({ open, owner }: { open: boolean; owner: { id: string } }) =>
    open ? React.createElement("div", { "data-testid": "assign-owner-dialog" }, owner.id) : null,
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

import { OwnerTable } from "../owners-table";
import type { OwnerListItem } from "../owners-table";

// ── Fixture ───────────────────────────────────────────────────────────────────

const OWNER: OwnerListItem = {
  id: "o-1",
  displayName: "Dato' Razak",
  legalName: null,
  primaryEmail: "razak@example.com",
  primaryPhone: "+60123456789",
  formattedPhone: "+60 12-345 6789",
  nationality: "MY",
  status: "active",
  isBlacklisted: false,
  createdAt: "2026-01-15T10:00:00.000Z",
  bankName: null,
  bankAccountHolder: null,
  bankAccountNumber: null,
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

describe("OwnerTable — expand-in-place row", () => {
  it("chevron button starts with aria-expanded=false", () => {
    render(<OwnerTable owners={[OWNER]} />, { wrapper: makeWrapper() });

    const chevron = screen.getByRole("button", { name: /expand Dato' Razak/i });
    expect(chevron).toHaveAttribute("aria-expanded", "false");
  });

  it("clicking chevron expands the row and mounts OwnerDetailPanel", () => {
    render(<OwnerTable owners={[OWNER]} />, { wrapper: makeWrapper() });

    const chevron = screen.getByRole("button", { name: /expand Dato' Razak/i });
    fireEvent.click(chevron);

    expect(chevron).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("owner-panel-o-1")).toBeInTheDocument();
  });

  it("clicking chevron a second time collapses and unmounts the panel", () => {
    render(<OwnerTable owners={[OWNER]} />, { wrapper: makeWrapper() });

    const chevron = screen.getByRole("button", { name: /expand Dato' Razak/i });
    fireEvent.click(chevron);
    expect(chevron).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(chevron);
    expect(chevron).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("owner-panel-o-1")).not.toBeInTheDocument();
  });

  it("the ⋯ actions menu is still present after expand", () => {
    render(<OwnerTable owners={[OWNER]} />, { wrapper: makeWrapper() });

    // The ⋯ menu trigger should be present regardless of expand state
    expect(
      screen.getByRole("button", { name: /actions for Dato' Razak/i }),
    ).toBeInTheDocument();

    const chevron = screen.getByRole("button", { name: /expand Dato' Razak/i });
    fireEvent.click(chevron);

    // Still present after expansion
    expect(
      screen.getByRole("button", { name: /actions for Dato' Razak/i }),
    ).toBeInTheDocument();
  });

  it("clicking anywhere on the row (not just the chevron) expands the panel", () => {
    render(<OwnerTable owners={[OWNER]} />, { wrapper: makeWrapper() });

    // Click a non-interactive part of the row — the owner's name.
    fireEvent.click(screen.getByText("Dato' Razak"));

    expect(screen.getByTestId("owner-panel-o-1")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /collapse Dato' Razak/i }),
    ).toHaveAttribute("aria-expanded", "true");
  });

  it("clicking the row body a second time collapses the panel", () => {
    render(<OwnerTable owners={[OWNER]} />, { wrapper: makeWrapper() });

    fireEvent.click(screen.getByText("Dato' Razak"));
    expect(screen.getByTestId("owner-panel-o-1")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Dato' Razak"));
    expect(screen.queryByTestId("owner-panel-o-1")).not.toBeInTheDocument();
  });

  it("opening the ⋯ actions menu does not expand the row", () => {
    render(<OwnerTable owners={[OWNER]} />, { wrapper: makeWrapper() });

    // The actions cell stops propagation, so clicking ⋯ must not toggle expand.
    fireEvent.click(screen.getByRole("button", { name: /actions for Dato' Razak/i }));
    expect(screen.queryByTestId("owner-panel-o-1")).not.toBeInTheDocument();
  });
});

describe("OwnerTable — Assign to Unit (R4)", () => {
  it("renders Assign to Unit item and opens AssignOwnerToUnitDialog for the row", () => {
    render(<OwnerTable owners={[OWNER]} />, { wrapper: makeWrapper() });

    fireEvent.click(screen.getByRole("button", { name: /actions for Dato' Razak/i }));
    const item = screen.getByRole("menuitem", { name: /assign to unit/i });
    expect(item).toBeInTheDocument();

    fireEvent.click(item);

    // The dialog is scoped to the row: the stub receives open=true + this
    // row's owner.id (no party picker — that's the real dialog's job,
    // covered by assign-owner-to-unit-dialog.test.tsx).
    expect(screen.getByTestId("assign-owner-dialog")).toHaveTextContent("o-1");
  });

  it("Assign to Unit present regardless of blacklist state", () => {
    render(<OwnerTable owners={[{ ...OWNER, isBlacklisted: true }]} />, {
      wrapper: makeWrapper(),
    });

    fireEvent.click(screen.getByRole("button", { name: /actions for Dato' Razak/i }));

    // Blacklisted rows show "Resolve blacklist" instead of Deactivate/Blacklist,
    // but Assign to Unit is unconditional — it must still appear.
    expect(screen.getByRole("menuitem", { name: /resolve blacklist/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /assign to unit/i })).toBeInTheDocument();
  });
});

describe("OwnerTable — property/unit search + sub-line (R3/R4)", () => {
  const withUnit: OwnerListItem = {
    ...OWNER, id: "o-2", displayName: "Unit Owner",
    units: [{ propertyName: "Vista Court", unitCode: "B-08-08" }],
  };
  const noUnit: OwnerListItem = {
    ...OWNER, id: "o-3", displayName: "Landless Owner", units: [],
  };

  it("renders a property·unit sub-line under the name", () => {
    render(<OwnerTable owners={[withUnit]} />, { wrapper: makeWrapper() });
    expect(screen.getByText("Vista Court · B-08-08")).toBeInTheDocument();
  });

  it('renders "(no unit)" when the owner has no units', () => {
    render(<OwnerTable owners={[noUnit]} />, { wrapper: makeWrapper() });
    expect(screen.getByText("(no unit)")).toBeInTheDocument();
  });

  it("filters rows by property name typed into the search bar", () => {
    render(<OwnerTable owners={[withUnit, noUnit]} />, { wrapper: makeWrapper() });
    fireEvent.change(screen.getByLabelText("Search owners"), { target: { value: "Vista" } });
    expect(screen.getByText("Unit Owner")).toBeInTheDocument();
    expect(screen.queryByText("Landless Owner")).not.toBeInTheDocument();
  });

  it("filters rows by unit code typed into the search bar", () => {
    render(<OwnerTable owners={[withUnit, noUnit]} />, { wrapper: makeWrapper() });
    fireEvent.change(screen.getByLabelText("Search owners"), { target: { value: "B-08-08" } });
    expect(screen.getByText("Unit Owner")).toBeInTheDocument();
    expect(screen.queryByText("Landless Owner")).not.toBeInTheDocument();
  });

  it("shows the updated search placeholder mentioning property and unit", () => {
    render(<OwnerTable owners={[OWNER]} />, { wrapper: makeWrapper() });
    expect(
      screen.getByPlaceholderText("Search name, email, phone, nationality, property, or unit"),
    ).toBeInTheDocument();
  });
});
