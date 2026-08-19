import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { RentalsTab } from "../rentals-tab";

const mockListUnits = vi.fn();

vi.mock("@/api/portal-inventory", () => ({
  listOwnPortalUnits: () => mockListUnits(),
}));

function renderTab() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <RentalsTab />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => mockListUnits.mockReset());

// After the three-table refactor, listOwnPortalUnits returns UnitSubmission
// rows. The status comes from submissionState; bedrooms / rentalRate live
// inside submittedPayload.
function fakeSubmission(state: "pending" | "approved" = "pending") {
  return {
    id: "un-1",
    propertyId: "prop-1",
    unitCode: "A-12-01",
    unitType: "apartment",
    listingType: "apartment",
    listingMode: "WHOLE" as const,
    submissionState: state,
    amendmentNote: null,
    parentListingId: null,
    approvedListingId: null,
    approvedListing: null,
    sourcingAgentId: "agent-1",
    submittedPayload: {
      listing: { rentalRate: 2500 },
      apartmentShared: { bedrooms: 3, bathrooms: 2 },
    },
    property: { id: "prop-1", name: "Tower X", propertyCode: "TX" },
    createdAt: "2026-04-30T00:00:00Z",
    updatedAt: "2026-04-30T00:00:00Z",
  };
}

describe("RentalsTab", () => {
  it("renders agent's units", async () => {
    mockListUnits.mockResolvedValue([fakeSubmission()]);
    renderTab();
    await waitFor(() => expect(screen.getByText("Tower X")).toBeInTheDocument());
  });

  it("renders empty state when no units", async () => {
    mockListUnits.mockResolvedValue([]);
    renderTab();
    await waitFor(() => expect(screen.getByText(/No rentals yet/i)).toBeInTheDocument());
  });

  it("derives 'Pending review' for unapproved units", async () => {
    mockListUnits.mockResolvedValue([fakeSubmission("pending")]);
    renderTab();
    await waitFor(() => screen.getByText("Tower X"));
    expect(screen.getByText(/Pending review/i)).toBeInTheDocument();
  });
});
