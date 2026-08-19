import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import PortalInventoryPage from "../inventory-page";

vi.mock("@/lib/portal-api", () => ({
  portalApiFetch: vi.fn(async () => ({
    rows: [
      {
        id: "u-portal-1",
        unitCode: "P-101",
        unitType: "apartment",
        bedrooms: 2,
        bathrooms: 1,
        floorArea: 800,
        rentalRate: 2500,
        currency: "MYR",
        moveInDate: null,
        readyNow: true,
        occupancyStatus: "vacant",
        inChargeName: null,
        inChargePartyId: null,
        photoKeys: [],
        videoKeys: [],
        coverPhotoUrl: null,
        title: null,
        description: null,
        amenities: [],
        furnishingLevel: null,
        floor: null,
        facing: null,
        depositMonths: null,
        vacantSince: null,
        listingStatus: "active",
        visibilityMode: "PUBLIC",
        hiddenFromPartyIds: [],
        sourceFlag: "COMPANY",
        sourcingAgentId: null,
        sourcingAgentName: null,
        sourcingApproved: true,
        createdAt: "2026-01-01T00:00:00Z",
        currentTenancyEndDate: null,
        property: { name: "Skyline", city: "KL" },
      },
    ],
  })),
}));

function wrap(children: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
}

describe("Portal /portal/inventory page (bug-class regression)", () => {
  it("renders cards that link to /portal/inventory/:id (NOT admin path)", async () => {
    render(wrap(<PortalInventoryPage />));
    const link = await waitFor(() => screen.getByRole("link", { name: /P-101/ }));
    expect(link).toHaveAttribute("href", "/portal/inventory/u-portal-1");
    expect(link.getAttribute("href")).not.toMatch(/^\/inventory\/units\//);
  });
});
