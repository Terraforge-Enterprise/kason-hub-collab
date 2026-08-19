// T4 — EditApartmentShell (2026-07-10 inventory-full-edit-and-room-tenant plan).
//
// Pins the behaviour the user asked for: clicking Edit on a partitioned
// apartment shows EVERY sibling room via a tab header, clicking a tab
// switches which room is being edited, and owner + billing model (apartment-
// scoped) render alongside whichever room is active. A single-room (WHOLE)
// apartment shows no tab bar — today's behaviour, unchanged.
//
// FALLBACK approach: the shell mounts the real, unmodified EditUnitForm per
// active tab (see edit-apartment-shell.tsx header comment for why). Owner /
// billing therefore render PER ROOM, not hoisted into a single header — this
// test asserts they are present on whichever room is active, not that they
// render exactly once across the whole dialog.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { describe, it, expect, vi, afterEach } from "vitest";
import { EditApartmentShell } from "../edit-apartment-shell";
import type { UnitRowData, FetchedUnitDetail } from "../edit-unit-dialog";
import type { ApartmentSummary } from "@/api/inventory-units-batch";
import { apiFetch } from "@/lib/api-client";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock("@/lib/api-client", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/api-client")>();
  return { ...actual, apiFetch: vi.fn() };
});

// Task 4 — EditUnitForm now unconditionally mounts SingleUnitMediaPanel, which
// pulls in the real ListingMediaPanel → useMediaLimits() → apiFetch(
// "/listings/media/limits"). This file's apiFetch mock above (plain vi.fn(),
// URL-routed by individual tests) does not handle that URL. Shield it with
// the same stub used in edit-unit-dialog.test.tsx so the real panel never
// mounts here.
vi.mock("../unit-media-step", () => ({
  SingleUnitMediaPanel: (p: { listingId: string }) => (
    <div data-testid="edit-media-panel" data-listing-id={p.listingId} />
  ),
}));

function makeRoomDetail(overrides: Partial<FetchedUnitDetail> = {}): FetchedUnitDetail {
  return {
    id: "r1",
    unitCode: "A-18-06",
    unitType: "Room A",
    bedrooms: 1,
    bathrooms: 1,
    floorArea: 300,
    rentalRate: 1200,
    currency: "MYR",
    occupancyStatus: "vacant",
    listingStatus: "active",
    depositMonths: 1,
    utilitiesDepositMonths: 0.5,
    amenities: [],
    description: "",
    visibilityMode: "PUBLIC",
    hiddenFromPartyIds: [],
    hiddenFromAgentNames: [],
    grantedPartyIds: [],
    grantedAgentNames: [],
    sourceFlag: "COMPANY",
    inChargePartyId: null,
    inChargeName: null,
    sourcingAgentId: null,
    sourcingAgentName: null,
    property: {
      id: "p1",
      name: "The Sky Residences",
      propertyCode: "SKY",
      city: "Kuala Lumpur",
      hasPaxDeduction: false,
      paxDeductionAmount: null,
    },
    ownerPartyId: "owner-1",
    ownerName: "Ahmad Bin Sulaiman",
    ownerPhone: "+60 12-000 0000",
    activeTenancy: null,
    ...overrides,
  };
}

function fixtureApartment(overrides: Partial<ApartmentSummary> = {}): ApartmentSummary {
  return {
    id: "apt-1",
    unitCode: "A-18-06",
    floor: 18,
    bedrooms: 2,
    bathrooms: 2,
    floorArea: 900,
    amenities: [],
    highlights: [],
    description: null,
    rooms: [
      { id: "r1", unitType: "Room A", rentalRate: 1200, occupancyStatus: "vacant", listingStatus: "active", inChargePartyId: null },
      { id: "r2", unitType: "Room B", rentalRate: 1500, occupancyStatus: "occupied", listingStatus: "active", inChargePartyId: null },
    ],
    hasDrift: false,
    listingMode: "PARTITIONED",
    partitionBillingMode: "NO_SUBSIDY",
    ownerPartyId: "owner-1",
    ownerName: "Ahmad Bin Sulaiman",
    ownerPhone: "+60 12-000 0000",
    underManagement: true,
    ...overrides,
  };
}

const unitRow: UnitRowData = {
  id: "r1",
  propertyName: "The Sky Residences",
  unitCode: "A-18-06",
};

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
}

function installRoutedMock(apartment: ApartmentSummary, rooms: Record<string, FetchedUnitDetail>) {
  vi.mocked(apiFetch).mockImplementation((url: string) => {
    if (typeof url === "string" && url.startsWith("/inventory/amenities")) {
      return Promise.resolve({ data: [] });
    }
    if (typeof url === "string" && url.startsWith("/commissions/room-types")) {
      return Promise.resolve({ data: [] });
    }
    if (typeof url === "string" && url.startsWith("/parties/tenants/search")) {
      return Promise.resolve({ data: [] });
    }
    if (typeof url === "string" && url.startsWith("/parties/owners/search")) {
      return Promise.resolve({ data: [] });
    }
    if (typeof url === "string" && url.startsWith("/inventory/apartments/by-property/")) {
      return Promise.resolve({ data: [apartment] });
    }
    const match = typeof url === "string" && url.match(/^\/inventory\/units\/(.+)$/);
    if (match && rooms[match[1]]) {
      return Promise.resolve({ data: rooms[match[1]] });
    }
    return Promise.reject(new Error(`unmocked url: ${String(url)}`));
  });
}

describe("EditApartmentShell — room tabs (T4)", () => {
  afterEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it("renders a tab per sibling room and clicking a tab switches the edited room", async () => {
    const user = userEvent.setup();
    installRoutedMock(fixtureApartment(), {
      r1: makeRoomDetail({ id: "r1", unitType: "Room A", rentalRate: 1200 }),
      r2: makeRoomDetail({ id: "r2", unitType: "Room B", rentalRate: 1500, occupancyStatus: "occupied" }),
    });

    render(
      wrap(
        <EditApartmentShell unit={unitRow} trigger={<button>Edit unit</button>} />,
      ),
    );

    await user.click(screen.getByRole("button", { name: "Edit unit" }));

    // Tab header lists BOTH sibling rooms.
    const tablist = await screen.findByRole("tablist", { name: /rooms in this apartment/i });
    expect(tablist).toBeInTheDocument();
    const roomATab = screen.getByRole("tab", { name: /room a/i });
    const roomBTab = screen.getByRole("tab", { name: /room b/i });
    expect(roomATab).toBeInTheDocument();
    expect(roomBTab).toBeInTheDocument();
    expect(roomATab).toHaveAttribute("aria-selected", "true");
    expect(roomBTab).toHaveAttribute("aria-selected", "false");

    // Room A (the clicked unit) is active by default — its rent shows.
    expect(await screen.findByDisplayValue("1200")).toBeInTheDocument();

    // Switch to Room B's tab — its rent replaces Room A's in the DOM (a fresh
    // EditUnitForm mount, keyed by the new active room id). The tab header
    // itself briefly unmounts/remounts while the newly-active room's detail
    // fetch is in flight (the shell's loading skeleton), so re-query the tab
    // elements fresh afterwards rather than reusing the pre-click references.
    await user.click(roomBTab);
    await waitFor(() => expect(screen.getByDisplayValue("1500")).toBeInTheDocument());
    expect(screen.queryByDisplayValue("1200")).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /room b/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: /room a/i })).toHaveAttribute("aria-selected", "false");

    // The per-unit GET fired for both rooms (r1 from the initial mount, r2
    // once the tab was selected) — proves each tab drives the same real
    // detail fetch, not a fabricated view.
    expect(apiFetch).toHaveBeenCalledWith("/inventory/units/r1");
    expect(apiFetch).toHaveBeenCalledWith("/inventory/units/r2");
  });

  it("renders owner + billing model on the active room's tab", async () => {
    const user = userEvent.setup();
    installRoutedMock(fixtureApartment(), {
      r1: makeRoomDetail({ id: "r1", unitType: "Room A", rentalRate: 1200 }),
      r2: makeRoomDetail({ id: "r2", unitType: "Room B", rentalRate: 1500 }),
    });

    render(wrap(<EditApartmentShell unit={unitRow} trigger={<button>Edit unit</button>} />));
    await user.click(screen.getByRole("button", { name: "Edit unit" }));

    expect(await screen.findByText("Ahmad Bin Sulaiman")).toBeInTheDocument();
    expect(screen.getByText("Billing model")).toBeInTheDocument();

    // Switching tabs keeps owner + billing visible (rendered per-room under
    // FALLBACK — see file header comment for why this isn't hoisted).
    await user.click(screen.getByRole("tab", { name: /room b/i }));
    await waitFor(() => expect(screen.getByDisplayValue("1500")).toBeInTheDocument());
    expect(screen.getByText("Ahmad Bin Sulaiman")).toBeInTheDocument();
    expect(screen.getByText("Billing model")).toBeInTheDocument();
  });

  it("shows no tab bar for a single-room (WHOLE) apartment", async () => {
    const user = userEvent.setup();
    installRoutedMock(
      fixtureApartment({
        listingMode: "WHOLE",
        rooms: [
          { id: "r1", unitType: "Studio", rentalRate: 2200, occupancyStatus: "vacant", listingStatus: "active", inChargePartyId: null },
        ],
      }),
      { r1: makeRoomDetail({ id: "r1", unitType: "Studio", rentalRate: 2200 }) },
    );

    render(wrap(<EditApartmentShell unit={unitRow} trigger={<button>Edit unit</button>} />));
    await user.click(screen.getByRole("button", { name: "Edit unit" }));

    expect(await screen.findByDisplayValue("2200")).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  });

  it("degrades gracefully (single implicit room, no crash) when no apartment match is found", async () => {
    const user = userEvent.setup();
    // apartments-by-property resolves to an empty list — no apartment shares
    // this unit's code (degraded case EditUnitDialog already tolerated via
    // apartment=null).
    installRoutedMock(
      fixtureApartment({ unitCode: "SOME-OTHER-CODE", rooms: [] }),
      { r1: makeRoomDetail({ id: "r1" }) },
    );
    vi.mocked(apiFetch).mockImplementation((url: string) => {
      if (typeof url === "string" && url.startsWith("/inventory/apartments/by-property/")) {
        return Promise.resolve({ data: [] });
      }
      if (typeof url === "string" && url.startsWith("/inventory/amenities")) return Promise.resolve({ data: [] });
      if (typeof url === "string" && url.startsWith("/commissions/room-types")) return Promise.resolve({ data: [] });
      if (typeof url === "string" && url.startsWith("/parties/tenants/search")) return Promise.resolve({ data: [] });
      if (url === "/inventory/units/r1") return Promise.resolve({ data: makeRoomDetail({ id: "r1" }) });
      return Promise.reject(new Error(`unmocked url: ${String(url)}`));
    });

    render(wrap(<EditApartmentShell unit={unitRow} trigger={<button>Edit unit</button>} />));
    await user.click(screen.getByRole("button", { name: "Edit unit" }));

    expect(await screen.findByDisplayValue("1200")).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  });
});
