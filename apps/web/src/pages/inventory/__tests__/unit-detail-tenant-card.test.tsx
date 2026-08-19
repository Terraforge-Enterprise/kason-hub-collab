import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { TenantDetailsCard } from "../unit-detail-page";

// Fixture matches the exact shape GET /inventory/units/:id returns for
// `activeTenancy` (findUnitDetail → inventory.types.ts UnitDetail). Per frontend
// §16, we mount against the production response shape and assert the visible
// artifact — so a future contract regression (field dropped) fails here.
const fullTenancy = {
  id: "ten-1",
  tenantPartyId: "party-1",
  tenantName: "Daniel Tan",
  tenantIdType: "nric",
  tenantIdNumberMasked: "••••1234",
  tenantPhone: "+60 12-345 6789",
  startDate: "2026-07-13",
  endDate: "2027-07-12",
};

describe("TenantDetailsCard", () => {
  it("renders the assigned tenant's name, phone, masked IC and move-in (B1)", () => {
    render(<TenantDetailsCard tenancy={fullTenancy} occupancyStatus="occupied" unitId="u1" />);
    expect(screen.getByText("Daniel Tan")).toBeInTheDocument();
    expect(screen.getByText("+60 12-345 6789")).toBeInTheDocument();
    expect(screen.getByText("••••1234")).toBeInTheDocument();
    expect(screen.getByText("2026-07-13")).toBeInTheDocument();
  });

  it("still renders for an open-ended lease with a null endDate (B2)", () => {
    // Regression: the old card was gated on currentTenancyEndDate, so an
    // open-ended lease (endDate null) hid the whole section — the user saw
    // nothing despite an assigned tenant.
    render(
      <TenantDetailsCard tenancy={{ ...fullTenancy, endDate: null }} occupancyStatus="occupied" unitId="u1" />,
    );
    expect(screen.getByText("Daniel Tan")).toBeInTheDocument();
    expect(screen.getByText(/open-ended/i)).toBeInTheDocument();
  });

  it("renders placeholders for a missing phone / IC without crashing (B3)", () => {
    render(
      <TenantDetailsCard
        tenancy={{ ...fullTenancy, tenantPhone: null, tenantIdNumberMasked: null }}
        occupancyStatus="occupied"
        unitId="u1"
      />,
    );
    expect(screen.getByText("Daniel Tan")).toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
  });

  it("renders nothing when there is no active tenancy (B4)", () => {
    const { container } = render(
      <TenantDetailsCard tenancy={null} occupancyStatus="vacant" unitId="u1" />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
