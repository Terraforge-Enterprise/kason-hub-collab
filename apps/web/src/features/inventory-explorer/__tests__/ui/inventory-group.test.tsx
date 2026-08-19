import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { InventoryGroup } from "../../ui/inventory-group";
import type { Bucket } from "../../domain/types";

const bucket: Bucket = {
  buildingName: "Bangsar South",
  city: "KL",
  units: [
    { id: "u1", unitCode: "A-1", unitType: "condo", bedrooms: 2, bathrooms: 1, floorArea: 800, rentalRate: "2000", currency: "MYR", moveInDate: null, readyNow: true, occupancyStatus: "vacant", inChargeName: null, inChargePartyId: null, photoKeys: [], videoKeys: [], coverPhotoUrl: null, title: null, description: null, amenities: [], furnishingLevel: null, floor: null, facing: null, depositMonths: null, utilitiesDepositMonths: null, accessCardDepositPerPcs: null, accessCardQuantity: null, parkingQuantity: null, parkingNumbers: [], vacantSince: null, listingStatus: "active", visibilityMode: "PUBLIC", hiddenFromPartyIds: [], sourceFlag: "COMPANY", sourcingAgentId: null, sourcingAgentName: null, sourcingApproved: true, createdAt: "2026-01-01T00:00:00.000Z", currentTenancyStartDate: null, currentTenancyEndDate: null, property: { name: "Bangsar South", city: "KL" }},
  ],
};

const defaultGetHref = (u: { id: string }) => `/portal/inventory/${u.id}`;

describe("InventoryGroup", () => {
  it("renders header with building name, count, city", () => {
    render(<MemoryRouter><InventoryGroup bucket={bucket} defaultExpanded={true} view="grid" getHref={defaultGetHref} /></MemoryRouter>);
    const btn = screen.getByRole("button", { name: /collapse.*bangsar/i });
    expect(btn).toBeInTheDocument();
    expect(within(btn).getByText("(1)")).toBeInTheDocument();
    expect(within(btn).getByText("KL")).toBeInTheDocument();
  });

  it("expanded by default shows units; collapse hides them", async () => {
    render(<MemoryRouter><InventoryGroup bucket={bucket} defaultExpanded={true} view="grid" getHref={defaultGetHref} /></MemoryRouter>);
    expect(screen.getByText("A-1")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /collapse|expand/i }));
    expect(screen.queryByText("A-1")).toBeNull();
  });

  it("collapsed by default hides units; expand shows them", async () => {
    render(<MemoryRouter><InventoryGroup bucket={bucket} defaultExpanded={false} view="grid" getHref={defaultGetHref} /></MemoryRouter>);
    expect(screen.queryByText("A-1")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /expand/i }));
    expect(screen.getByText("A-1")).toBeInTheDocument();
  });

  it("toggle button has correct aria-expanded", () => {
    render(<MemoryRouter><InventoryGroup bucket={bucket} defaultExpanded={true} view="grid" getHref={defaultGetHref} /></MemoryRouter>);
    const btn = screen.getByRole("button", { name: /collapse|expand/i });
    expect(btn).toHaveAttribute("aria-expanded", "true");
  });

  it("passes getHref through to each UnitCard (no hardcoded portal path)", () => {
    render(
      <MemoryRouter>
        <InventoryGroup
          bucket={bucket}
          defaultExpanded={true}
          view="grid"
          getHref={(u) => `/inventory/units/${u.id}`}
        />
      </MemoryRouter>,
    );
    const link = screen.getByRole("link", { name: /A-1/ });
    expect(link).toHaveAttribute("href", "/inventory/units/u1");
    expect(link.getAttribute("href")).not.toMatch(/^\/portal\//);
  });
});
