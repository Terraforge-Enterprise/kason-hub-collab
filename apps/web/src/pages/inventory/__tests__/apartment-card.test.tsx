// Phase D — ApartmentCard render behaviour.
// Covers summary fields, chip strips, drift banner, expand/collapse,
// and action-trigger pass-through.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, it, expect } from "vitest";
import { ApartmentCard, EditApartmentButton } from "../apartment-card";
import type { ApartmentSummary } from "@/api/inventory-units-batch";

function makeApartment(overrides: Partial<ApartmentSummary> = {}): ApartmentSummary {
  return {
    id: "apt-test-1",
    unitCode: "C-12-34",
    floor: 12,
    bedrooms: 3,
    bathrooms: 3,
    floorArea: 1200,
    amenities: [
      { id: "a-pool", name: "Pool" },
      { id: "a-gym", name: "Gym" },
    ],
    highlights: ["Near KLCC", "Corner unit"],
    description: "Sunny apartment",
    rooms: [
      {
        id: "u-master",
        unitType: "Master",
        rentalRate: 1200,
        occupancyStatus: "occupied",
        listingStatus: "active",
        inChargePartyId: null,
      },
      {
        id: "u-medium",
        unitType: "Medium",
        rentalRate: 900,
        occupancyStatus: "vacant",
        listingStatus: "active",
        inChargePartyId: null,
      },
    ],
    hasDrift: false,
    listingMode: null,
    ownerPartyId: null,
    ownerName: null,
    ownerPhone: null,
    underManagement: true,
    ...overrides,
  };
}

function wrap(ui: React.ReactNode) {
  return <MemoryRouter>{ui}</MemoryRouter>;
}

describe("ApartmentCard — header rendering", () => {
  it("renders unit code + no-active-listing badge when listingMode is null", () => {
    render(
      wrap(
        <ApartmentCard
          apartment={makeApartment()}
          editApartmentTrigger={<button>Edit</button>}
        />,
      ),
    );
    expect(screen.getByText("C-12-34")).toBeInTheDocument();
    expect(screen.getByText("No active listing")).toBeInTheDocument();
  });

  it("shows a red 'Not under KAEN management' tag when underManagement is false", () => {
    render(
      wrap(
        <ApartmentCard
          apartment={makeApartment({ underManagement: false })}
          editApartmentTrigger={<button>Edit</button>}
        />,
      ),
    );
    const tag = screen.getByText("Not under KAEN management");
    expect(tag).toBeInTheDocument();
    // Must read as a red tag (rose = red semantic per the Badge component).
    expect(tag.className).toContain("rose");
  });

  it("shows NOTHING (no management tag) when underManagement is true", () => {
    render(
      wrap(
        <ApartmentCard
          apartment={makeApartment({ underManagement: true })}
          editApartmentTrigger={<button>Edit</button>}
        />,
      ),
    );
    expect(screen.queryByText("Not under KAEN management")).not.toBeInTheDocument();
  });

  it("shows No active listing badge for 1-room apartments with null listingMode", () => {
    render(
      wrap(
        <ApartmentCard
          apartment={makeApartment({
            rooms: [makeApartment().rooms[0]],
          })}
          editApartmentTrigger={<button>Edit</button>}
        />,
      ),
    );
    expect(screen.getByText("No active listing")).toBeInTheDocument();
  });

  it("renders shared field summary (BR, BA, sqft, floor)", () => {
    render(
      wrap(
        <ApartmentCard
          apartment={makeApartment()}
          editApartmentTrigger={<button>Edit</button>}
        />,
      ),
    );
    expect(screen.getByText("3 BR")).toBeInTheDocument();
    expect(screen.getByText("3 BA")).toBeInTheDocument();
    expect(screen.getByText("1200 sqft")).toBeInTheDocument();
    expect(screen.getByText("Floor 12")).toBeInTheDocument();
  });

  it("omits summary entries when their value is null", () => {
    render(
      wrap(
        <ApartmentCard
          apartment={makeApartment({
            bedrooms: null,
            bathrooms: null,
            floorArea: null,
            floor: null,
          })}
          editApartmentTrigger={<button>Edit</button>}
        />,
      ),
    );
    expect(screen.queryByText(/BR$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/BA$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/sqft$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Floor /)).not.toBeInTheDocument();
  });
});

describe("ApartmentCard — chips", () => {
  it("renders both amenity (catalog) and highlight (free-form) chips", () => {
    render(
      wrap(
        <ApartmentCard
          apartment={makeApartment()}
          editApartmentTrigger={<button>Edit</button>}
        />,
      ),
    );
    // Catalog amenities — visible by name
    expect(screen.getByText("Pool")).toBeInTheDocument();
    expect(screen.getByText("Gym")).toBeInTheDocument();
    // Highlights — free-form taglines, visible verbatim
    expect(screen.getByText("Near KLCC")).toBeInTheDocument();
    expect(screen.getByText("Corner unit")).toBeInTheDocument();
  });

  it("omits the chip strip when both amenities and highlights are empty", () => {
    render(
      wrap(
        <ApartmentCard
          apartment={makeApartment({ amenities: [], highlights: [] })}
          editApartmentTrigger={<button>Edit</button>}
        />,
      ),
    );
    expect(screen.queryByText("Pool")).not.toBeInTheDocument();
    expect(screen.queryByText("Near KLCC")).not.toBeInTheDocument();
  });
});

describe("ApartmentCard — drift", () => {
  it("renders the drift Callout when hasDrift is true", () => {
    render(
      wrap(
        <ApartmentCard
          apartment={makeApartment({ hasDrift: true })}
          editApartmentTrigger={<button>Edit</button>}
        />,
      ),
    );
    expect(screen.getByText(/Drift detected/i)).toBeInTheDocument();
    expect(screen.getByText(/disagree on shared fields/i)).toBeInTheDocument();
  });

  it("does not render the drift Callout when hasDrift is false", () => {
    render(
      wrap(
        <ApartmentCard
          apartment={makeApartment({ hasDrift: false })}
          editApartmentTrigger={<button>Edit</button>}
        />,
      ),
    );
    expect(screen.queryByText(/Drift detected/i)).not.toBeInTheDocument();
  });
});

describe("ApartmentCard — rooms are always visible", () => {
  it("shows rooms by default", () => {
    render(
      wrap(
        <ApartmentCard
          apartment={makeApartment()}
          editApartmentTrigger={<button>Edit</button>}
        />,
      ),
    );
    expect(screen.getByText("Master")).toBeInTheDocument();
    expect(screen.getByText("Medium")).toBeInTheDocument();
  });

  it("expands when initiallyExpanded is true — rooms become visible", () => {
    render(
      wrap(
        <ApartmentCard
          apartment={makeApartment()}
          initiallyExpanded
          editApartmentTrigger={<button>Edit</button>}
        />,
      ),
    );
    expect(screen.getByText("Master")).toBeInTheDocument();
    expect(screen.getByText("Medium")).toBeInTheDocument();
  });

});

describe("ApartmentCard — no second-level collapse", () => {
  it("keeps rooms visible when the card body and unit code are clicked", async () => {
    const user = userEvent.setup();
    render(wrap(<ApartmentCard apartment={makeApartment()} editApartmentTrigger={<button>Edit</button>} />));
    await user.click(screen.getByText("3 BR"));
    expect(screen.queryByText("Master")).not.toBeNull();
    await user.click(screen.getByText("C-12-34"));
    expect(screen.queryByText("Master")).not.toBeNull();
  });

  it("keeps rooms visible when the Edit trigger is clicked", async () => {
    const user = userEvent.setup();
    render(wrap(<ApartmentCard apartment={makeApartment()} editApartmentTrigger={<button>Edit</button>} />));
    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.queryByText("Master")).not.toBeNull();
  });

  it("does not collapse when a room link is clicked", async () => {
    const user = userEvent.setup();
    render(wrap(<ApartmentCard apartment={makeApartment()} initiallyExpanded editApartmentTrigger={<button>Edit</button>} />));
    await user.click(screen.getByText("Master").closest("a")!);
    expect(screen.queryByText("Master")).not.toBeNull(); // stayed expanded
  });

  it("is no longer exposed as an accordion button", () => {
    render(wrap(<ApartmentCard apartment={makeApartment()} editApartmentTrigger={<button>Edit</button>} />));
    expect(screen.queryByRole("button", { name: /apartment C-12-34/i })).toBeNull();
    expect(screen.getByText("Master")).toBeInTheDocument();
  });
});

describe("ApartmentCard — room-row hover affordance", () => {
  it("each room row has cursor-pointer so hover-state is discoverable", () => {
    render(
      wrap(
        <ApartmentCard
          apartment={makeApartment()}
          initiallyExpanded
          editApartmentTrigger={<button>Edit</button>}
        />,
      ),
    );
    const masterRow = screen.getByText("Master").closest("a");
    expect(masterRow).not.toBeNull();
    expect(masterRow!.className).toMatch(/cursor-pointer/);
  });
});

describe("ApartmentCard — action triggers", () => {
  it("renders the editApartmentTrigger node passed in", () => {
    render(
      wrap(
        <ApartmentCard
          apartment={makeApartment()}
          editApartmentTrigger={
            <button data-testid="edit-trigger">Edit apartment</button>
          }
        />,
      ),
    );
    expect(screen.getByTestId("edit-trigger")).toBeInTheDocument();
  });

  it("EditApartmentButton renders 'Edit details' label by default", () => {
    render(
      wrap(
        <ApartmentCard
          apartment={makeApartment()}
          editApartmentTrigger={
            <EditApartmentButton apartmentCode="C-12-34" />
          }
        />,
      ),
    );
    expect(screen.getByRole("button", { name: /Edit details/i })).toBeInTheDocument();
    expect(screen.queryByText("Edit apartment")).not.toBeInTheDocument();
  });
});

describe("ApartmentCard badge — listing mode", () => {
  const baseApt: Omit<ApartmentSummary, "listingMode" | "rooms"> = {
    id: "apt-test-base",
    unitCode: "A-18-02",
    floor: 18,
    bedrooms: 4,
    bathrooms: 2,
    floorArea: 500,
    amenities: [],
    highlights: [],
    description: null,
    hasDrift: false,
    ownerPartyId: null,
    ownerName: null,
    ownerPhone: null,
    underManagement: true,
  };

  function makeRoom(unitType: string) {
    return {
      id: crypto.randomUUID(),
      unitType,
      rentalRate: 1000,
      occupancyStatus: "vacant" as const,
      listingStatus: "active" as const,
      inChargePartyId: null,
    };
  }

  it("renders Whole pill for WHOLE mode", () => {
    render(
      <MemoryRouter>
        <ApartmentCard
          apartment={{ ...baseApt, listingMode: "WHOLE", rooms: [makeRoom("Studio")] }}
          editApartmentTrigger={null}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("Whole unit")).toBeInTheDocument();
    expect(screen.getByText(/1 listing/)).toBeInTheDocument();
  });

  it("renders Partitioned with X of Y rooms listed — X = active rooms, Y = total rooms", () => {
    render(
      <MemoryRouter>
        <ApartmentCard
          apartment={{
            ...baseApt,
            // B-12-24 scenario: 3 rooms, 1 active, 2 draft. Label must read "1 of 3".
            listingMode: "PARTITIONED",
            rooms: [
              { ...makeRoom("Master"), listingStatus: "active" },
              { ...makeRoom("Medium"), listingStatus: "draft" },
              { ...makeRoom("Small"), listingStatus: "draft" },
            ],
          }}
          editApartmentTrigger={null}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("Partitioned")).toBeInTheDocument();
    expect(screen.getByText(/1 of 3 rooms listed/)).toBeInTheDocument();
  });

  it("denominator is total rooms, NOT apartment.bedrooms (regression: was '3 of 1')", () => {
    render(
      <MemoryRouter>
        <ApartmentCard
          apartment={{
            ...baseApt,
            // bedrooms=1 but apartment has 3 rooms — denominator must follow rooms.length
            bedrooms: 1,
            listingMode: "PARTITIONED",
            rooms: [
              { ...makeRoom("Master"), listingStatus: "active" },
              { ...makeRoom("Medium"), listingStatus: "draft" },
              { ...makeRoom("Small"), listingStatus: "draft" },
            ],
          }}
          editApartmentTrigger={null}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText(/1 of 3 rooms listed/)).toBeInTheDocument();
    expect(screen.queryByText(/3 of 1/)).not.toBeInTheDocument();
  });

  it("draft rooms are not counted as listed (regression: 'All 2 listed' when 1 was draft)", () => {
    render(
      <MemoryRouter>
        <ApartmentCard
          apartment={{
            ...baseApt,
            // D-11-22 scenario: 2 rooms, 1 active 1 draft. Must NOT say "All 2 listed".
            listingMode: "PARTITIONED",
            rooms: [
              { ...makeRoom("Master"), listingStatus: "active" },
              { ...makeRoom("Medium"), listingStatus: "draft" },
            ],
          }}
          editApartmentTrigger={null}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText(/1 of 2 rooms listed/)).toBeInTheDocument();
    expect(screen.queryByText(/All 2/)).not.toBeInTheDocument();
  });

  it("renders 'All N rooms listed' when every room is active", () => {
    render(
      <MemoryRouter>
        <ApartmentCard
          apartment={{
            ...baseApt,
            listingMode: "PARTITIONED",
            rooms: [makeRoom("R1"), makeRoom("R2"), makeRoom("R3"), makeRoom("R4")],
          }}
          editApartmentTrigger={null}
        />
      </MemoryRouter>,
    );
    // All 4 are active (makeRoom default), so the "All N" branch fires.
    expect(screen.getByText(/All 4 rooms listed/)).toBeInTheDocument();
  });

  it("renders Mixed — needs review for MIXED mode", () => {
    render(
      <MemoryRouter>
        <ApartmentCard
          apartment={{
            ...baseApt,
            listingMode: "MIXED",
            rooms: [makeRoom("Studio"), makeRoom("Master")],
          }}
          editApartmentTrigger={null}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("Mixed — needs review")).toBeInTheDocument();
  });

  // The standalone "Add rooms" dialog was removed: adding a room to an existing
  // apartment is the Create-unit dialog's Partition path. The card must not grow
  // a second entry point back — for ANY listing mode, not just WHOLE.
  it.each(["WHOLE", "PARTITIONED", "MIXED"] as const)(
    "renders no Add rooms affordance when listingMode is %s",
    (listingMode) => {
      render(
        <MemoryRouter>
          <ApartmentCard
            apartment={{ ...baseApt, listingMode, rooms: [makeRoom("Studio")] }}
            editApartmentTrigger={null}
          />
        </MemoryRouter>,
      );
      expect(screen.queryByText(/Add rooms/i)).not.toBeInTheDocument();
    },
  );

  it("shows the WHOLE inline note pointing to Edit details", () => {
    render(
      <MemoryRouter>
        <ApartmentCard
          apartment={{ ...baseApt, listingMode: "WHOLE", rooms: [makeRoom("Studio")] }}
          editApartmentTrigger={null}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText(/Whole-unit listings hold one row/)).toBeInTheDocument();
    expect(screen.getByText(/Edit details/)).toBeInTheDocument();
  });
});

describe("ApartmentCard badge — billing model", () => {
  // NOTE: native matchers (toBeNull / not.toBeNull) — the worktree vitest run
  // does not register jest-dom's toBeInTheDocument (see the file's other
  // describe blocks, which fail on that matcher in this environment).
  it("renders a 'Subsidy' badge for a PARTITIONED apartment with partitionBillingMode SUBSIDY", () => {
    render(
      wrap(
        <ApartmentCard
          apartment={makeApartment({
            listingMode: "PARTITIONED",
            partitionBillingMode: "SUBSIDY",
          })}
          editApartmentTrigger={<button>Edit</button>}
        />,
      ),
    );
    expect(screen.queryByText("Subsidy")).not.toBeNull();
    expect(screen.queryByText("No subsidy")).toBeNull();
  });

  it("renders a 'No subsidy' badge for a PARTITIONED apartment with partitionBillingMode NO_SUBSIDY", () => {
    render(
      wrap(
        <ApartmentCard
          apartment={makeApartment({
            listingMode: "PARTITIONED",
            partitionBillingMode: "NO_SUBSIDY",
          })}
          editApartmentTrigger={<button>Edit</button>}
        />,
      ),
    );
    expect(screen.queryByText("No subsidy")).not.toBeNull();
    expect(screen.queryByText("Subsidy")).toBeNull();
  });

  it("renders neither billing badge for a WHOLE apartment (billing model is meaningless for whole units)", () => {
    render(
      wrap(
        <ApartmentCard
          apartment={makeApartment({
            listingMode: "WHOLE",
            // Even with a billing mode set, WHOLE must show neither badge.
            partitionBillingMode: "SUBSIDY",
            rooms: [makeApartment().rooms[0]],
          })}
          editApartmentTrigger={<button>Edit</button>}
        />,
      ),
    );
    expect(screen.queryByText("Subsidy")).toBeNull();
    expect(screen.queryByText("No subsidy")).toBeNull();
  });

  it("renders neither billing badge for a PARTITIONED apartment when partitionBillingMode is absent", () => {
    render(
      wrap(
        <ApartmentCard
          apartment={makeApartment({ listingMode: "PARTITIONED" })}
          editApartmentTrigger={<button>Edit</button>}
        />,
      ),
    );
    expect(screen.queryByText("Subsidy")).toBeNull();
    expect(screen.queryByText("No subsidy")).toBeNull();
  });
});

describe("ApartmentCard — owner & tenant names", () => {
  it("links known owner, tenant, and unit records directly to their detail context", () => {
    const apt = makeApartment({
      ownerPartyId: "owner-1",
      ownerName: "Brian Lee",
      listingMode: "WHOLE",
      rooms: [{ id: "unit-1", unitType: "Whole Unit", rentalRate: 3000, occupancyStatus: "occupied", listingStatus: "active", inChargePartyId: null, tenantPartyId: "tenant-1", tenantName: "Noelle Tan" }],
    });
    render(wrap(<ApartmentCard apartment={apt} editApartmentTrigger={<button>Edit</button>} />));
    expect(screen.getByRole("link", { name: "Brian Lee" })).toHaveAttribute("href", "/parties/owners?partyId=owner-1");
    expect(screen.getAllByRole("link", { name: /Noelle Tan/ })[0]).toHaveAttribute("href", "/parties/tenants?partyId=tenant-1");
    expect(screen.getByRole("link", { name: "C-12-34" })).toHaveAttribute("href", "/inventory/units/unit-1");
  });

  it("renders the owner name when present", () => {
    render(wrap(<ApartmentCard apartment={makeApartment({ ownerName: "Alice Tan" })} editApartmentTrigger={<button>Edit</button>} />));
    expect(screen.queryByText(/Alice Tan/)).not.toBeNull();
  });

  it("shows no owner label when ownerName is null", () => {
    // Deviation from brief's verbatim test (documented in task-3-report.md):
    // the brief's single-assertion version passes vacuously on unmodified
    // code (nothing renders "Owner:" yet either way). Adding a positive
    // control via rerender makes the first assertion genuinely RED against
    // the pristine baseline while still proving the null case is gated.
    const { rerender } = render(
      wrap(<ApartmentCard apartment={makeApartment({ ownerName: "Zara Ho" })} editApartmentTrigger={<button>Edit</button>} />),
    );
    expect(screen.queryByText(/Zara Ho/)).not.toBeNull(); // control: renders when present
    rerender(
      wrap(<ApartmentCard apartment={makeApartment({ ownerName: null })} editApartmentTrigger={<button>Edit</button>} />),
    );
    expect(screen.queryByText(/^Owner:/)).toBeNull();
  });

  it("renders the tenant name on an expanded partition room row", () => {
    const apt = makeApartment({
      listingMode: "PARTITIONED",
      rooms: [
        { id: "u-m", unitType: "Master", rentalRate: 1200, occupancyStatus: "occupied", listingStatus: "active", inChargePartyId: null, tenantName: "Bob Lim" },
        { id: "u-s", unitType: "Small", rentalRate: 700, occupancyStatus: "vacant", listingStatus: "active", inChargePartyId: null, tenantName: null },
      ],
    });
    render(wrap(<ApartmentCard apartment={apt} initiallyExpanded editApartmentTrigger={<button>Edit</button>} />));
    expect(screen.queryByText(/Bob Lim/)).not.toBeNull();
  });

  it("renders the whole-unit tenant in the header (collapsed)", () => {
    const apt = makeApartment({
      listingMode: "WHOLE",
      rooms: [{ id: "u-w", unitType: "Whole Unit", rentalRate: 2200, occupancyStatus: "occupied", listingStatus: "active", inChargePartyId: null, tenantName: "Carol Ng" }],
    });
    render(wrap(<ApartmentCard apartment={apt} editApartmentTrigger={<button>Edit</button>} />));
    expect(screen.getAllByText(/Carol Ng/).length).toBeGreaterThan(0);
  });

  it("shows no tenant label for a room without a tenantName", () => {
    // Deviation from brief's verbatim test (documented in task-3-report.md):
    // same vacuous-pass issue as the owner-null test above — a positive
    // control via rerender makes the RED genuine against the pristine
    // baseline while the room stays vacant throughout, proving the gate is
    // tenantName (not occupancyStatus).
    const aptWithTenant = makeApartment({
      listingMode: "PARTITIONED",
      rooms: [{ id: "u-s", unitType: "Small", rentalRate: 700, occupancyStatus: "vacant", listingStatus: "active", inChargePartyId: null, tenantName: "Zed Woo" }],
    });
    const { rerender } = render(wrap(<ApartmentCard apartment={aptWithTenant} initiallyExpanded editApartmentTrigger={<button>Edit</button>} />));
    expect(screen.queryByText(/Zed Woo/)).not.toBeNull(); // control: renders when present
    const aptNoTenant = makeApartment({
      listingMode: "PARTITIONED",
      rooms: [{ id: "u-s", unitType: "Small", rentalRate: 700, occupancyStatus: "vacant", listingStatus: "active", inChargePartyId: null, tenantName: null }],
    });
    rerender(wrap(<ApartmentCard apartment={aptNoTenant} initiallyExpanded editApartmentTrigger={<button>Edit</button>} />));
    expect(screen.queryByText(/^Tenant:/)).toBeNull();
  });
});
