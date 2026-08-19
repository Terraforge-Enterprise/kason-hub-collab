/**
 * Reopening "Assign to unit" for a tenant who ALREADY has an active tenancy.
 *
 * The dialog is a create-only form: `resetAll()` clears monthlyRentAmount and
 * firstMonthIsCommission on every close, and nothing ever loaded the tenant's
 * existing tenancy. So reopening it to VERIFY a just-saved assignment showed a
 * blank form — unticked KAEN-commission box, empty rent — which reads as "my
 * entry was ignored" even though the tenancy stored firstMonthIsCommission=true
 * and the negotiated rent. (Confirmed against UAT: tenancy TEN-2026-0004 =
 * rent 5.00 / commission true, while the reopened dialog rendered false.)
 *
 * These tests pin the fix: when an active tenancy exists for this tenant, the
 * dialog SHOWS it — unit, negotiated rent, and commission state — instead of
 * silently presenting blanks.
 */
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test, vi, beforeEach } from "vitest";
import { apiFetch } from "@/lib/api-client";
import { getApartmentsByProperty } from "@/api/inventory-units-batch";
import { AssignTenantToUnitDialog } from "../assign-tenant-to-unit-dialog";

vi.mock("@/lib/feature-flags", () => ({
  isPhase2FlagEnabled: (flag: string) => flag === "ENABLE_PHASE2_RESERVATION_GATED_TENANCY",
}));
vi.mock("@/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-client")>();
  return { ...actual, apiFetch: vi.fn() };
});
vi.mock("@/api/inventory-units-batch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/inventory-units-batch")>();
  return { ...actual, getApartmentsByProperty: vi.fn() };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const tenant = { id: "tenant-1", displayName: "daniel" } as const;

const PROPERTY_LIST_OK = {
  data: [
    { id: "prop-1", name: "Kason Residences", propertyCode: "KR", propertyType: "condo", status: "active", unitCount: 1, occupiedUnits: 1 },
  ],
};

/** Mirrors listTenancies()'s row shape, widened with the commission columns. */
const tenancyRow = (over: Record<string, unknown> = {}) => ({
  id: "ten-1",
  tenancyCode: "TEN-2026-0004",
  propertyId: "prop-1",
  propertyName: "Kason Residences",
  unitId: "unit-a0103",
  unitCode: "A-01-03",
  tenantPartyId: "tenant-1",
  tenantName: "daniel",
  status: "active",
  billingStatus: "active",
  startDate: "2026-08-18T00:00:00.000Z",
  endDate: null,
  monthlyRentAmount: 5,
  firstMonthIsCommission: true,
  commissionSstBearer: "owner",
  previousTenancyId: null,
  ...over,
});

function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
}
const wrap = (ui: React.ReactNode) =>
  render(<QueryClientProvider client={makeClient()}>{ui}</QueryClientProvider>);

function mockApi(tenancies: ReturnType<typeof tenancyRow>[]) {
  vi.mocked(apiFetch).mockImplementation((url: string) => {
    const u = String(url);
    if (u === "/inventory/properties") return Promise.resolve(PROPERTY_LIST_OK);
    if (u === "/tenancy/tenancies") return Promise.resolve({ data: tenancies });
    return Promise.resolve({});
  });
}

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  vi.mocked(getApartmentsByProperty).mockReset();
  vi.mocked(getApartmentsByProperty).mockResolvedValue([]);
});

test("shows the tenant's existing active tenancy instead of a blank form", async () => {
  mockApi([tenancyRow()]);
  wrap(<AssignTenantToUnitDialog tenant={tenant} open onOpenChange={() => {}} />);

  // The unit they are already assigned to.
  expect(await screen.findByText(/A-01-03/)).toBeInTheDocument();
  // The NEGOTIATED rent that was actually stored — not the unit's asking rate.
  expect(await screen.findByText(/RM\s*5\.00/)).toBeInTheDocument();
});

test("reflects that KAEN commission IS recorded on the existing tenancy", async () => {
  mockApi([tenancyRow({ firstMonthIsCommission: true, commissionSstBearer: "owner" })]);
  wrap(<AssignTenantToUnitDialog tenant={tenant} open onOpenChange={() => {}} />);

  const panel = await screen.findByTestId("existing-tenancy-panel");
  // The whole point of the bug report: this must NOT read as "not ticked".
  expect(panel).toHaveTextContent(/KAEN commission/i);
  expect(panel).toHaveTextContent(/Yes/i);
});

test("says commission is NOT recorded when the stored tenancy has it off", async () => {
  mockApi([tenancyRow({ firstMonthIsCommission: false })]);
  wrap(<AssignTenantToUnitDialog tenant={tenant} open onOpenChange={() => {}} />);

  const panel = await screen.findByTestId("existing-tenancy-panel");
  expect(panel).toHaveTextContent(/KAEN commission/i);
  expect(panel).toHaveTextContent(/No/i);
});

test("no panel for a tenant with no active tenancy (plain create path)", async () => {
  mockApi([tenancyRow({ status: "ended" }), tenancyRow({ id: "ten-2", tenantPartyId: "other" })]);
  wrap(<AssignTenantToUnitDialog tenant={tenant} open onOpenChange={() => {}} />);

  // Property picker proves the dialog rendered before we assert absence.
  await screen.findByRole("option", { name: /Kason Residences/i });
  expect(screen.queryByTestId("existing-tenancy-panel")).toBeNull();
});
