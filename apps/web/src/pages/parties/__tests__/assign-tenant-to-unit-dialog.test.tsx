import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test, vi, beforeEach } from "vitest";
import { apiFetch, ApiError } from "@/lib/api-client";
import { getApartmentsByProperty } from "@/api/inventory-units-batch";
import { AssignTenantToUnitDialog } from "../assign-tenant-to-unit-dialog";

vi.mock("@/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-client")>();
  return { ...actual, apiFetch: vi.fn() };
});
vi.mock("@/api/inventory-units-batch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/inventory-units-batch")>();
  return { ...actual, getApartmentsByProperty: vi.fn() };
});
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const tenant = { id: "tenant-1", displayName: "Daniel Tan" } as const;

function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
}

const wrap = (ui: React.ReactNode, client = makeClient()) =>
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);

const PROPERTY_LIST_OK = {
  data: [
    { id: "prop-1", name: "Sunway", propertyCode: "SW", propertyType: "condo", status: "active", unitCount: 1, occupiedUnits: 0 },
  ],
};

const apt = (over: Partial<import("@/api/inventory-units-batch").ApartmentSummary> = {}) => ({
  id: "apt-1",
  unitCode: "A-1",
  floor: null,
  bedrooms: null,
  bathrooms: null,
  floorArea: null,
  amenities: [],
  highlights: [],
  description: null,
  rooms: [],
  hasDrift: false,
  listingMode: null,
  ownerPartyId: "owner-1",
  ownerName: "Owner",
  ownerPhone: null,
  underManagement: true,
  ...over,
});

const room = (over: Partial<import("@/api/inventory-units-batch").ApartmentRoomSummary> = {}) => ({
  id: "unit-1",
  unitType: "Studio",
  rentalRate: 1000,
  occupancyStatus: "vacant",
  listingStatus: "active",
  inChargePartyId: null,
  ...over,
});

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  vi.mocked(getApartmentsByProperty).mockReset();
  vi.mocked(apiFetch).mockResolvedValue(PROPERTY_LIST_OK);
});

async function openAndPickProperty(user: ReturnType<typeof userEvent.setup>) {
  wrap(<AssignTenantToUnitDialog tenant={tenant} open onOpenChange={() => {}} />);
  // Wait for the property list to actually load (option populated) — the
  // select renders immediately but stays disabled until propertiesQuery
  // settles, so findByLabelText alone resolves too early.
  await screen.findByRole("option", { name: /Sunway/i });
  await user.selectOptions(screen.getByLabelText(/property/i), "prop-1");
}

async function fillTenancyFields(user: ReturnType<typeof userEvent.setup>, unitId = "unit-ok") {
  await user.selectOptions(await screen.findByLabelText(/^unit$/i), unitId);
  // No tenancy-code step: the field is gone, the server generates the code.
  fireEvent.change(screen.getByLabelText(/monthly rent/i), { target: { value: "1500" } });
  fireEvent.change(screen.getByLabelText(/start date/i), { target: { value: "2026-08-01" } });
}

// B1 — happy
test("picker lists only vacant owned units", async () => {
  vi.mocked(getApartmentsByProperty).mockResolvedValue([
    apt({ ownerPartyId: "owner-1", rooms: [room({ id: "unit-ok" })] }),
    apt({ id: "apt-2", ownerPartyId: null, rooms: [room({ id: "unit-noowner" })] }),
  ]);
  const user = userEvent.setup();
  await openAndPickProperty(user);
  expect(await screen.findByRole("option", { name: /A-1/ })).toBeInTheDocument();
  expect(screen.queryByRole("option", { name: /unit-noowner/i })).not.toBeInTheDocument();
});

// B2 — edge. Regression: `listingStatus` gates MARKETPLACE PUBLICATION (agent
// visibility), not tenantability. Every room is born `draft`
// (inventory.service.ts:958) and createTenancyService enforces no
// listingStatus guard at all — so filtering the picker on `active` made a
// never-published unit permanently unassignable, which is the normal state
// right after creating one. Draft rooms MUST be pickable.
test("includes draft-status rooms — draft gates publication, not tenantability", async () => {
  vi.mocked(getApartmentsByProperty).mockResolvedValue([
    apt({ ownerPartyId: "owner-1", rooms: [room({ id: "unit-draft", listingStatus: "draft" })] }),
  ]);
  const user = userEvent.setup();
  await openAndPickProperty(user);
  expect(await screen.findByRole("option", { name: /A-1/ })).toBeInTheDocument();
  expect(screen.queryByText(/no vacant, owned units/i)).not.toBeInTheDocument();
});

// B2b — edge. The two conditions that DO mirror real server guards stay:
// occupied → UNIT_HAS_ACTIVE_TENANCY, ownerless → UNIT_HAS_NO_OWNER.
test("still excludes occupied rooms and ownerless apartments", async () => {
  vi.mocked(getApartmentsByProperty).mockResolvedValue([
    apt({ ownerPartyId: "owner-1", rooms: [room({ id: "unit-busy", occupancyStatus: "occupied" })] }),
    apt({ id: "apt-2", ownerPartyId: null, rooms: [room({ id: "unit-noowner" })] }),
  ]);
  const user = userEvent.setup();
  await openAndPickProperty(user);
  expect(await screen.findByText(/no vacant, owned units/i)).toBeInTheDocument();
});

// B3 — edge
test("empty state when no pickable units", async () => {
  vi.mocked(getApartmentsByProperty).mockResolvedValue([
    apt({ ownerPartyId: null, rooms: [room({ id: "unit-x" })] }),
  ]);
  const user = userEvent.setup();
  await openAndPickProperty(user);
  expect(await screen.findByText(/no vacant, owned units/i)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /assign/i })).toBeDisabled();
});

// B4 — happy
test("submits correct payload", async () => {
  vi.mocked(getApartmentsByProperty).mockResolvedValue([apt({ rooms: [room({ id: "unit-ok" })] })]);
  const user = userEvent.setup();
  await openAndPickProperty(user);
  await fillTenancyFields(user);
  await user.click(screen.getByRole("button", { name: /assign/i }));
  await waitFor(() => {
    const call = vi.mocked(apiFetch).mock.calls.find(
      ([u, o]) =>
        u === "/tenancy/tenancies" && (o as RequestInit | undefined)?.method === "POST",
    );
    expect(call).toBeTruthy();
    const body = JSON.parse((call![1] as RequestInit).body as string);
    expect(body.tenantPartyId).toBe("tenant-1");
    expect(body.unitId).toBe("unit-ok");
    expect(body.propertyId).toBe("prop-1");
    expect(body.monthlyRentAmount).toBe("1500");
    // Omitted, not blank: absence is what tells createTenancyService to mint
    // TEN-{year}-NNNN. An empty string would be a hard schema rejection.
    expect(body).not.toHaveProperty("tenancyCode");
    expect(body.startDate).toBe("2026-08-01");
    expect(body).not.toHaveProperty("reservationId");
    expect(body).not.toHaveProperty("overwrite");
    expect(body).not.toHaveProperty("carparks");
  });
});

// B5 — error
test("409 unit-state code surfaces on picker", async () => {
  vi.mocked(getApartmentsByProperty).mockResolvedValue([apt({ rooms: [room({ id: "unit-ok" })] })]);
  vi.mocked(apiFetch).mockImplementation((u: string) =>
    u === "/tenancy/tenancies"
      ? Promise.reject(new ApiError("Unit already occupied", 409, "UNIT_HAS_ACTIVE_TENANCY", { code: "UNIT_HAS_ACTIVE_TENANCY" }))
      : Promise.resolve(PROPERTY_LIST_OK),
  );
  const user = userEvent.setup();
  await openAndPickProperty(user);
  await fillTenancyFields(user);
  await user.click(screen.getByRole("button", { name: /assign/i }));
  // Field-precise: the error must render INSIDE the "Unit" field, not in the
  // generic banner — presence-only assertions can't catch an inverted
  // discrimination branch (money constraint: coded 409 → unit picker).
  const unitLabel = screen.getByText("Unit").closest("label");
  if (!unitLabel) throw new Error("Unit field label not found");
  expect(await within(unitLabel).findByText(/already occupied/i)).toBeInTheDocument();
  expect(screen.queryByText(/Couldn't assign to unit/)).not.toBeInTheDocument();
});

// B18 — error (money) — the P2002 unique-index race backstop
// (apps/api/src/modules/tenancy/tenancy-p2002.ts) emits a THIRD unit-occupancy
// 409, CONCURRENT_ACTIVE_TENANCY, distinct from UNIT_HAS_NO_OWNER /
// UNIT_HAS_ACTIVE_TENANCY. It is a unit-state conflict too, so it must route
// to the unit picker, not the tenancy-code field.
test("409 CONCURRENT_ACTIVE_TENANCY surfaces on picker, not the code field", async () => {
  vi.mocked(getApartmentsByProperty).mockResolvedValue([apt({ rooms: [room({ id: "unit-ok" })] })]);
  vi.mocked(apiFetch).mockImplementation((u: string) =>
    u === "/tenancy/tenancies"
      ? Promise.reject(new ApiError("Another tenancy claimed this unit just now", 409, "CONCURRENT_ACTIVE_TENANCY", { code: "CONCURRENT_ACTIVE_TENANCY" }))
      : Promise.resolve(PROPERTY_LIST_OK),
  );
  const user = userEvent.setup();
  await openAndPickProperty(user);
  await fillTenancyFields(user);
  await user.click(screen.getByRole("button", { name: /assign/i }));
  // Field-precise: the error must render INSIDE the "Unit" field, not in the
  // generic banner — presence-only assertions can't catch an inverted
  // discrimination branch (money constraint: coded 409 → unit picker).
  const unitLabel = screen.getByText("Unit").closest("label");
  if (!unitLabel) throw new Error("Unit field label not found");
  expect(await within(unitLabel).findByText(/claimed this unit/i)).toBeInTheDocument();
  expect(screen.queryByText(/Couldn't assign to unit/)).not.toBeInTheDocument();
});

// B6 — error. The tenancy code is server-generated and has no field, so the
// uncoded 409 (TENANCY_CODE_TAKEN — the unique-index backstop on the
// generator's read-then-write) must land in the banner. It must NOT be
// mislabelled onto the unit picker: the unit is fine, the retry is what fixes it.
test("code-less 409 surfaces in the banner, not the unit picker", async () => {
  vi.mocked(getApartmentsByProperty).mockResolvedValue([apt({ rooms: [room({ id: "unit-ok" })] })]);
  vi.mocked(apiFetch).mockImplementation((u: string) =>
    u === "/tenancy/tenancies"
      ? Promise.reject(new ApiError("Tenancy code already exists", 409, undefined, { error: "Tenancy code already exists" }))
      : Promise.resolve(PROPERTY_LIST_OK),
  );
  const user = userEvent.setup();
  await openAndPickProperty(user);
  await fillTenancyFields(user);
  await user.click(screen.getByRole("button", { name: /assign/i }));
  expect(await screen.findByText(/Couldn't assign to unit/)).toBeInTheDocument();
  expect(screen.getByText(/already exists/i)).toBeInTheDocument();
  const unitLabel = screen.getByText("Unit").closest("label");
  if (!unitLabel) throw new Error("Unit field label not found");
  expect(within(unitLabel).queryByText(/already exists/i)).not.toBeInTheDocument();
});

// B7 — boundary
test("submit disabled until required fields are filled", async () => {
  vi.mocked(getApartmentsByProperty).mockResolvedValue([apt({ rooms: [room({ id: "unit-ok" })] })]);
  const user = userEvent.setup();
  await openAndPickProperty(user);
  expect(screen.getByRole("button", { name: /assign/i })).toBeDisabled();
  await user.selectOptions(await screen.findByLabelText(/^unit$/i), "unit-ok");
  expect(screen.getByRole("button", { name: /assign/i })).toBeDisabled();
  fireEvent.change(screen.getByLabelText(/monthly rent/i), { target: { value: "1500" } });
  expect(screen.getByRole("button", { name: /assign/i })).toBeDisabled();
  fireEvent.change(screen.getByLabelText(/start date/i), { target: { value: "2026-08-01" } });
  expect(screen.getByRole("button", { name: /assign/i })).toBeEnabled();
});

// B8 — error
test("shows retry on apartments load failure", async () => {
  vi.mocked(getApartmentsByProperty).mockRejectedValueOnce(new Error("network down"));
  vi.mocked(getApartmentsByProperty).mockResolvedValue([apt({ rooms: [room({ id: "unit-ok" })] })]);
  const user = userEvent.setup();
  await openAndPickProperty(user);
  expect(await screen.findByText(/couldn't load units/i)).toBeInTheDocument();
  const retry = screen.getByRole("button", { name: /retry/i });
  await user.click(retry);
  await waitFor(() => expect(getApartmentsByProperty).toHaveBeenCalledTimes(2));
});

// B9 — concurrency-idempotency
test("disables submit while the request is in flight", async () => {
  vi.mocked(getApartmentsByProperty).mockResolvedValue([apt({ rooms: [room({ id: "unit-ok" })] })]);
  let resolvePost: (v: unknown) => void = () => {};
  vi.mocked(apiFetch).mockImplementation((u: string) =>
    u === "/tenancy/tenancies"
      ? new Promise((res) => { resolvePost = res; })
      : Promise.resolve(PROPERTY_LIST_OK),
  );
  const user = userEvent.setup();
  await openAndPickProperty(user);
  await fillTenancyFields(user);
  const btn = screen.getByRole("button", { name: /assign/i });
  await user.click(btn);
  await waitFor(() => expect(screen.getByRole("button", { name: /assign/i })).toBeDisabled());
  // Flush the pending mutation inside act() so the subsequent onSuccess
  // state updates (resetAll/onOpenChange/toast) settle before the test ends —
  // an un-awaited resolve here trips a "not wrapped in act(...)" warning.
  resolvePost({});
  await waitFor(() => expect(screen.getByRole("button", { name: /assign/i })).toHaveTextContent("Assign"));
});

// B10 — permission
test("surfaces 403 as a permission banner", async () => {
  vi.mocked(getApartmentsByProperty).mockResolvedValue([apt({ rooms: [room({ id: "unit-ok" })] })]);
  vi.mocked(apiFetch).mockImplementation((u: string) =>
    u === "/tenancy/tenancies"
      ? Promise.reject(new ApiError("You don't have permission to do that.", 403, undefined, {}))
      : Promise.resolve(PROPERTY_LIST_OK),
  );
  const user = userEvent.setup();
  await openAndPickProperty(user);
  await fillTenancyFields(user);
  await user.click(screen.getByRole("button", { name: /assign/i }));
  expect(await screen.findByText(/don't have permission/i)).toBeInTheDocument();
});

// B12 — edge
test("clears the picked unit when the property changes", async () => {
  vi.mocked(getApartmentsByProperty).mockImplementation((propertyId: string) =>
    Promise.resolve(
      propertyId === "prop-1"
        ? [apt({ id: "apt-1", unitCode: "A-1", rooms: [room({ id: "unit-ok" })] })]
        : [apt({ id: "apt-2", unitCode: "B-2", rooms: [room({ id: "unit-other" })] })],
    ),
  );
  vi.mocked(apiFetch).mockResolvedValue({
    data: [
      { id: "prop-1", name: "Sunway", propertyCode: "SW", propertyType: "c", status: "active", unitCount: 1, occupiedUnits: 0 },
      { id: "prop-2", name: "Mont", propertyCode: "MT", propertyType: "c", status: "active", unitCount: 1, occupiedUnits: 0 },
    ],
  });
  const user = userEvent.setup();
  wrap(<AssignTenantToUnitDialog tenant={tenant} open onOpenChange={() => {}} />);
  await screen.findByRole("option", { name: /Sunway/i });
  await user.selectOptions(screen.getByLabelText(/property/i), "prop-1");
  await user.selectOptions(await screen.findByLabelText(/^unit$/i), "unit-ok");
  await user.selectOptions(screen.getByLabelText(/property/i), "prop-2");
  await waitFor(() => expect(screen.queryByRole("option", { name: /A-1/ })).not.toBeInTheDocument());
  const unitSelect = (await screen.findByLabelText(/^unit$/i)) as HTMLSelectElement;
  expect(unitSelect.value).toBe("");
});

// B13 — error
test("surfaces 400 field errors inline", async () => {
  vi.mocked(getApartmentsByProperty).mockResolvedValue([apt({ rooms: [room({ id: "unit-ok" })] })]);
  vi.mocked(apiFetch).mockImplementation((u: string) =>
    u === "/tenancy/tenancies"
      ? Promise.reject(
          new ApiError("Bad request. Please check the form and try again.", 400, undefined, {
            fieldErrors: { monthlyRentAmount: "Must be a positive number" },
          }),
        )
      : Promise.resolve(PROPERTY_LIST_OK),
  );
  const user = userEvent.setup();
  await openAndPickProperty(user);
  await fillTenancyFields(user);
  await user.click(screen.getByRole("button", { name: /assign/i }));
  expect(await screen.findByText(/must be a positive number/i)).toBeInTheDocument();
});

// B14 — error
test("shows an error when the property list fails to load", async () => {
  vi.mocked(apiFetch).mockRejectedValueOnce(new ApiError("Server error.", 500, undefined, {}));
  wrap(<AssignTenantToUnitDialog tenant={tenant} open onOpenChange={() => {}} />);
  expect(await screen.findByText(/couldn't load properties/i)).toBeInTheDocument();
});

// B15 — edge
test("filters per-room within a single apartment", async () => {
  vi.mocked(getApartmentsByProperty).mockResolvedValue([
    apt({
      rooms: [
        room({ id: "unit-eligible", unitType: "Eligible-Studio" }),
        room({ id: "unit-ineligible", unitType: "Ineligible-Studio", occupancyStatus: "occupied" }),
      ],
    }),
  ]);
  const user = userEvent.setup();
  await openAndPickProperty(user);
  expect(await screen.findByRole("option", { name: /Eligible-Studio/ })).toBeInTheDocument();
  expect(screen.queryByRole("option", { name: /Ineligible-Studio/ })).not.toBeInTheDocument();
});

// B16 — happy
test("invalidates caches and closes on success", async () => {
  vi.mocked(getApartmentsByProperty).mockResolvedValue([apt({ rooms: [room({ id: "unit-ok" })] })]);
  vi.mocked(apiFetch).mockImplementation((u: string) =>
    u === "/tenancy/tenancies" ? Promise.resolve({ data: { id: "tenancy-1" } }) : Promise.resolve(PROPERTY_LIST_OK),
  );
  const client = makeClient();
  const invalidateSpy = vi.spyOn(client, "invalidateQueries");
  const onOpenChange = vi.fn();
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={client}>
      <AssignTenantToUnitDialog tenant={tenant} open onOpenChange={onOpenChange} />
    </QueryClientProvider>,
  );
  await screen.findByRole("option", { name: /Sunway/i });
  await user.selectOptions(screen.getByLabelText(/property/i), "prop-1");
  await fillTenancyFields(user);
  await user.click(screen.getByRole("button", { name: /assign/i }));
  await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  const invalidatedKeys = invalidateSpy.mock.calls.map((c) => (c[0] as { queryKey: unknown[] }).queryKey[0]);
  expect(invalidatedKeys).toEqual(expect.arrayContaining(["tenancy", "tenants", "inventory"]));
});

// B17 — error
test("shows a generic banner for a non-ApiError failure", async () => {
  vi.mocked(getApartmentsByProperty).mockResolvedValue([apt({ rooms: [room({ id: "unit-ok" })] })]);
  vi.mocked(apiFetch).mockImplementation((u: string) =>
    u === "/tenancy/tenancies" ? Promise.reject(new TypeError("Failed to fetch")) : Promise.resolve(PROPERTY_LIST_OK),
  );
  const user = userEvent.setup();
  await openAndPickProperty(user);
  await fillTenancyFields(user);
  await user.click(screen.getByRole("button", { name: /assign/i }));
  expect(await screen.findByText(/failed to fetch/i)).toBeInTheDocument();
});
