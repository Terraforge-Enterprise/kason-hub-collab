/**
 * Component tests for the tabbed My Uploads shell.
 * Spec: docs/superpowers/specs/2026-05-21-agent-property-amendment-design.md §4.2
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

vi.mock("@/api/portal-inventory", () => ({
  listOwnPortalUnits: vi.fn(async () => []),
  listOwnPortalProperties: vi.fn(async () => []),
}));

import MyUploadsPage from "../my-uploads-page";

function renderAt(url: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let lastLocation = url;
  function LocationProbe() {
    const loc = useLocation();
    lastLocation = `${loc.pathname}${loc.search}`;
    return null;
  }
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route
            path="/portal/my-uploads"
            element={
              <>
                <LocationProbe />
                <MyUploadsPage />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...utils, getLocation: () => lastLocation };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PortalMyUploadsPage tabbed shell", () => {
  it("renders Rentals tab body by default (no ?tab)", async () => {
    renderAt("/portal/my-uploads");

    // Rentals empty state shows
    expect(await screen.findByText(/No uploads yet/i)).toBeInTheDocument();
    // Properties empty state should NOT be present
    expect(
      screen.queryByText(/No property submissions yet/i),
    ).not.toBeInTheDocument();
  });

  it("renders Properties tab body when ?tab=properties", async () => {
    renderAt("/portal/my-uploads?tab=properties");

    expect(
      await screen.findByText(/No property submissions yet/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/No uploads yet/i)).not.toBeInTheDocument();
  });

  it("falls back to Rentals when ?tab has an unknown value", async () => {
    renderAt("/portal/my-uploads?tab=garbage");

    expect(await screen.findByText(/No uploads yet/i)).toBeInTheDocument();
  });

  it("clicking the Properties tab pill updates the URL and swaps the body", async () => {
    const user = userEvent.setup();
    const { getLocation } = renderAt("/portal/my-uploads");

    const propertiesBtn = screen.getByRole("radio", { name: /Properties/i });
    await user.click(propertiesBtn);

    expect(getLocation()).toBe("/portal/my-uploads?tab=properties");
    expect(
      await screen.findByText(/No property submissions yet/i),
    ).toBeInTheDocument();
  });

  it("renders the page header + Add new button on both tabs", () => {
    renderAt("/portal/my-uploads?tab=properties");
    expect(screen.getByRole("heading", { name: /My uploads/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Add new/i })).toBeInTheDocument();
  });
});
