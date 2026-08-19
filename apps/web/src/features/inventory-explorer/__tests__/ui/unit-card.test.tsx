// __tests__/unit-card.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { UnitCard } from "../../ui/unit-card";
import type { InventoryListing } from "../../domain/types";

const baseUnit: InventoryListing = {
  id: "u1", unitCode: "A-12-01", unitType: "", bedrooms: 3, bathrooms: 2,
  floorArea: 1100, rentalRate: "2200", moveInDate: null, readyNow: true,
  occupancyStatus: "occupied",
  inChargeName: "Alice", inChargePartyId: "p-alice", photoKeys: ["k1"], videoKeys: [],
  coverPhotoUrl: "https://x/cover.jpg", visibilityMode: "PUBLIC", hiddenFromPartyIds: [],
  sourceFlag: "COMPANY", sourcingAgentId: null, sourcingAgentName: null, sourcingApproved: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  currency: "MYR", title: null, description: null, amenities: [],
  furnishingLevel: null, floor: null, facing: null, depositMonths: null,
  utilitiesDepositMonths: null, accessCardDepositPerPcs: null,
  accessCardQuantity: null, parkingQuantity: null, parkingNumbers: [],
  vacantSince: null, listingStatus: "active",
  currentTenancyStartDate: null, currentTenancyEndDate: null,
  property: { name: "Bangsar South", city: "Kuala Lumpur" },
};

const FIXED_TODAY = new Date("2026-05-01T00:00:00.000Z");

const renderCard = (
  unit = baseUnit,
  view: "grid" | "list" = "grid",
  to = "/portal/inventory/u1",
  today: Date = FIXED_TODAY,
) =>
  render(
    <MemoryRouter>
      <UnitCard unit={unit} to={to} view={view} today={today} />
    </MemoryRouter>,
  );

describe("UnitCard navigation (bug-class regression)", () => {
  it("uses the caller-supplied `to` prop, NOT a hardcoded portal path (grid)", () => {
    renderCard(baseUnit, "grid", "/inventory/units/u1");
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "/inventory/units/u1");
    expect(link.getAttribute("href")).not.toMatch(/^\/portal\//);
  });

  it("uses the caller-supplied `to` prop, NOT a hardcoded portal path (list)", () => {
    renderCard(baseUnit, "list", "/inventory/units/u1");
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "/inventory/units/u1");
    expect(link.getAttribute("href")).not.toMatch(/^\/portal\//);
  });
});

describe("UnitCard", () => {
  beforeEach(() => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  });

  it("grid view renders cover image when coverPhotoUrl present", () => {
    renderCard();
    const img = screen.getByRole("img");
    expect(img).toHaveAttribute("src", "https://x/cover.jpg");
  });

  it("falls back to placeholder icon when no coverPhotoUrl", () => {
    renderCard({ ...baseUnit, coverPhotoUrl: null });
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("renders address, beds/baths, rental, in-charge", () => {
    renderCard();
    expect(screen.getByText("Bangsar South")).toBeInTheDocument();
    expect(screen.getByText("A-12-01")).toBeInTheDocument();
    expect(screen.getByText(/3 bed/)).toBeInTheDocument();
    expect(screen.getByText(/2 bath/)).toBeInTheDocument();
    expect(screen.getByText(/RM 2,200\.00/)).toBeInTheDocument();
    expect(screen.getByText("Alice")).toBeInTheDocument();
  });

  it("links to the caller-supplied path (default test path is /portal/inventory/:id)", () => {
    renderCard();
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "/portal/inventory/u1");
  });

  it("Copy summary button writes a markdown summary to clipboard", async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByLabelText(/copy listing summary/i));
    const written = vi.mocked(navigator.clipboard.writeText).mock.calls[0][0];
    expect(written).toContain("Bangsar South");
    expect(written).toContain("A-12-01");
    expect(written).toContain("RM 2,200.00");
    expect(written).toContain("3 bed");
  });

  it("Copy share link writes the absolute URL built from the caller's `to` prop", async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByLabelText(/copy share link/i));
    const written = vi.mocked(navigator.clipboard.writeText).mock.calls[0][0];
    expect(written).toMatch(/\/portal\/inventory\/u1$/);
  });

  it("Save to shortlist button is disabled with 'Coming soon' tooltip text", () => {
    renderCard();
    const btn = screen.getByLabelText(/save to shortlist/i);
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("title", expect.stringMatching(/coming soon/i));
  });

  it("list view renders one row, no overlay duplication", () => {
    renderCard(baseUnit, "list");
    expect(screen.getByRole("link")).toHaveClass(/flex/);
    expect(screen.getByText("Bangsar South")).toBeInTheDocument();
  });

  describe("partition label", () => {
    it("grid view: shows partition badge as the first badge in the cluster", () => {
      const masterUnit: InventoryListing = { ...baseUnit, unitType: "Master" };
      renderCard(masterUnit, "grid");
      // The badge text "Master" must be present and must be the first badge
      // in the absolute top-left cluster (rendered before "Ready now" because
      // the unit is readyNow=true).
      const masterEl = screen.getByText("Master");
      expect(masterEl).toBeInTheDocument();
      const readyEl = screen.getByText("Ready now");
      // DOCUMENT_POSITION_FOLLOWING = 4 means masterEl is before readyEl.
      expect(masterEl.compareDocumentPosition(readyEl) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
    });

    it("list view: shows the partition badge inline next to the property name", () => {
      const mediumUnit: InventoryListing = { ...baseUnit, unitType: "Medium" };
      renderCard(mediumUnit, "list");
      expect(screen.getByText("Medium")).toBeInTheDocument();
      // The badge must live next to the property name (sharing the same
      // flex row). The property name "Bangsar South" is the first sibling
      // text node in that row.
      const medium = screen.getByText("Medium");
      const propertyName = screen.getByText("Bangsar South");
      expect(medium.parentElement).toBe(propertyName.parentElement);
    });

    it("renders without crashing and shows no partition badge when unitType is empty", () => {
      const noTypeUnit: InventoryListing = { ...baseUnit, unitType: "" };
      renderCard(noTypeUnit, "grid");
      // Existing badges still render — "Ready now" is from readyNow:true.
      expect(screen.getByText("Ready now")).toBeInTheDocument();
      // No "Master"/"Medium"/etc. badge — the only badge text in the cluster
      // should be the status one. We don't look up empty string (
      // getByText("") throws) — instead assert nothing slate-styled appears.
      const slateBadges = document.querySelectorAll("[class*='border-slate-400']");
      expect(slateBadges.length).toBe(0);
    });
  });
});

describe("UnitCard occupancy badge", () => {
  it("renders 'Ready now' (emerald) when readyNow=true", () => {
    renderCard({ ...baseUnit, readyNow: true });
    expect(screen.getByText("Ready now")).toBeInTheDocument();
  });

  it("renders 'Move-in {date}' for upcoming units", () => {
    renderCard({ ...baseUnit, readyNow: false, moveInDate: "2026-06-01" });
    expect(screen.getByText(/Move-in/)).toBeInTheDocument();
    expect(screen.getByText(/2026-06-01/)).toBeInTheDocument();
  });

  it("renders 'Available soon — {date}' for ending-within-window units (amber)", () => {
    renderCard({
      ...baseUnit,
      readyNow: false,
      currentTenancyEndDate: "2026-05-31T00:00:00.000Z",
    });
    expect(screen.getByText(/Available soon/)).toBeInTheDocument();
    expect(screen.getByText(/2026-05-31/)).toBeInTheDocument();
  });

  it("renders 'Occupied — until {date}' for occupied units with end date", () => {
    renderCard({
      ...baseUnit,
      readyNow: false,
      currentTenancyEndDate: "2027-01-01T00:00:00.000Z",
    });
    expect(screen.getByText(/Occupied — until/)).toBeInTheDocument();
    expect(screen.getByText(/2027-01-01/)).toBeInTheDocument();
  });

  it("renders bare 'Occupied' for open-ended leases", () => {
    renderCard({
      ...baseUnit,
      readyNow: false,
      currentTenancyEndDate: null,
    });
    expect(screen.getByText("Occupied")).toBeInTheDocument();
  });
});
