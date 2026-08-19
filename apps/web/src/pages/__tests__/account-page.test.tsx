import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import React from "react";

vi.mock("@/lib/auth", () => ({
  useAuth: vi.fn(() => ({ user: { id: "u1", role: "manager", fullName: "Me", email: "me@x.com" } })),
  getStoredUser: vi.fn(() => null),
  clearStoredAuth: vi.fn(),
  getAdminToken: vi.fn(() => null),
  getPortalToken: vi.fn(() => null),
}));

import AccountPage from "../account-page";

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={qc}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  };
}

function makeResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("AccountPage", () => {
  const originalFetch = globalThis.fetch;
  let qc: QueryClient;
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    globalThis.fetch = vi.fn();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("renders the operator's profile from GET /profile/me", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeResponse({ data: { id: "u1", email: "me@x.com", fullName: "Me", role: "manager", photoKey: null, photoUrl: null, mustChangePassword: false, lastLoginAt: null } }),
    );
    render(<AccountPage />, { wrapper: makeWrapper(qc) });
    await waitFor(() => {
      expect(screen.getByDisplayValue("Me")).toBeInTheDocument();
      expect(screen.getByText("me@x.com")).toBeInTheDocument();
    });
  });

  it("save dispatches PATCH /profile/me with new fullName", async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce(makeResponse({ data: { id: "u1", email: "me@x.com", fullName: "Me", role: "manager", photoKey: null, photoUrl: null, mustChangePassword: false, lastLoginAt: null } }))
      .mockResolvedValueOnce(makeResponse({ data: { id: "u1", email: "me@x.com", fullName: "Updated", role: "manager", photoKey: null, photoUrl: null, mustChangePassword: false, lastLoginAt: null } }));

    render(<AccountPage />, { wrapper: makeWrapper(qc) });
    await waitFor(() => screen.getByDisplayValue("Me"));

    const nameInput = screen.getByDisplayValue("Me");
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, "Updated");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(
        (c) => (c[1] as RequestInit)?.method === "PATCH",
      );
      expect(patchCall).toBeDefined();
      expect(JSON.parse((patchCall![1] as RequestInit).body as string)).toEqual({ fullName: "Updated" });
    });
  });

  it("renders a 'Change password' link to /change-password", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeResponse({ data: { id: "u1", email: "me@x.com", fullName: "Me", role: "manager", photoKey: null, photoUrl: null, mustChangePassword: false, lastLoginAt: null } }),
    );
    render(<AccountPage />, { wrapper: makeWrapper(qc) });
    const link = await screen.findByRole("link", { name: /change password/i });
    expect(link).toHaveAttribute("href", "/change-password");
  });
});
