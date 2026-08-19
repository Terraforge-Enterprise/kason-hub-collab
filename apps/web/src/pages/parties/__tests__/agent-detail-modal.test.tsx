import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

vi.mock("@/lib/auth", () => ({
  getStoredUser: vi.fn(() => ({ id: "u1", fullName: "Test", role: "admin" })),
  clearStoredAuth: vi.fn(),
  getAdminToken: vi.fn(() => null),
  getPortalToken: vi.fn(() => null),
}));

vi.mock("sonner", () => {
  const success = vi.fn();
  const error = vi.fn();
  const toastBase = vi.fn();
  (toastBase as { success?: typeof success }).success = success;
  (toastBase as { error?: typeof error }).error = error;
  return { toast: toastBase };
});

import { AgentDetailModal } from "../agent-detail-modal";

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
      BrowserRouter,
      null,
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        children,
      ),
    );
  };
}

function makeResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const treeNode = {
  id: "agent-42",
  displayName: "Lim Wei Ming",
  agentLevel: "leader",
  status: "active",
  directDownlineCount: 3,
};

describe("AgentDetailModal — hierarchy detail panel", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("fetches full agent detail and renders email + phone when a node is selected", async () => {
    const fullDetail = {
      id: treeNode.id,
      displayName: treeNode.displayName,
      legalName: "Lim Wei Ming Sdn. Bhd.",
      primaryEmail: "wei.ming@kason.com.my",
      primaryPhone: "60129876543",
      // Server-pre-formatted display variant — modal must prefer this over
      // the canonical primaryPhone (display preference path).
      formattedPhone: "+60 12-987 6543",
      idType: null,
      idNumber: null,
      nationality: "MY",
      agentLevel: "leader",
      bank: { name: "Maybank", accountHolder: "Lim Wei Ming", accountNumber: "12345" },
      status: "active",
      isBlacklisted: false,
      blacklistReason: null,
      portalUser: null,
      uplineId: null,
      upline: null,
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-20T00:00:00.000Z",
    };
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      makeResponse({ data: fullDetail }, 200),
    );

    render(
      <AgentDetailModal open onClose={() => {}} agent={treeNode as never} />,
      { wrapper: makeWrapper(makeQueryClient()) },
    );

    // Email + phone arrive after the fetch resolves.
    await waitFor(() => {
      expect(screen.getByText(fullDetail.primaryEmail)).toBeInTheDocument();
    });
    // Renders the formatted variant, not the raw canonical primaryPhone.
    expect(screen.getByText(fullDetail.formattedPhone)).toBeInTheDocument();
    expect(screen.queryByText(fullDetail.primaryPhone)).not.toBeInTheDocument();
    // Bank name is also surfaced (proves we render `detail.bank.name`).
    expect(screen.getByText("Maybank")).toBeInTheDocument();

    // Verify the network call was the per-id detail endpoint.
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const detailCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes(`/parties/agents/${treeNode.id}`),
    );
    expect(detailCall).toBeTruthy();
  });

  it("does not fire a request when modal is closed", async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(makeResponse({ data: null }, 200));
    render(
      <AgentDetailModal open={false} onClose={() => {}} agent={treeNode as never} />,
      { wrapper: makeWrapper(makeQueryClient()) },
    );
    // No detail fetch should have occurred.
    expect(
      fetchMock.mock.calls.find((c) => String(c[0]).includes(`/parties/agents/${treeNode.id}`)),
    ).toBeUndefined();
  });
});
