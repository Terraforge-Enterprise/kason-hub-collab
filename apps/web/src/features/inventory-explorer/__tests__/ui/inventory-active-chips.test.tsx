import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { InventoryActiveChips } from "../../ui/inventory-active-chips";
import { EMPTY_FILTERS, type InventoryListing } from "../../domain/types";

const mkUnit = (over: Partial<InventoryListing>): InventoryListing => ({
  id: "u1", unitCode: "A-1", unitType: "condo", bedrooms: 2, bathrooms: 1,
  floorArea: 800, rentalRate: "2000", moveInDate: null, readyNow: true,
  occupancyStatus: "occupied",
  inChargeName: "Alice", inChargePartyId: "p-alice", photoKeys: [], videoKeys: [],
  coverPhotoUrl: null, visibilityMode: "PUBLIC", hiddenFromPartyIds: [],
  sourceFlag: "COMPANY", sourcingAgentId: null, sourcingAgentName: null, sourcingApproved: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  currency: "MYR", title: null, description: null, amenities: [],
  furnishingLevel: null, floor: null, facing: null, depositMonths: null,
  utilitiesDepositMonths: null, accessCardDepositPerPcs: null,
  accessCardQuantity: null, parkingQuantity: null, parkingNumbers: [],
  vacantSince: null, listingStatus: "active",
  currentTenancyStartDate: null, currentTenancyEndDate: null,
  property: { name: "Bangsar South", city: "KL" }, ...over,
});

describe("InventoryActiveChips", () => {
  it("renders nothing when no filters active", () => {
    const { container } = render(
      <InventoryActiveChips value={EMPTY_FILTERS} onChange={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders one chip per active facet and Reset all", () => {
    render(
      <InventoryActiveChips
        value={{ ...EMPTY_FILTERS, availability: "now", beds: [2, 3], priceMax: 3000, cities: ["KL"] }}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText(/available now/i)).toBeInTheDocument();
    expect(screen.getByText(/2, 3 bed/i)).toBeInTheDocument();
    expect(screen.getByText(/up to RM 3,000/i)).toBeInTheDocument();
    expect(screen.getByText(/^KL$/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reset all/i })).toBeInTheDocument();
  });

  it("clicking a chip's ✕ removes that filter only", async () => {
    const onChange = vi.fn();
    render(
      <InventoryActiveChips
        value={{ ...EMPTY_FILTERS, availability: "now", beds: [2] }}
        onChange={onChange}
      />,
    );
    await userEvent.click(screen.getByLabelText(/remove filter: available now/i));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ availability: "all", beds: [2] }));
  });

  it("inCharge chip resolves the agent name from units", () => {
    render(
      <InventoryActiveChips
        value={{ ...EMPTY_FILTERS, inCharge: ["p-alice"] }}
        onChange={vi.fn()}
        units={[mkUnit({ id: "u1", inChargePartyId: "p-alice", inChargeName: "Alice Tan" })]}
      />,
    );
    expect(screen.getByText(/in charge: alice tan/i)).toBeInTheDocument();
  });

  it("does not render an availability chip when availability=all (default)", () => {
    render(<InventoryActiveChips value={EMPTY_FILTERS} onChange={vi.fn()} units={[]} />);
    expect(screen.queryByText(/available/i)).not.toBeInTheDocument();
  });
});

describe("InventoryActiveChips — new fields", () => {
  it("availability=now renders 'Available now' chip", () => {
    render(<InventoryActiveChips value={{ ...EMPTY_FILTERS, availability: "now" }} onChange={() => {}} />);
    expect(screen.getByText(/available now/i)).toBeInTheDocument();
  });

  it("availability=occupied renders 'Occupied' chip", () => {
    render(<InventoryActiveChips value={{ ...EMPTY_FILTERS, availability: "occupied" }} onChange={() => {}} />);
    expect(screen.getByText(/^Occupied$/i)).toBeInTheDocument();
  });

  it("availability=all renders no chip (default)", () => {
    render(<InventoryActiveChips value={EMPTY_FILTERS} onChange={() => {}} />);
    expect(screen.queryByText(/available/i)).not.toBeInTheDocument();
  });

  it("furnishingLevels render as separate chips", () => {
    render(<InventoryActiveChips value={{ ...EMPTY_FILTERS, furnishingLevels: ["Fully", "Partially"] }} onChange={() => {}} />);
    expect(screen.getByText(/fully/i)).toBeInTheDocument();
    expect(screen.getByText(/partially/i)).toBeInTheDocument();
  });

  it("vacantSinceMinDays=60 renders 'Vacant > 60 days'", () => {
    render(<InventoryActiveChips value={{ ...EMPTY_FILTERS, vacantSinceMinDays: 60 }} onChange={() => {}} />);
    expect(screen.getByText(/vacant > 60 days/i)).toBeInTheDocument();
  });

  it("depositMonthsMax=2 renders 'Deposit ≤ 2 months'", () => {
    render(<InventoryActiveChips value={{ ...EMPTY_FILTERS, depositMonthsMax: 2 }} onChange={() => {}} />);
    expect(screen.getByText(/deposit ≤ 2 months/i)).toBeInTheDocument();
  });

  it("amenities render as separate chips", () => {
    render(<InventoryActiveChips value={{ ...EMPTY_FILTERS, amenities: ["Pool", "Gym"] }} onChange={() => {}} />);
    expect(screen.getByText(/pool/i)).toBeInTheDocument();
    expect(screen.getByText(/gym/i)).toBeInTheDocument();
  });

  it("floor range renders as 'Floor min–max' when both bounds set", () => {
    render(<InventoryActiveChips value={{ ...EMPTY_FILTERS, floorMin: 1, floorMax: 10 }} onChange={() => {}} />);
    expect(screen.getByText(/floor 1–10/i)).toBeInTheDocument();
  });

  it("floor range renders as 'Floor ≥ N' when only min is set", () => {
    render(<InventoryActiveChips value={{ ...EMPTY_FILTERS, floorMin: 6, floorMax: null }} onChange={() => {}} />);
    expect(screen.getByText(/floor ≥ 6/i)).toBeInTheDocument();
  });

  it("facings render as 'Facing X' chips", () => {
    render(<InventoryActiveChips value={{ ...EMPTY_FILTERS, facings: ["N", "S"] }} onChange={() => {}} />);
    expect(screen.getByText(/facing n/i)).toBeInTheDocument();
    expect(screen.getByText(/facing s/i)).toBeInTheDocument();
  });

  it("sourcedByPartyIds resolves name from units when available", () => {
    const unit = mkUnit({ sourcingAgentId: "p-bob", sourcingAgentName: "Bob Lee" });
    render(
      <InventoryActiveChips
        value={{ ...EMPTY_FILTERS, sourcedByPartyIds: ["p-bob"] }}
        onChange={() => {}}
        units={[unit]}
      />,
    );
    expect(screen.getByText(/sourced by: bob lee/i)).toBeInTheDocument();
  });

  it("sourcedByPartyIds falls back to ID when name not found", () => {
    render(
      <InventoryActiveChips
        value={{ ...EMPTY_FILTERS, sourcedByPartyIds: ["p-unknown"] }}
        onChange={() => {}}
        units={[]}
      />,
    );
    expect(screen.getByText(/sourced by: p-unknown/i)).toBeInTheDocument();
  });

  it("clearing a furnishingLevel removes only that value", async () => {
    const onChange = vi.fn();
    render(
      <InventoryActiveChips
        value={{ ...EMPTY_FILTERS, furnishingLevels: ["Fully", "Partially"] }}
        onChange={onChange}
      />,
    );
    await userEvent.click(screen.getByLabelText(/remove filter: fully/i));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ furnishingLevels: ["Partially"] }),
    );
  });
});
