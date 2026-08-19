// Tests: Unit dropdown deduplication + Room Type cascade from selected unit.
// Exercises two behaviours introduced by Task 5b (FIX-2 frontend):
//   1. B-12-24 appears exactly once in the Unit dropdown (not 3×).
//   2. Room Type dropdown shows only the rooms of the selected unit.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

// ── Mocks ─────────────────────────────────────────────────────────────────────

// Prevent real HTTP calls from hooks (useTaTierLookup, useTaTierOptions,
// useExistingClaimsOnKey all call portalApiFetch internally).
vi.mock("@/lib/portal-api", () => ({
  portalApiFetch: vi.fn().mockResolvedValue({ data: [] }),
  PortalApiError: class PortalApiError extends Error {
    status: number;
    body: unknown;
    constructor(message: string, status: number, body?: unknown) {
      super(message);
      this.status = status;
      this.body = body;
    }
  },
}));

// useTaTierLookup + useTaTierOptions are used inside ClaimItemCard — stub them
// so they don't fire queries that interfere with assertions.
vi.mock("@/hooks/use-ta-tier-lookup", () => ({
  useTaTierLookup: vi.fn(() => ({ data: null })),
}));
vi.mock("@/hooks/use-ta-tier-options", () => ({
  useTaTierOptions: vi.fn(() => ({ data: null })),
}));
vi.mock("@/hooks/use-existing-claims-on-key", () => ({
  useExistingClaimsOnKey: vi.fn(() => ({ data: null })),
}));
// PhoneInput — avoid any phone-lib initialisation weight
vi.mock("@/components/phone-input", () => ({
  PhoneInput: (props: { value: string; onChange: (v: string) => void }) => (
    <input
      data-testid="phone-input"
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
    />
  ),
}));

import { ClaimItemsTable } from "../claim-items-table";
import { createEmptyItem, type PropertyResult } from "../use-claim-form";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ANNEX_WITH_B1224: PropertyResult = {
  id: "p1",
  name: "Annex",
  hasPaxDeduction: false,
  paxDeductionAmount: null,
  units: [
    {
      unitCode: "B-12-24",
      rooms: [
        { id: "r1", roomType: "Master", rentalRate: "2000" },
        { id: "r2", roomType: "Medium", rentalRate: "1000" },
        { id: "r3", roomType: "Small", rentalRate: "500" },
      ],
    },
    {
      unitCode: "A-01-01",
      rooms: [
        { id: "r4", roomType: "Whole Unit", rentalRate: "3500" },
      ],
    },
  ],
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function renderTable(selectedProperty?: PropertyResult) {
  const item = createEmptyItem();
  // Prime with the condo name so the unit dropdown is shown.
  if (selectedProperty) {
    item.condoName = selectedProperty.name;
    item.propertyId = selectedProperty.id;
    item.hasPaxDeduction = selectedProperty.hasPaxDeduction;
    item.paxDeductionAmount = selectedProperty.paxDeductionAmount ?? 0;
  }

  const selectedProperties = new Map<string, PropertyResult>();
  if (selectedProperty) {
    selectedProperties.set(item.key, selectedProperty);
  }

  const onUpdateItem = vi.fn();
  const onRemoveItem = vi.fn();
  const onAddItem = vi.fn();
  const onPropertySelect = vi.fn();
  const onClearError = vi.fn();

  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ClaimItemsTable
          items={[item]}
          claimType="tenant_portion"
          selectedProperties={selectedProperties}
          tierPercentage={70}
          hasError={() => false}
          getError={() => undefined}
          onAddItem={onAddItem}
          onRemoveItem={onRemoveItem}
          onUpdateItem={onUpdateItem}
          onPropertySelect={onPropertySelect}
          onClearError={onClearError}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );

  return { onUpdateItem, onRemoveItem };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ClaimItemsTable — Unit dropdown deduplication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows B-12-24 exactly once even though the property has 2 units", () => {
    renderTable(ANNEX_WITH_B1224);

    // The Unit dropdown is inside #field-0-unitCode
    const unitWrapper = document.getElementById("field-0-unitCode");
    expect(unitWrapper).not.toBeNull();
    const unitSelect = unitWrapper!.querySelector("select") as HTMLSelectElement;
    expect(unitSelect).not.toBeNull();

    const opts = Array.from(unitSelect.options).map((o) => o.text);
    // B-12-24 must appear exactly once
    expect(opts.filter((t) => t === "B-12-24")).toHaveLength(1);
  });

  it("shows all unique unitCodes from the property", () => {
    renderTable(ANNEX_WITH_B1224);

    const unitWrapper = document.getElementById("field-0-unitCode");
    const unitSelect = unitWrapper!.querySelector("select") as HTMLSelectElement;
    const opts = Array.from(unitSelect.options).map((o) => o.text);

    expect(opts).toContain("B-12-24");
    expect(opts).toContain("A-01-01");
  });
});

describe("ClaimItemsTable — Room Type cascade from selected unit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("Room Type dropdown is disabled and empty when no unit is selected", () => {
    renderTable(ANNEX_WITH_B1224);

    const roomWrapper = document.getElementById("field-0-roomType");
    expect(roomWrapper).not.toBeNull();
    const roomSelect = roomWrapper!.querySelector("select") as HTMLSelectElement;
    expect(roomSelect).toBeDisabled();
    // Only the placeholder option should be present
    const opts = Array.from(roomSelect.options).map((o) => o.text);
    expect(opts).toEqual(["Select room type"]);
  });

  it("Room Type dropdown shows only this unit's rooms after selecting B-12-24", async () => {
    // Render the item already pre-selected to B-12-24
    const item = createEmptyItem();
    item.condoName = ANNEX_WITH_B1224.name;
    item.propertyId = ANNEX_WITH_B1224.id;
    item.hasPaxDeduction = ANNEX_WITH_B1224.hasPaxDeduction;
    item.paxDeductionAmount = ANNEX_WITH_B1224.paxDeductionAmount ?? 0;
    item.unitCode = "B-12-24"; // pre-selected

    const selectedProperties = new Map<string, PropertyResult>();
    selectedProperties.set(item.key, ANNEX_WITH_B1224);

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <ClaimItemsTable
            items={[item]}
            claimType="tenant_portion"
            selectedProperties={selectedProperties}
            tierPercentage={70}
            hasError={() => false}
            getError={() => undefined}
            onAddItem={vi.fn()}
            onRemoveItem={vi.fn()}
            onUpdateItem={vi.fn()}
            onPropertySelect={vi.fn()}
            onClearError={vi.fn()}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const roomWrapper = document.getElementById("field-0-roomType");
    expect(roomWrapper).not.toBeNull();
    const roomSelect = roomWrapper!.querySelector("select") as HTMLSelectElement;

    // Must NOT be disabled (a unit is selected)
    expect(roomSelect).not.toBeDisabled();

    const labels = Array.from(roomSelect.options).map((o) => o.text);
    // Must contain exactly the rooms of B-12-24
    expect(labels).toContain("Master");
    expect(labels).toContain("Medium");
    expect(labels).toContain("Small");
    // Must NOT contain rooms from A-01-01 (Whole Unit)
    expect(labels).not.toContain("Whole Unit");
  });

  it("clears Room Type and calls onUpdateItem with roomType='' when unit changes", async () => {
    const user = userEvent.setup();
    const item = createEmptyItem();
    item.condoName = ANNEX_WITH_B1224.name;
    item.propertyId = ANNEX_WITH_B1224.id;
    item.hasPaxDeduction = ANNEX_WITH_B1224.hasPaxDeduction;
    item.paxDeductionAmount = ANNEX_WITH_B1224.paxDeductionAmount ?? 0;
    item.unitCode = "B-12-24";
    item.roomType = "Master";

    const selectedProperties = new Map<string, PropertyResult>();
    selectedProperties.set(item.key, ANNEX_WITH_B1224);

    const onUpdateItem = vi.fn();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <ClaimItemsTable
            items={[item]}
            claimType="tenant_portion"
            selectedProperties={selectedProperties}
            tierPercentage={70}
            hasError={() => false}
            getError={() => undefined}
            onAddItem={vi.fn()}
            onRemoveItem={vi.fn()}
            onUpdateItem={onUpdateItem}
            onPropertySelect={vi.fn()}
            onClearError={vi.fn()}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const unitWrapper = document.getElementById("field-0-unitCode");
    const unitSelect = unitWrapper!.querySelector("select") as HTMLSelectElement;

    // Change the unit to A-01-01
    await user.selectOptions(unitSelect, "A-01-01");

    // onUpdateItem should have been called with roomType reset to ""
    const roomTypeClearCall = onUpdateItem.mock.calls.find(
      (call) => call[1] === "roomType" && call[2] === "",
    );
    expect(roomTypeClearCall).toBeTruthy();
  });
});
