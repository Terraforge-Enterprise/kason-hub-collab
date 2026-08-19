/**
 * Component tests for the agent's property edit & resubmit page.
 * Spec: docs/superpowers/specs/2026-05-21-agent-property-amendment-design.md §4.5
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

const mockGet = vi.fn();
const mockUpdate = vi.fn();
const mockWithdraw = vi.fn();

vi.mock("@/api/portal-inventory", () => ({
  getOwnPortalProperty: (...args: unknown[]) => mockGet(...args),
  updateOwnPortalProperty: (...args: unknown[]) => mockUpdate(...args),
  withdrawOwnPortalProperty: (...args: unknown[]) => mockWithdraw(...args),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// PropertyTypeSelect (Task 7) is fed by usePortalPropertyTypes — mock a small
// catalog that includes the fixture's "Condominium" value so it resolves as
// an in-catalog (not legacy "(current)") selected option.
vi.mock("@/hooks/use-portal-property-types", () => ({
  usePortalPropertyTypes: () => ({
    data: [
      { id: "pt-condo", name: "Condominium" },
      { id: "pt-landed", name: "Landed" },
    ],
  }),
}));

import PortalPropertyEditPage from "../property-edit-page";
import type { PortalOwnPropertyDetail } from "@/api/portal-inventory";

function makeDetail(
  overrides: Partial<PortalOwnPropertyDetail> = {},
): PortalOwnPropertyDetail {
  return {
    id: "sub-1",
    propertyCode: "TC-001",
    proposedName: "The Capers, Sentul",
    propertyType: "Condominium",
    addressLine1: "1 Jalan Sentul",
    addressLine2: null,
    city: "Kuala Lumpur",
    state: "Selangor",
    postalCode: "51000",
    country: "Malaysia",
    submissionState: "needs_amendment",
    amendmentNote: "Postal code is wrong, please correct.",
    approvedPropertyId: null,
    createdAt: "2026-05-19T00:00:00.000Z",
    updatedAt: "2026-05-19T00:00:00.000Z",
    ...overrides,
  };
}

function renderPage(initialPath = "/portal/properties/sub-1/edit") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let lastLocation = initialPath;
  function LocationProbe() {
    const loc = useLocation();
    lastLocation = `${loc.pathname}${loc.search}`;
    return null;
  }
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route
            path="/portal/properties/:submissionId/edit"
            element={
              <>
                <LocationProbe />
                <PortalPropertyEditPage />
              </>
            }
          />
          <Route
            path="/portal/my-uploads"
            element={
              <>
                <LocationProbe />
                <div data-testid="my-uploads-route" />
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
  mockGet.mockReset();
  mockUpdate.mockReset();
  mockWithdraw.mockReset();
});

describe("PortalPropertyEditPage", () => {
  it("prefills the form from the fetched submission", async () => {
    mockGet.mockResolvedValue(makeDetail());

    renderPage();

    expect(await screen.findByDisplayValue("The Capers, Sentul")).toBeInTheDocument();
    expect(screen.getByDisplayValue("TC-001")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Condominium")).toBeInTheDocument();
    expect(screen.getByDisplayValue("51000")).toBeInTheDocument();
  });

  it("shows the amber Callout banner with admin's note when state is needs_amendment", async () => {
    mockGet.mockResolvedValue(makeDetail());

    renderPage();

    expect(
      await screen.findByText(/Admin requested an amendment/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Postal code is wrong, please correct/),
    ).toBeInTheDocument();
  });

  it("does NOT show the amendment banner when state is pending", async () => {
    mockGet.mockResolvedValue(makeDetail({ submissionState: "pending", amendmentNote: null }));

    renderPage();

    await screen.findByDisplayValue("The Capers, Sentul");
    expect(screen.queryByText(/Admin requested an amendment/i)).not.toBeInTheDocument();
  });

  it("submits the edited form via updateOwnPortalProperty and navigates to my-uploads", async () => {
    const user = userEvent.setup();
    mockGet.mockResolvedValue(makeDetail());
    mockUpdate.mockResolvedValue({ id: "sub-1" });

    const { getLocation } = renderPage();

    const postcode = await screen.findByDisplayValue("51000");
    await user.clear(postcode);
    await user.type(postcode, "51200");

    await user.click(screen.getByRole("button", { name: /Resubmit for review/i }));

    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith(
        "sub-1",
        expect.objectContaining({ postalCode: "51200", proposedName: "The Capers, Sentul" }),
      );
    });
    await waitFor(() => {
      expect(getLocation()).toBe("/portal/my-uploads?search=&tab=properties".replace("search=&", ""));
    });
  });

  it("renders read-only when state is rejected (no Resubmit button)", async () => {
    mockGet.mockResolvedValue(makeDetail({ submissionState: "rejected" }));

    renderPage();

    await screen.findByDisplayValue("The Capers, Sentul");
    expect(
      screen.queryByRole("button", { name: /Resubmit for review/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Save changes/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Withdraw$/i })).not.toBeInTheDocument();
  });

  it("falls back gracefully when the submission is not found", async () => {
    mockGet.mockRejectedValue(new Error("Submission not found"));

    renderPage();

    expect(
      await screen.findByText(/This submission no longer exists or has been withdrawn/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Back to My Uploads/i })).toBeInTheDocument();
  });

  it("opens a confirmation when Withdraw is clicked, then calls withdrawOwnPortalProperty", async () => {
    const user = userEvent.setup();
    mockGet.mockResolvedValue(makeDetail());
    mockWithdraw.mockResolvedValue({ id: "sub-1" });

    renderPage();

    // Click the outer Withdraw button — opens the confirmation dialog.
    await user.click(await screen.findByRole("button", { name: /^Withdraw$/ }));

    // The confirmation dialog appears with its title; the destructive
    // confirm button inside it is the one we want.
    expect(
      await screen.findByText(/Withdraw this property submission/i),
    ).toBeInTheDocument();

    // With the dialog open, getAllByRole with hidden:true finds both the
    // outer (inert) Withdraw button and the dialog's destructive one.
    // Pick the last (= the dialog's, since the dialog renders after).
    await waitFor(() => {
      const all = screen.getAllByRole("button", { name: /^Withdraw$/, hidden: true });
      expect(all.length).toBeGreaterThan(1);
    });
    const candidates = screen.getAllByRole("button", { name: /^Withdraw$/, hidden: true });
    await user.click(candidates[candidates.length - 1]);

    await waitFor(() => {
      expect(mockWithdraw).toHaveBeenCalled();
    });
  });

  it("on PROPERTY_HAS_PENDING_UNITS, surfaces blocking ids in a Callout", async () => {
    const user = userEvent.setup();
    mockGet.mockResolvedValue(makeDetail());
    mockWithdraw.mockRejectedValue({
      error: "PROPERTY_HAS_PENDING_UNITS",
      blockingUnitIds: ["u-1", "u-2"],
    });

    renderPage();

    await user.click(await screen.findByRole("button", { name: /^Withdraw$/ }));
    await screen.findByText(/Withdraw this property submission/i);
    const candidates = screen.getAllByRole("button", { name: /^Withdraw$/, hidden: true });
    await user.click(candidates[candidates.length - 1]);

    expect(
      await screen.findByText(/Cannot withdraw/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/2 pending unit submissions/i),
    ).toBeInTheDocument();
  });
});
