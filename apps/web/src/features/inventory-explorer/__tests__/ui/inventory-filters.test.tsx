import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { InventoryFilters } from "../../ui/inventory-filters";
import { EMPTY_FILTERS, type InventoryListing } from "../../domain/types";

const mk = (over: Partial<InventoryListing> & { id: string }): InventoryListing => ({
  unitCode: "A", unitType: "condo", bedrooms: 1, bathrooms: 1, floorArea: 500,
  rentalRate: "1000", moveInDate: null, readyNow: true, occupancyStatus: "vacant",
  inChargeName: null, inChargePartyId: null, photoKeys: [], videoKeys: [], coverPhotoUrl: null,
  visibilityMode: "PUBLIC", hiddenFromPartyIds: [], sourceFlag: "COMPANY",
  sourcingAgentId: null, sourcingAgentName: null, sourcingApproved: true,
  createdAt: "2026-01-01T00:00:00.000Z", currency: "MYR",
  title: null, description: null, amenities: [],
  furnishingLevel: null, floor: null, facing: null, depositMonths: null,
  utilitiesDepositMonths: null, accessCardDepositPerPcs: null,
  accessCardQuantity: null, parkingQuantity: null, parkingNumbers: [],
  vacantSince: null, listingStatus: "active",
  currentTenancyStartDate: null, currentTenancyEndDate: null,
  property: { name: "X", city: "KL" }, ...over,
});

describe("InventoryFilters — shell", () => {
  it("shows 'FILTERS' panel header with active count zero by default", () => {
    render(<InventoryFilters value={EMPTY_FILTERS} onChange={() => {}} units={[mk({ id: "1" })]} />);
    expect(screen.getByText(/^filters/i)).toBeInTheDocument();
  });

  it("Clear all link in header resets filters", async () => {
    const onChange = vi.fn();
    render(<InventoryFilters value={{ ...EMPTY_FILTERS, beds: [2] }} onChange={onChange} units={[mk({ id: "1" })]} />);
    await userEvent.click(screen.getByRole("button", { name: /clear all/i }));
    expect(onChange).toHaveBeenCalledWith(EMPTY_FILTERS);
  });

  it("active count in header reflects filter selections", () => {
    render(<InventoryFilters value={{ ...EMPTY_FILTERS, beds: [2], baths: [1] }} onChange={() => {}} units={[mk({ id: "1" })]} />);
    expect(screen.getByText(/2 active/i)).toBeInTheDocument();
  });
});

describe("InventoryFilters — Availability", () => {
  it("renders the 3-state segmented control with All selected by default", () => {
    render(<InventoryFilters value={EMPTY_FILTERS} onChange={() => {}} units={[mk({ id: "1" })]} />);
    const all = screen.getByRole("radio", { name: /all/i });
    expect(all).toHaveAttribute("aria-checked", "true");
  });

  it("clicking 'Available now' calls onChange with availability=now", async () => {
    const onChange = vi.fn();
    render(<InventoryFilters value={EMPTY_FILTERS} onChange={onChange} units={[mk({ id: "1" })]} />);
    await userEvent.click(screen.getByRole("radio", { name: /available now/i }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ availability: "now" }));
  });

  it("subtitle reads 'showing X of Y units'", () => {
    render(
      <InventoryFilters
        value={EMPTY_FILTERS}
        onChange={() => {}}
        units={[mk({ id: "1" }), mk({ id: "2" })]}
      />,
    );
    expect(screen.getByText(/2 units/i)).toBeInTheDocument();
  });
});

describe("InventoryFilters — Bedrooms / Bathrooms", () => {
  it("clicking '2' bedroom toggles 2 in beds[]", async () => {
    const onChange = vi.fn();
    render(<InventoryFilters value={EMPTY_FILTERS} onChange={onChange} units={[mk({ id: "1" })]} />);
    // PillBar buttons have name = label. Studio was removed from this section —
    // studios are filtered via the Property Type section instead — so the
    // bedrooms pill bar now starts at "1". Match by label text rather than
    // nth-child so future reorderings don't silently break the assertion.
    const bedsGroup = screen.getByRole("group", { name: /bedrooms/i });
    const twoBed = Array.from(bedsGroup.querySelectorAll('button[aria-pressed]')).find(
      (btn) => (btn as HTMLButtonElement).textContent?.trim() === "2",
    ) as HTMLButtonElement | undefined;
    if (!twoBed) throw new Error("Could not find 2-bed pill");
    await userEvent.click(twoBed);
    const last = onChange.mock.calls.at(-1)![0];
    expect(last.beds).toContain(2);
  });

  it("clicking '3+' bathroom toggles 3 in baths[]", async () => {
    const onChange = vi.fn();
    render(<InventoryFilters value={EMPTY_FILTERS} onChange={onChange} units={[mk({ id: "1" })]} />);
    const bathsGroup = screen.getByRole("group", { name: /bathrooms/i });
    const threePlusBath = Array.from(bathsGroup.querySelectorAll('button')).find(b => b.textContent === "3+") as HTMLButtonElement;
    if (!threePlusBath) throw new Error("Could not find 3+ bath pill");
    await userEvent.click(threePlusBath);
    const last = onChange.mock.calls.at(-1)![0];
    expect(last.baths).toContain(3);
  });
});

describe("InventoryFilters — Price", () => {
  it("renders median below the inputs when rentalRate data is present", () => {
    render(
      <InventoryFilters
        value={EMPTY_FILTERS}
        onChange={() => {}}
        units={[mk({ id: "1", rentalRate: "2000" }), mk({ id: "2", rentalRate: "4000" })]}
      />,
    );
    // Placeholder stays clean ("Min RM" / "Max RM") so it doesn't truncate
    // in the narrow filter column. Median moves to a hint line below.
    expect(screen.getByLabelText(/min rm/i)).toHaveAttribute("placeholder", "Min RM");
    expect(screen.getByText(/median: rm 3,000/i)).toBeInTheDocument();
  });

  it("omits the median hint when no rentalRate data is present", () => {
    render(
      <InventoryFilters
        value={EMPTY_FILTERS}
        onChange={() => {}}
        units={[mk({ id: "1", rentalRate: null })]}
      />,
    );
    expect(screen.getByLabelText(/min rm/i)).toHaveAttribute("placeholder", "Min RM");
    expect(screen.queryByText(/median:/i)).not.toBeInTheDocument();
  });

  it("typing into Max RM emits priceMax", async () => {
    const onChange = vi.fn();
    render(<InventoryFilters value={EMPTY_FILTERS} onChange={onChange} units={[mk({ id: "1" })]} />);
    await userEvent.type(screen.getByLabelText(/max rm/i), "5000");
    const last = onChange.mock.calls.at(-1)![0];
    expect(last.priceMax).toBe(5000);
  });
});

describe("InventoryFilters — Floor area", () => {
  it("placeholders read 'Min sqft' / 'Max sqft' and section is collapsed by default", async () => {
    render(<InventoryFilters value={EMPTY_FILTERS} onChange={() => {}} units={[mk({ id: "1" })]} />);
    expect(screen.queryByLabelText(/min sqft/i)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /floor area/i }));
    expect(screen.getByLabelText(/min sqft/i)).toHaveAttribute("placeholder", "Min sqft");
    expect(screen.getByLabelText(/max sqft/i)).toHaveAttribute("placeholder", "Max sqft");
  });
});

describe("InventoryFilters — Move-out window", () => {
  it("clicking 'Next 60 days' sets moveOutFrom=today, moveOutTo=today+60", async () => {
    const onChange = vi.fn();
    render(<InventoryFilters value={EMPTY_FILTERS} onChange={onChange} units={[mk({ id: "1" })]} />);
    await userEvent.click(screen.getByRole("button", { name: /move-out/i }));
    await userEvent.click(screen.getByRole("button", { name: /next 60 days/i }));
    const last = onChange.mock.calls.at(-1)![0];
    expect(last.moveOutFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(last.moveOutTo).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("Move-out window controls render regardless of availability segment", async () => {
    render(<InventoryFilters value={{ ...EMPTY_FILTERS, availability: "now" }} onChange={() => {}} units={[mk({ id: "1" })]} />);
    await userEvent.click(screen.getByRole("button", { name: /move-out/i }));
    expect(screen.getByRole("button", { name: /next 30 days/i })).toBeInTheDocument();
    expect(screen.queryByText(/move-out window only narrows/i)).not.toBeInTheDocument();
  });
});

describe("InventoryFilters — data-driven sections", () => {
  it("City section auto-hides when only one city in units", async () => {
    render(
      <InventoryFilters
        value={EMPTY_FILTERS}
        onChange={() => {}}
        units={[mk({ id: "1", property: { name: "X", city: "KL" } })]}
      />,
    );
    expect(screen.queryByText(/^city$/i)).not.toBeInTheDocument();
  });

  it("City section renders when 2+ cities present", async () => {
    render(
      <InventoryFilters
        value={EMPTY_FILTERS}
        onChange={() => {}}
        units={[
          mk({ id: "1", property: { name: "X", city: "KL" } }),
          mk({ id: "2", property: { name: "Y", city: "Klang" } }),
        ]}
      />,
    );
    expect(screen.getByText(/^city$/i)).toBeInTheDocument();
  });
});

describe("InventoryFilters — Source", () => {
  const twoSources = [
    mk({ id: "1", sourceFlag: "COMPANY" }),
    mk({ id: "2", sourceFlag: "AGENT_SOURCED", sourcingAgentId: "p1", sourcingAgentName: "Priya" }),
    mk({ id: "3", sourceFlag: "AGENT_SOURCED", sourcingAgentId: "p2", sourcingAgentName: "Wei" }),
  ];

  it("hides Source when only one source value present", () => {
    render(<InventoryFilters value={EMPTY_FILTERS} onChange={() => {}} units={[mk({ id: "1", sourceFlag: "COMPANY" })]} />);
    expect(screen.queryByText(/^source$/i)).not.toBeInTheDocument();
  });

  it("Sourced-by sub-picker only renders when Agent sourced is selected", async () => {
    render(<InventoryFilters value={EMPTY_FILTERS} onChange={() => {}} units={twoSources} />);
    await userEvent.click(screen.getByRole("button", { name: /^source$/i }));
    expect(screen.queryByText(/sourced by/i)).not.toBeInTheDocument();
  });

  it("when sources includes agent_sourced, Sourced-by appears", async () => {
    render(
      <InventoryFilters
        value={{ ...EMPTY_FILTERS, sources: ["agent_sourced"] }}
        onChange={() => {}}
        units={twoSources}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /^source$/i }));
    expect(screen.getByText(/sourced by/i)).toBeInTheDocument();
  });
});

describe("InventoryFilters — Furnishing/Floor/Facing", () => {
  it("Furnishing auto-hides when no furnishing data", () => {
    render(<InventoryFilters value={EMPTY_FILTERS} onChange={() => {}} units={[mk({ id: "1" })]} />);
    expect(screen.queryByText(/furnishing/i)).not.toBeInTheDocument();
  });

  it("Floor section exposes Min/Max numeric inputs and renders a data-range hint", async () => {
    const onChange = vi.fn();
    render(<InventoryFilters value={EMPTY_FILTERS} onChange={onChange} units={[mk({ id: "1", floor: 5 }), mk({ id: "2", floor: 12 })]} />);
    await userEvent.click(screen.getByRole("button", { name: /^floor$/i }));
    const min = screen.getByLabelText(/min floor/i);
    const max = screen.getByLabelText(/max floor/i);
    expect(min).toHaveAttribute("placeholder", "Min");
    expect(max).toHaveAttribute("placeholder", "Max");
    expect(screen.getByText(/floors in data: 5–12/i)).toBeInTheDocument();
    await userEvent.type(min, "1");
    await userEvent.type(max, "10");
    const last = onChange.mock.calls.at(-1)![0];
    expect(last.floorMax).toBe(10);
  });

  it("Facing pill bar humanizes single-letter cardinals to compass words", async () => {
    render(<InventoryFilters value={EMPTY_FILTERS} onChange={() => {}} units={[mk({ id: "1", facing: "N" }), mk({ id: "2", facing: "S" })]} />);
    await userEvent.click(screen.getByRole("button", { name: /facing/i }));
    expect(screen.getByRole("button", { name: "North" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "South" })).toBeInTheDocument();
  });
});

describe("InventoryFilters — Amenities", () => {
  it("renders distinct amenities as chips when 2-6", async () => {
    render(
      <InventoryFilters
        value={EMPTY_FILTERS}
        onChange={() => {}}
        units={[
          mk({ id: "1", amenities: [{ id: "p", name: "Pool" }, { id: "g", name: "Gym" }] }),
          mk({ id: "2", amenities: [{ id: "pk", name: "Parking" }] }),
        ]}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /amenities/i }));
    expect(screen.getByRole("button", { name: /pool/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /gym/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /parking/i })).toBeInTheDocument();
  });
});

describe("InventoryFilters — Vacant-since / Deposit", () => {
  it("Vacant-since auto-hides when no unit has vacantSince", () => {
    render(<InventoryFilters value={EMPTY_FILTERS} onChange={() => {}} units={[mk({ id: "1" })]} />);
    expect(screen.queryByText(/vacant-since/i)).not.toBeInTheDocument();
  });

  it("Deposit chips set depositMonthsMax", async () => {
    const onChange = vi.fn();
    render(<InventoryFilters value={EMPTY_FILTERS} onChange={onChange} units={[mk({ id: "1", depositMonths: 2 })]} />);
    await userEvent.click(screen.getByRole("button", { name: /deposit months/i }));
    await userEvent.click(screen.getByRole("button", { name: /≤ 1 month/i }));
    const last = onChange.mock.calls.at(-1)![0];
    expect(last.depositMonthsMax).toBe(1);
  });
});

describe("InventoryFilters — Floor/Deposit auto-hide", () => {
  it("Floor section auto-hides when no unit has floor data", () => {
    render(<InventoryFilters value={EMPTY_FILTERS} onChange={() => {}} units={[mk({ id: "1", floor: null })]} />);
    expect(screen.queryByRole("button", { name: /^floor$/i })).not.toBeInTheDocument();
  });

  it("Floor section shows when at least one unit has floor", () => {
    render(<InventoryFilters value={EMPTY_FILTERS} onChange={() => {}} units={[mk({ id: "1", floor: 5 })]} />);
    expect(screen.getByRole("button", { name: /^floor$/i })).toBeInTheDocument();
  });

  it("Deposit months auto-hides when no unit has depositMonths data", () => {
    render(<InventoryFilters value={EMPTY_FILTERS} onChange={() => {}} units={[mk({ id: "1", depositMonths: null })]} />);
    expect(screen.queryByText(/deposit months/i)).not.toBeInTheDocument();
  });

  it("Deposit months shows when at least one unit has depositMonths", () => {
    render(<InventoryFilters value={EMPTY_FILTERS} onChange={() => {}} units={[mk({ id: "1", depositMonths: 2 })]} />);
    expect(screen.getByText(/deposit months/i)).toBeInTheDocument();
  });
});
