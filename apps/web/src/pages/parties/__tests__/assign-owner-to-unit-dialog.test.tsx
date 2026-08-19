import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test, vi, beforeEach } from "vitest";
import { apiFetch, ApiError } from "@/lib/api-client";
import { getApartmentsByProperty, updateApartmentShared } from "@/api/inventory-units-batch";
import { AssignOwnerToUnitDialog } from "../assign-owner-to-unit-dialog";

vi.mock("@/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-client")>();
  return { ...actual, apiFetch: vi.fn() };
});
vi.mock("@/api/inventory-units-batch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/inventory-units-batch")>();
  return { ...actual, getApartmentsByProperty: vi.fn(), updateApartmentShared: vi.fn() };
});
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const owner = { id: "owner-9", displayName: "Apex Holdings" } as const;

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

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  vi.mocked(getApartmentsByProperty).mockReset();
  vi.mocked(updateApartmentShared).mockReset();
  vi.mocked(apiFetch).mockResolvedValue(PROPERTY_LIST_OK);
});

async function openAndPickApartment(
  user: ReturnType<typeof userEvent.setup>,
  apartmentId = "apt-1",
) {
  wrap(<AssignOwnerToUnitDialog owner={owner} open onOpenChange={() => {}} />);
  await screen.findByRole("option", { name: /Sunway/i });
  await user.selectOptions(screen.getByLabelText(/property/i), "prop-1");
  await user.selectOptions(await screen.findByLabelText(/apartment/i), apartmentId);
}

// B1 — happy
test("apartment picker populates (not owner-filtered)", async () => {
  vi.mocked(getApartmentsByProperty).mockResolvedValue([
    apt({ id: "apt-1", unitCode: "A-1", ownerPartyId: "owner-1" }),
    apt({ id: "apt-2", unitCode: "B-2", ownerPartyId: null }), // ownerless — still listed, R5 is not owner-filtered
  ]);
  const user = userEvent.setup();
  wrap(<AssignOwnerToUnitDialog owner={owner} open onOpenChange={() => {}} />);
  await screen.findByRole("option", { name: /Sunway/i });
  await user.selectOptions(screen.getByLabelText(/property/i), "prop-1");
  expect(await screen.findByRole("option", { name: /A-1/ })).toBeInTheDocument();
  expect(await screen.findByRole("option", { name: /B-2/ })).toBeInTheDocument();
});

// B2 — happy/money — the core safety property
test("shows R6 confirm copy, no call before confirm", async () => {
  vi.mocked(getApartmentsByProperty).mockResolvedValue([apt({ id: "apt-1", unitCode: "A-1" })]);
  const user = userEvent.setup();
  await openAndPickApartment(user);
  await user.click(screen.getByRole("button", { name: /assign to unit/i }));
  expect(screen.getByText(/re-point this apartment's owner\?/i)).toBeInTheDocument();
  expect(screen.getByText(/every room in this apartment/i)).toBeInTheDocument();
  expect(screen.getByText(/every active carpark bay/i)).toBeInTheDocument();
  expect(screen.getByText(/re-materialises/i)).toBeInTheDocument();
  expect(screen.getByText(owner.displayName)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /re-point owner/i })).toBeInTheDocument();
  expect(vi.mocked(updateApartmentShared)).not.toHaveBeenCalled();
});

// B3 — error/safety
test("cancel makes no network call", async () => {
  vi.mocked(getApartmentsByProperty).mockResolvedValue([apt({ id: "apt-1", unitCode: "A-1" })]);
  const user = userEvent.setup();
  await openAndPickApartment(user);
  await user.click(screen.getByRole("button", { name: /assign to unit/i }));
  expect(screen.getByText(/re-point this apartment's owner\?/i)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: /cancel/i }));
  expect(vi.mocked(updateApartmentShared)).not.toHaveBeenCalled();
  // returns to the picker — confirm copy is gone, dialog is still open
  expect(screen.queryByText(/re-point this apartment's owner\?/i)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /assign to unit/i })).toBeInTheDocument();
});

// B4 — happy/money
test("confirm sends only ownerPartyId", async () => {
  vi.mocked(getApartmentsByProperty).mockResolvedValue([apt({ id: "apt-1", unitCode: "A-1" })]);
  vi.mocked(updateApartmentShared).mockResolvedValue({ data: { id: "apt-1" } });
  const user = userEvent.setup();
  await openAndPickApartment(user);
  await user.click(screen.getByRole("button", { name: /assign to unit/i }));
  await user.click(screen.getByRole("button", { name: /re-point owner/i }));
  await waitFor(() => {
    expect(vi.mocked(updateApartmentShared)).toHaveBeenCalledWith("apt-1", { ownerPartyId: "owner-9" });
  });
  expect(vi.mocked(updateApartmentShared)).toHaveBeenCalledTimes(1);
});

// B5 — error
test("surfaces 400 not-owner", async () => {
  vi.mocked(getApartmentsByProperty).mockResolvedValue([apt({ id: "apt-1", unitCode: "A-1" })]);
  vi.mocked(updateApartmentShared).mockRejectedValue(
    new ApiError("Assigned party is not an owner", 400, undefined, { error: "Assigned party is not an owner" }),
  );
  const user = userEvent.setup();
  await openAndPickApartment(user);
  await user.click(screen.getByRole("button", { name: /assign to unit/i }));
  await user.click(screen.getByRole("button", { name: /re-point owner/i }));
  expect(await screen.findByText(/assigned party is not an owner/i)).toBeInTheDocument();
  // confirm closes back to the picker; dialog stays open
  expect(screen.queryByText(/re-point this apartment's owner\?/i)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /assign to unit/i })).toBeInTheDocument();
});

// B6 — permission
test("surfaces 403", async () => {
  vi.mocked(getApartmentsByProperty).mockResolvedValue([apt({ id: "apt-1", unitCode: "A-1" })]);
  vi.mocked(updateApartmentShared).mockRejectedValue(
    new ApiError("You don't have permission to do that.", 403, undefined, {}),
  );
  const user = userEvent.setup();
  await openAndPickApartment(user);
  await user.click(screen.getByRole("button", { name: /assign to unit/i }));
  await user.click(screen.getByRole("button", { name: /re-point owner/i }));
  expect(await screen.findByText(/don't have permission/i)).toBeInTheDocument();
});

// B7 — boundary
test("disabled until apartment picked", async () => {
  vi.mocked(getApartmentsByProperty).mockResolvedValue([apt({ id: "apt-1", unitCode: "A-1" })]);
  const user = userEvent.setup();
  wrap(<AssignOwnerToUnitDialog owner={owner} open onOpenChange={() => {}} />);
  await screen.findByRole("option", { name: /Sunway/i });
  expect(screen.getByRole("button", { name: /assign to unit/i })).toBeDisabled();
  await user.selectOptions(screen.getByLabelText(/property/i), "prop-1");
  expect(screen.getByRole("button", { name: /assign to unit/i })).toBeDisabled();
  await user.selectOptions(await screen.findByLabelText(/apartment/i), "apt-1");
  expect(screen.getByRole("button", { name: /assign to unit/i })).toBeEnabled();
});

// B8 — edge
test("empty state when no apartments in property", async () => {
  vi.mocked(getApartmentsByProperty).mockResolvedValue([]);
  const user = userEvent.setup();
  wrap(<AssignOwnerToUnitDialog owner={owner} open onOpenChange={() => {}} />);
  await screen.findByRole("option", { name: /Sunway/i });
  await user.selectOptions(screen.getByLabelText(/property/i), "prop-1");
  expect(await screen.findByText(/no apartments in this property/i)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /assign to unit/i })).toBeDisabled();
});

// B9 — error
test("shows an error when the property list fails to load", async () => {
  vi.mocked(apiFetch).mockRejectedValueOnce(new ApiError("Server error.", 500, undefined, {}));
  wrap(<AssignOwnerToUnitDialog owner={owner} open onOpenChange={() => {}} />);
  expect(await screen.findByText(/couldn't load properties/i)).toBeInTheDocument();
});

// B10 — error
test("shows retry on apartment load failure", async () => {
  vi.mocked(getApartmentsByProperty).mockRejectedValueOnce(new Error("network down"));
  vi.mocked(getApartmentsByProperty).mockResolvedValue([apt({ id: "apt-1", unitCode: "A-1" })]);
  const user = userEvent.setup();
  wrap(<AssignOwnerToUnitDialog owner={owner} open onOpenChange={() => {}} />);
  await screen.findByRole("option", { name: /Sunway/i });
  await user.selectOptions(screen.getByLabelText(/property/i), "prop-1");
  expect(await screen.findByText(/couldn't load apartments/i)).toBeInTheDocument();
  const retry = screen.getByRole("button", { name: /retry/i });
  await user.click(retry);
  await waitFor(() => expect(getApartmentsByProperty).toHaveBeenCalledTimes(2));
});

// B11 — happy
test("invalidates caches and closes on success", async () => {
  vi.mocked(getApartmentsByProperty).mockResolvedValue([apt({ id: "apt-1", unitCode: "A-1" })]);
  vi.mocked(updateApartmentShared).mockResolvedValue({ data: { id: "apt-1" } });
  const client = makeClient();
  const invalidateSpy = vi.spyOn(client, "invalidateQueries");
  const onOpenChange = vi.fn();
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={client}>
      <AssignOwnerToUnitDialog owner={owner} open onOpenChange={onOpenChange} />
    </QueryClientProvider>,
  );
  await screen.findByRole("option", { name: /Sunway/i });
  await user.selectOptions(screen.getByLabelText(/property/i), "prop-1");
  await user.selectOptions(await screen.findByLabelText(/apartment/i), "apt-1");
  await user.click(screen.getByRole("button", { name: /assign to unit/i }));
  await user.click(screen.getByRole("button", { name: /re-point owner/i }));
  await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  const invalidatedKeys = invalidateSpy.mock.calls.map((c) => (c[0] as { queryKey: unknown[] }).queryKey[0]);
  expect(invalidatedKeys).toEqual(expect.arrayContaining(["owners", "inventory"]));
});

// B12 — edge
test("clears picked apartment when property changes", async () => {
  vi.mocked(getApartmentsByProperty).mockImplementation((propertyId: string) =>
    Promise.resolve(
      propertyId === "prop-1"
        ? [apt({ id: "apt-1", unitCode: "A-1" })]
        : [apt({ id: "apt-2", unitCode: "B-2" })],
    ),
  );
  vi.mocked(apiFetch).mockResolvedValue({
    data: [
      { id: "prop-1", name: "Sunway", propertyCode: "SW", propertyType: "c", status: "active", unitCount: 1, occupiedUnits: 0 },
      { id: "prop-2", name: "Mont", propertyCode: "MT", propertyType: "c", status: "active", unitCount: 1, occupiedUnits: 0 },
    ],
  });
  const user = userEvent.setup();
  wrap(<AssignOwnerToUnitDialog owner={owner} open onOpenChange={() => {}} />);
  await screen.findByRole("option", { name: /Sunway/i });
  await user.selectOptions(screen.getByLabelText(/property/i), "prop-1");
  await user.selectOptions(await screen.findByLabelText(/apartment/i), "apt-1");
  await user.selectOptions(screen.getByLabelText(/property/i), "prop-2");
  await waitFor(() => expect(screen.queryByRole("option", { name: /A-1/ })).not.toBeInTheDocument());
  const apartmentSelect = (await screen.findByLabelText(/apartment/i)) as HTMLSelectElement;
  expect(apartmentSelect.value).toBe("");
  expect(screen.getByRole("button", { name: /assign to unit/i })).toBeDisabled();
});

// B13 — concurrency-idempotency
test("rapid double-click on Re-point owner fires exactly one PATCH", async () => {
  vi.mocked(getApartmentsByProperty).mockResolvedValue([apt({ id: "apt-1", unitCode: "A-1" })]);
  let resolvePatch: (v: { data: { id: string } }) => void = () => {};
  vi.mocked(updateApartmentShared).mockImplementation(
    () => new Promise((res) => { resolvePatch = res; }),
  );
  const user = userEvent.setup();
  await openAndPickApartment(user);
  await user.click(screen.getByRole("button", { name: /assign to unit/i }));
  const confirmBtn = screen.getByRole("button", { name: /re-point owner/i });
  // Two rapid clicks before the first request resolves — must not double-fire.
  fireEvent.click(confirmBtn);
  fireEvent.click(confirmBtn);
  await waitFor(() => expect(vi.mocked(updateApartmentShared)).toHaveBeenCalledTimes(1));
  resolvePatch({ data: { id: "apt-1" } });
  await waitFor(() => expect(vi.mocked(updateApartmentShared)).toHaveBeenCalledTimes(1));
});
