// P4 Task 10: ⌘K unit-code lookup → unit workspace deep-link.
// Conventions mirror __tests__/search-command.test.tsx (fetch mock + AuthContext).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import React from "react";

const flags = vi.hoisted(() => ({ ownerBilling: true, tenantTracker: false }));
vi.mock("@/lib/feature-flags", () => ({
  isPhase2FlagEnabled: (flag: string) =>
    flag === "ENABLE_PHASE2_OWNER_BILLING"
      ? flags.ownerBilling
      : flag === "ENABLE_PHASE2_TENANT_TRACKER"
        ? flags.tenantTracker
        : false,
}));

import { AuthContext, type User } from "@/lib/auth";
import { SearchCommand } from "../search-command";

const settleDebounce = () =>
  act(() => new Promise<void>((resolve) => setTimeout(resolve, 400)));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function installFetchMock() {
  const mock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/inventory/apartments")) {
      return Promise.resolve(
        jsonResponse({ data: [{ id: "apt-1", unitCode: "A-10-04", propertyName: "Areca Residences" }] }),
      );
    }
    return Promise.resolve(jsonResponse({ error: "unexpected request" }, 404));
  });
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname + location.search}</div>;
}

function renderPalette(role = "manager") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const user: User = { id: "u1", fullName: "Test User", email: "t@example.com", role, orgId: "org-1" };
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={{ user, setAuth: () => {}, clearAuth: () => {}, isAuthenticated: true }}>
        <MemoryRouter initialEntries={["/dashboard"]}>
          <SearchCommand />
          <LocationProbe />
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

async function openPalette() {
  fireEvent.keyDown(document, { key: "k", metaKey: true });
  return await screen.findByPlaceholderText("Search navigation...");
}

describe("SearchCommand — ⌘K unit-code lookup (P4)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    flags.ownerBilling = true;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("shows a Units section for a unit-shaped query and deep-links to the workspace", async () => {
    const fetchMock = installFetchMock();
    renderPalette("manager");
    const input = await openPalette();
    await userEvent.type(input, "A-10");
    await settleDebounce();
    expect(screen.getByText("Units")).toBeInTheDocument();
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/inventory/apartments"))).toBe(true);
    fireEvent.click(await screen.findByRole("button", { name: /A-10-04/ }));
    expect(screen.getByTestId("location")).toHaveTextContent("/tenancy/owner-ledger/unit/apt-1");
  });

  it("does NOT search units for an editor (endpoint is manager-gated in the ledger context)", async () => {
    const fetchMock = installFetchMock();
    renderPalette("editor");
    const input = await openPalette();
    await userEvent.type(input, "A-10");
    await settleDebounce();
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/inventory/apartments"))).toBe(false);
  });

  it("does NOT search units while the owner-billing flag is dark", async () => {
    flags.ownerBilling = false;
    const fetchMock = installFetchMock();
    renderPalette("admin");
    const input = await openPalette();
    await userEvent.type(input, "A-10");
    await settleDebounce();
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/inventory/apartments"))).toBe(false);
  });

  it("a pure-digit (phone-shaped) query does not trigger the unit lookup", async () => {
    const fetchMock = installFetchMock();
    renderPalette("manager");
    const input = await openPalette();
    await userEvent.type(input, "0123456");
    await settleDebounce();
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/inventory/apartments"))).toBe(false);
  });
});
