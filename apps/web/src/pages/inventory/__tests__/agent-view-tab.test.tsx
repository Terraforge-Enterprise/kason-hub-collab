import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { InventoryAgentViewTab } from "../agent-view-tab";

const apiFetchMock = vi.hoisted(() =>
  vi.fn(async () => ({
    rows: [
      {
        id: "u-admin-1",
        unitCode: "ADM-1",
        unitType: "apartment",
        bedrooms: 1,
        bathrooms: 1,
        floorArea: 500,
        rentalRate: 1800,
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
        property: { name: "Block A", city: "KL" },
      },
    ],
  })),
);

vi.mock("@/lib/api-client", () => ({
  apiFetch: apiFetchMock,
}));

function wrap(children: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
}

describe("Admin /inventory Agent View tab (bug-class regression)", () => {
  it("links cards to admin /inventory/units/:id (NOT portal path)", async () => {
    render(wrap(<InventoryAgentViewTab />));
    const link = await waitFor(() => screen.getByRole("link", { name: /ADM-1/ }));
    expect(link).toHaveAttribute("href", "/inventory/units/u-admin-1");
    expect(link.getAttribute("href")).not.toMatch(/^\/portal\//);
  });

  it("fetches from /listings/explorer (rich shape), NOT /listings (slim)", async () => {
    apiFetchMock.mockClear();
    render(wrap(<InventoryAgentViewTab />));
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith("/listings/explorer"),
    );
  });
});
