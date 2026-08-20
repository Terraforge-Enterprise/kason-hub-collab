import { useState } from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  PartitionRoomStrip,
  blankRoom,
  duplicateRoomTypes,
  type RoomDraft,
} from "../partition-room-strip";

const options = [
  { id: "2", name: "Master", kind: "PARTITION" as const, sortOrder: 1 },
  { id: "3", name: "Medium", kind: "PARTITION" as const, sortOrder: 2 },
];

// OccupancyFields (rendered once a room is Occupied) fires a react-query
// rent-preview lookup; it's gated on a Phase-2 flag that's off locally, so it
// never actually queries, but the component still needs a QueryClientProvider
// in the tree or the useQuery call throws.
function renderStrip(props: Parameters<typeof PartitionRoomStrip>[0]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <PartitionRoomStrip {...props} />
    </QueryClientProvider>,
  );
}

// Round-trip harness: PartitionRoomStrip is a controlled component (rooms +
// onChange), so exercising a real "user flips a select, the revealed field
// then appears" flow needs a stateful wrapper — a bare render+fireEvent only
// proves onChange was CALLED with the right patch, not that the UI reacts to
// it the way the real dialog (which owns the state) would.
function ControlledStrip({ initialRooms }: { initialRooms: RoomDraft[] }) {
  const [rooms, setRooms] = useState(initialRooms);
  const [activeIndex, setActiveIndex] = useState(0);
  return (
    <PartitionRoomStrip
      rooms={rooms}
      activeIndex={activeIndex}
      onSelect={setActiveIndex}
      onChange={setRooms}
      options={options}
    />
  );
}

function renderControlled(initialRooms: RoomDraft[]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ControlledStrip initialRooms={initialRooms} />
    </QueryClientProvider>,
  );
}

describe("PartitionRoomStrip", () => {
  it("adds a room", () => {
    const onChange = vi.fn();
    const onSelect = vi.fn();
    renderStrip({
      rooms: [blankRoom()],
      activeIndex: 0,
      onSelect,
      onChange,
      options,
    });
    fireEvent.click(screen.getByRole("button", { name: /new room/i }));
    expect(onChange).toHaveBeenCalled();
    expect(onChange.mock.calls[0][0]).toHaveLength(2);
    // acceptance row 1: the new tab "becomes active"
    expect(onSelect).toHaveBeenCalledWith(1);
  });

  it("removes a room (guarded to keep at least one)", () => {
    const rooms = [
      { ...blankRoom(), unitType: "Master" },
      { ...blankRoom(), unitType: "Medium" },
    ];
    const onChange = vi.fn();
    const onSelect = vi.fn();
    renderStrip({
      rooms,
      activeIndex: 1,
      onSelect,
      onChange,
      options,
    });
    fireEvent.click(screen.getByRole("button", { name: /remove room 2/i }));
    // room 2 dropped; only Master remains
    expect(onChange.mock.calls[0][0]).toHaveLength(1);
    expect(onChange.mock.calls[0][0][0].unitType).toBe("Master");
    // active clamps to the surviving room
    expect(onSelect).toHaveBeenCalledWith(0);
  });

  it("does not offer a remove control for a lone room", () => {
    renderStrip({
      rooms: [blankRoom()],
      activeIndex: 0,
      onSelect: vi.fn(),
      onChange: vi.fn(),
      options,
    });
    expect(screen.queryByRole("button", { name: /remove room/i })).toBeNull();
  });

  it("access-card quantity and parking quantity are per-room editable", () => {
    const rooms = [blankRoom(), blankRoom()];
    const onChange = vi.fn();
    renderStrip({
      rooms,
      activeIndex: 1,
      onSelect: vi.fn(),
      onChange,
      options,
    });
    fireEvent.change(
      screen.getByRole("spinbutton", { name: "Access card quantity" }),
      { target: { value: "2" } },
    );
    expect(onChange.mock.calls[0][0][1].accessCardQuantity).toBe("2");
    expect(onChange.mock.calls[0][0][0].accessCardQuantity).toBe("");

    fireEvent.change(
      screen.getByRole("spinbutton", { name: "Parking quantity" }),
      { target: { value: "1" } },
    );
    expect(onChange.mock.calls[1][0][1].parkingQuantity).toBe("1");
  });

  it("access-card deposit is a per-room money field", () => {
    // The card COUNT without the per-card DEPOSIT is meaningless for the
    // deposit computation: batchRoomFields carries accessCardDepositPerPcs and
    // the whole-unit path emits it, so a partition room that can set a card
    // quantity but not its deposit would silently persist RM0 per card.
    expect(blankRoom()).toHaveProperty("accessCardDepositPerPcs", "");
    const rooms = [blankRoom(), blankRoom()];
    const onChange = vi.fn();
    renderStrip({
      rooms,
      activeIndex: 1,
      onSelect: vi.fn(),
      onChange,
      options,
    });
    fireEvent.change(
      screen.getByRole("spinbutton", { name: "RM / piece" }),
      { target: { value: "50" } },
    );
    // routed to the active room only
    expect(onChange.mock.calls[0][0][1].accessCardDepositPerPcs).toBe("50");
    expect(onChange.mock.calls[0][0][0].accessCardDepositPerPcs).toBe("");
  });

  it("per-room fields are independent", () => {
    const rooms = [blankRoom(), blankRoom()];
    const onChange = vi.fn();
    renderStrip({
      rooms,
      activeIndex: 1,
      onSelect: vi.fn(),
      onChange,
      options,
    });
    // FormField labels the wrapping role="group" div (via aria-labelledby),
    // not the input, so getByLabelText resolves to the group and /rent/i also
    // matches "Rental deposit". Query the input directly by role + its
    // aria-label — the rent spinbutton is unique.
    fireEvent.change(screen.getByRole("spinbutton", { name: "Rent (RM/mo)" }), {
      target: { value: "1200" },
    });
    const next = onChange.mock.calls[0][0];
    expect(next[1].rentalRate).toBe("1200");
    expect(next[0].rentalRate).toBe("");
  });

  it("rejects duplicate room types", () => {
    const rooms = [
      { ...blankRoom(), unitType: "Master" },
      { ...blankRoom(), unitType: "Master" },
    ];
    expect(duplicateRoomTypes(rooms)).toEqual(["Master"]);
  });

  it("shows a live RM deposit preview once rent is set (DepositFields reuse)", () => {
    // computeRentalDepositMyr defaults depositMonths to 2 when unset, so
    // rent alone is enough to preview the rental deposit.
    renderStrip({
      rooms: [{ ...blankRoom(), rentalRate: "1200" }],
      activeIndex: 0,
      onSelect: vi.fn(),
      onChange: vi.fn(),
      options,
    });
    expect(screen.getByText("RM2,400")).toBeInTheDocument();
    // Required markers from the shared DepositFields component.
    expect(screen.getByText("Rental deposit (months)")).toBeInTheDocument();
    expect(screen.getByText("Utilities deposit (months)")).toBeInTheDocument();
  });

  it("reveals per-bay parking inputs once quantity > 0 (ParkingFields reuse)", () => {
    renderStrip({
      rooms: [{ ...blankRoom(), parkingQuantity: "2", parkingNumbers: ["", ""] }],
      activeIndex: 0,
      onSelect: vi.fn(),
      onChange: vi.fn(),
      options,
    });
    expect(screen.getByLabelText("Spot 1")).toBeInTheDocument();
    expect(screen.getByLabelText("Spot 2")).toBeInTheDocument();
    expect(screen.queryByLabelText("Spot 3")).toBeNull();
  });

  it("hides per-bay parking inputs when quantity is unset", () => {
    renderStrip({
      rooms: [blankRoom()],
      activeIndex: 0,
      onSelect: vi.fn(),
      onChange: vi.fn(),
      options,
    });
    expect(screen.queryByLabelText("Spot 1")).toBeNull();
  });

  it("defaults a new room to vacant with no tenant picker rendered", () => {
    renderStrip({
      rooms: [blankRoom()],
      activeIndex: 0,
      onSelect: vi.fn(),
      onChange: vi.fn(),
      options,
    });
    expect(
      screen.getByRole("combobox", { name: "Occupancy status" }),
    ).toHaveValue("vacant");
    // OccupancyFields early-returns entirely when not occupied.
    expect(screen.queryByPlaceholderText(/search existing tenants/i)).toBeNull();
    expect(screen.queryByText("Move-in date")).toBeNull();
  });

  it("switching a room to Occupied reveals the tenant picker and move-in/move-out", () => {
    renderControlled([blankRoom()]);

    expect(screen.queryByPlaceholderText(/search existing tenants/i)).toBeNull();

    fireEvent.change(screen.getByRole("combobox", { name: "Occupancy status" }), {
      target: { value: "occupied" },
    });

    // Tenant picker (no tenant selected yet -> TenantSelect typeahead, not
    // the confirm card) and both tenancy dates now render.
    expect(screen.getByPlaceholderText(/search existing tenants/i)).toBeInTheDocument();
    expect(screen.getByText("Move-in date")).toBeInTheDocument();
    expect(screen.getByText("Move-out date")).toBeInTheDocument();
    // showRent is always passed on the create path.
    expect(screen.getByText("Tenancy monthly rent (RM)")).toBeInTheDocument();
  });

  it("flipping back to Vacant hides the tenant/tenancy fields again", () => {
    renderControlled([{ ...blankRoom(), occupancyStatus: "occupied" }]);
    expect(screen.getByPlaceholderText(/search existing tenants/i)).toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox", { name: "Occupancy status" }), {
      target: { value: "vacant" },
    });

    expect(screen.queryByPlaceholderText(/search existing tenants/i)).toBeNull();
  });
});
