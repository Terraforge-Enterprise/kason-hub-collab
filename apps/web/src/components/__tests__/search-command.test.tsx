// ⌘K palette — nav-title search. (The M1 tenant phone-search-to-act section
// was removed with the Tenant Tracker UI 2026-08-06; unit-code search is
// covered in search-command-units.test.tsx.)
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import React from "react";

// All phase-2 flags OFF — the palette is nav-only in this spec (unit search
// has its own spec with ENABLE_PHASE2_OWNER_BILLING stubbed ON).
vi.mock("@/lib/feature-flags", () => ({
  isPhase2FlagEnabled: () => false,
}));

import { AuthContext, type User } from "@/lib/auth";
import { SearchCommand } from "../search-command";

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Waits out the 250ms unit-lookup debounce window. act-wrapped so a debounce
 * timer's setState (which legitimately fires during the wait) doesn't warn.
 */
const settleDebounce = () =>
  act(() => new Promise<void>((resolve) => setTimeout(resolve, 400)));

/** Echoes the router location so selection navigation is assertable. */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname + location.search}</div>;
}

function renderPalette(role = "admin") {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  const user: User = {
    id: "u1",
    fullName: "Test User",
    email: "test@example.com",
    role,
    orgId: "org-1",
  };
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider
        value={{ user, setAuth: () => {}, clearAuth: () => {}, isAuthenticated: true }}
      >
        <MemoryRouter initialEntries={["/dashboard"]}>
          <SearchCommand />
          <LocationProbe />
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

/** Opens the palette via the global ⌘K handler and returns its input. */
async function openPalette() {
  fireEvent.keyDown(document, { key: "k", metaKey: true });
  return await screen.findByPlaceholderText("Search navigation...");
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("SearchCommand — ⌘K nav search", () => {
  const originalFetch = globalThis.fetch;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ error: "unexpected request" }), { status: 404 })),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("a nav-title query renders matching nav items and navigates on click", async () => {
    const user = userEvent.setup();
    renderPalette("admin");

    await user.type(await openPalette(), "Inventory");
    const navButton = screen.getByRole("button", { name: "Inventory" });
    expect(navButton).toBeInTheDocument();
    // Non-matching items are filtered out exactly as before.
    expect(screen.queryByRole("button", { name: "Overview" })).not.toBeInTheDocument();

    await user.click(navButton);
    expect(screen.getByTestId("location").textContent).toBe("/inventory");
    expect(screen.queryByPlaceholderText("Search navigation...")).not.toBeInTheDocument();
  });

  it("a phone-shaped (all-digit) query stays nav-only: no network, no entity sections", async () => {
    const user = userEvent.setup();
    renderPalette("admin");

    await user.type(await openPalette(), "0123456789");
    await settleDebounce();

    // The removed tenant phone search must not resurface as a fetch, and the
    // flag-off unit lookup must not fire either.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.queryByText("Tenants")).not.toBeInTheDocument();
    expect(screen.queryByText("Units")).not.toBeInTheDocument();
    // Digits match no nav title → plain nav empty-state.
    expect(screen.getByText("No results found.")).toBeInTheDocument();
  });
});
