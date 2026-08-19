import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

// ── Hoist mocks before any module imports ────────────────────────────────────

const mockMutate = vi.hoisted(() => vi.fn());

vi.mock("@/api/parties-detail", () => ({
  useRevealPartyIc: () => ({
    mutate: mockMutate,
    isPending: false,
  }),
}));

vi.mock("@/lib/auth", () => ({
  getStoredUser: vi.fn(() => ({ id: "u1", fullName: "Test", role: "admin" })),
  clearStoredAuth: vi.fn(),
  getAdminToken: vi.fn(() => null),
  getPortalToken: vi.fn(() => null),
}));

// ── Imports (after mock declarations) ───────────────────────────────────────

import { PartyDetailPanel, IcRevealField } from "../party-detail-panel";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
}

function makeWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(
      QueryClientProvider,
      { client: queryClient },
      children,
    );
  };
}

// ── IcRevealField tests ───────────────────────────────────────────────────────

describe("IcRevealField", () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = makeQueryClient();
    mockMutate.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the masked value initially", () => {
    render(
      <IcRevealField partyId="party-1" masked="••••1234" />,
      { wrapper: makeWrapper(qc) },
    );

    expect(screen.getByText("••••1234")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reveal/i })).toBeInTheDocument();
  });

  it("shows the full IC number after clicking Reveal", async () => {
    mockMutate.mockImplementation(
      (_input: unknown, opts?: { onSuccess?: (d: { idNumber: string; partyId: string }) => void }) => {
        opts?.onSuccess?.({ idNumber: "990101011234", partyId: "party-1" });
      },
    );

    render(
      <IcRevealField partyId="party-1" masked="••••1234" />,
      { wrapper: makeWrapper(qc) },
    );

    fireEvent.click(screen.getByRole("button", { name: /reveal/i }));

    await waitFor(() => {
      expect(screen.getByText("990101011234")).toBeInTheDocument();
    });
    // Masked value replaced by full IC
    expect(screen.queryByText("••••1234")).not.toBeInTheDocument();
    // Reveal button gone once revealed
    expect(screen.queryByRole("button", { name: /reveal/i })).not.toBeInTheDocument();
  });

  it("calls mutate with the correct partyId", () => {
    render(
      <IcRevealField partyId="party-abc" masked="••••5678" />,
      { wrapper: makeWrapper(qc) },
    );

    fireEvent.click(screen.getByRole("button", { name: /reveal/i }));

    expect(mockMutate).toHaveBeenCalledWith(
      { partyId: "party-abc" },
      expect.any(Object),
    );
  });

  it("shows an inline error when reveal fails", async () => {
    mockMutate.mockImplementation(
      (_input: unknown, opts?: { onError?: (err: Error) => void }) => {
        opts?.onError?.(new Error("403 Forbidden"));
      },
    );

    render(
      <IcRevealField partyId="party-1" masked="••••1234" />,
      { wrapper: makeWrapper(qc) },
    );

    fireEvent.click(screen.getByRole("button", { name: /reveal/i }));

    await waitFor(() => {
      expect(
        screen.getByText("Could not reveal IC. Please try again."),
      ).toBeInTheDocument();
    });
    // Reveal button should still be visible (not replaced by the full IC)
    expect(screen.getByRole("button", { name: /reveal/i })).toBeInTheDocument();
  });

  it("hides the Reveal button when masked is null", () => {
    render(
      <IcRevealField partyId="party-1" masked={null} />,
      { wrapper: makeWrapper(qc) },
    );

    expect(screen.queryByRole("button", { name: /reveal/i })).not.toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("clears the error when a second reveal is attempted", async () => {
    let callCount = 0;
    mockMutate.mockImplementation(
      (
        _input: unknown,
        opts?: {
          onError?: (err: Error) => void;
          onSuccess?: (d: { idNumber: string; partyId: string }) => void;
        },
      ) => {
        callCount += 1;
        if (callCount === 1) {
          opts?.onError?.(new Error("network error"));
        } else {
          opts?.onSuccess?.({ idNumber: "990101011234", partyId: "party-1" });
        }
      },
    );

    render(
      <IcRevealField partyId="party-1" masked="••••1234" />,
      { wrapper: makeWrapper(qc) },
    );

    // First click → error
    fireEvent.click(screen.getByRole("button", { name: /reveal/i }));
    await waitFor(() => {
      expect(
        screen.getByText("Could not reveal IC. Please try again."),
      ).toBeInTheDocument();
    });

    // Second click → success, error clears
    fireEvent.click(screen.getByRole("button", { name: /reveal/i }));
    await waitFor(() => {
      expect(screen.getByText("990101011234")).toBeInTheDocument();
    });
    expect(
      screen.queryByText("Could not reveal IC. Please try again."),
    ).not.toBeInTheDocument();
  });
});

// ── PartyDetailPanel tests ────────────────────────────────────────────────────

describe("PartyDetailPanel", () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = makeQueryClient();
  });

  it("shows a loading skeleton when loading=true", () => {
    render(
      <PartyDetailPanel loading error={null} onEdit={vi.fn()} />,
      { wrapper: makeWrapper(qc) },
    );

    // Skeleton should be visible — no children, no Edit button
    expect(screen.queryByRole("button", { name: /edit/i })).not.toBeInTheDocument();
    // The skeleton aria-label should be present
    expect(screen.getByLabelText("Loading details")).toBeInTheDocument();
  });

  it("shows an inline error when error is set", () => {
    render(
      <PartyDetailPanel loading={false} error="Not found" onEdit={vi.fn()} />,
      { wrapper: makeWrapper(qc) },
    );

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("Not found")).toBeInTheDocument();
  });

  it("renders children and an Edit button when neither loading nor error", () => {
    const handleEdit = vi.fn();

    render(
      <PartyDetailPanel loading={false} error={null} onEdit={handleEdit} editLabel="Edit Tenant">
        <div>Name: Lim Wei Ming</div>
        <div>Email: wei@example.com</div>
      </PartyDetailPanel>,
      { wrapper: makeWrapper(qc) },
    );

    expect(screen.getByText("Name: Lim Wei Ming")).toBeInTheDocument();
    expect(screen.getByText("Email: wei@example.com")).toBeInTheDocument();

    const editBtn = screen.getByRole("button", { name: "Edit Tenant" });
    expect(editBtn).toBeInTheDocument();
    fireEvent.click(editBtn);
    expect(handleEdit).toHaveBeenCalledTimes(1);
  });

  it("uses 'Edit' as the default editLabel", () => {
    render(
      <PartyDetailPanel loading={false} error={null} onEdit={vi.fn()}>
        <div>child content</div>
      </PartyDetailPanel>,
      { wrapper: makeWrapper(qc) },
    );

    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
  });
});
