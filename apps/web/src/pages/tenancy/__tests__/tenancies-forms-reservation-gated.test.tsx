/**
 * Tenant-driven two-path assign form (T13/R5), flag ON.
 *
 * These tests exercise the `ReservationGatedCreateTenancyCard` branch of
 * `TenancyForms`, gated by ENABLE_PHASE2_RESERVATION_GATED_TENANCY. Unlike
 * T11's free-pick reservation select (which let an admin apply reservation
 * R's dates/rent onto an UNRELATED tenant Y), the derive path is now bound
 * to the SELECTED TENANT: selecting a tagged tenant fetches that tenant's
 * OWN linked signed reservation via getTenantLinkedReservation, and only
 * THAT reservation's terms may be derived. The existing
 * `tenancies-forms.test.tsx` covers the legacy (flag-off) card and must keep
 * passing untouched — this file mocks the flag ON specifically so both
 * suites run independently.
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import { vi } from "vitest";

vi.mock("@/lib/feature-flags", () => ({
  isPhase2FlagEnabled: (flag: string) => flag === "ENABLE_PHASE2_RESERVATION_GATED_TENANCY",
}));

// Keep the real ApiError class (needed for `err instanceof ApiError` in the
// component's onError handler) while stubbing apiFetch itself.
vi.mock("@/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-client")>();
  return { ...actual, apiFetch: vi.fn() };
});

// getTenantLinkedReservation is mocked at the api-module boundary (not via
// apiFetch) so each test controls exactly what "the selected tenant's own
// reservation" resolves to, independent of the generic apiFetch mock used
// for submit/carpark calls.
vi.mock("@/api/reservations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/reservations")>();
  return { ...actual, getTenantLinkedReservation: vi.fn() };
});

import { apiFetch, ApiError } from "@/lib/api-client";
import { getTenantLinkedReservation } from "@/api/reservations";
import { TenancyForms } from "../tenancies-forms";

const apiFetchMock = apiFetch as unknown as ReturnType<typeof vi.fn>;
const getTenantLinkedReservationMock = getTenantLinkedReservation as unknown as ReturnType<
  typeof vi.fn
>;

const PROPERTY = { id: "p-1", name: "Sky Residences", propertyCode: "SKY" };
const UNIT = { id: "u-1", propertyId: "p-1", propertyName: "Sky Residences", unitCode: "A-101" };
const TAGGED_TENANT = { id: "t-1", displayName: "Tenant Smith", hasReservation: true };
const TAGGED_TENANT_NO_SIGNED = {
  id: "t-3",
  displayName: "Tenant Lee",
  hasReservation: true,
};
const UNTAGGED_TENANT = { id: "t-2", displayName: "Tenant Jones", hasReservation: false };

const LINKED_RESERVATION = {
  id: "res-1",
  referenceCode: "RES-00001",
  applicant: { fullName: "Tenant Smith", nricMasked: "••••1234", contact: null, email: null },
  proposedMoveIn: "2026-09-01T00:00:00.000Z",
  proposedMoveOut: "2027-08-31T00:00:00.000Z",
  agreedMonthlyRent: "2200.00",
  unit: { label: "A-101" },
};

const CARPARK_BAY = {
  id: "cp-1",
  label: "B2-01",
  monthlyRate: "150.00",
  status: "available",
  apartmentId: "apt-1",
  propertyId: "p-1",
  ownerPartyId: null,
  ownerName: "Dato Razak",
};

function renderForms(props: Partial<React.ComponentProps<typeof TenancyForms>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TenancyForms
        properties={[PROPERTY]}
        units={[UNIT]}
        tenants={[TAGGED_TENANT, TAGGED_TENANT_NO_SIGNED, UNTAGGED_TENANT]}
        tenancies={[]}
        {...props}
      />
    </QueryClientProvider>,
  );
}

function setField(name: string, value: string) {
  const el = document.querySelector(`[name="${name}"]`) as HTMLInputElement | HTMLSelectElement | null;
  if (!el) throw new Error(`field ${name} not found`);
  fireEvent.change(el, { target: { value } });
}

beforeEach(() => {
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation((url: string) => {
    if (typeof url === "string" && url.startsWith("/carparks/available")) {
      return Promise.resolve({ data: [] });
    }
    return Promise.resolve({ data: { id: "tn-1" } });
  });
  getTenantLinkedReservationMock.mockReset();
  getTenantLinkedReservationMock.mockResolvedValue(null);
});

afterEach(() => {
  // Money-safety (T13 paused-state fix): tests that flip the browser offline
  // via onlineManager must never leak that state into sibling test files —
  // restore online unconditionally even if the test body throws first.
  onlineManager.setOnline(true);
});

test("selecting a tagged tenant whose linked reservation resolves signed renders startDate/endDate/monthlyRentAmount read-only, derived from that reservation", async () => {
  getTenantLinkedReservationMock.mockImplementation((tenantPartyId: string) =>
    tenantPartyId === TAGGED_TENANT.id ? Promise.resolve(LINKED_RESERVATION) : Promise.resolve(null),
  );
  renderForms();

  setField("tenantPartyId", TAGGED_TENANT.id);

  await waitFor(() => {
    expect(getTenantLinkedReservationMock).toHaveBeenCalledWith(TAGGED_TENANT.id);
  });

  const startDate = await screen.findByDisplayValue("2026-09-01");
  const endDate = await screen.findByDisplayValue("2027-08-31");
  const rent = document.querySelector('[name="monthlyRentAmount"]') as HTMLInputElement;

  expect((startDate as HTMLInputElement).disabled).toBe(true);
  expect((endDate as HTMLInputElement).disabled).toBe(true);
  expect(rent.disabled).toBe(true);
  expect(rent.value).toBe("2200.00");
});

test("selecting an untagged tenant keeps startDate/endDate/monthlyRentAmount editable (manual path) and never calls getTenantLinkedReservation", async () => {
  renderForms();

  setField("tenantPartyId", UNTAGGED_TENANT.id);

  const startDate = document.querySelector('[name="startDate"]') as HTMLInputElement;
  const endDate = document.querySelector('[name="endDate"]') as HTMLInputElement;
  const rent = document.querySelector('[name="monthlyRentAmount"]') as HTMLInputElement;

  expect(startDate.disabled).toBe(false);
  expect(endDate.disabled).toBe(false);
  expect(rent.disabled).toBe(false);
  expect(getTenantLinkedReservationMock).not.toHaveBeenCalled();
});

test("a tagged tenant whose linked-reservation fetch resolves null falls back to editable manual fields", async () => {
  getTenantLinkedReservationMock.mockResolvedValue(null);
  renderForms();

  setField("tenantPartyId", TAGGED_TENANT_NO_SIGNED.id);

  await waitFor(() => {
    expect(getTenantLinkedReservationMock).toHaveBeenCalledWith(TAGGED_TENANT_NO_SIGNED.id);
  });

  const startDate = document.querySelector('[name="startDate"]') as HTMLInputElement;
  const rent = document.querySelector('[name="monthlyRentAmount"]') as HTMLInputElement;
  expect(startDate.disabled).toBe(false);
  expect(rent.disabled).toBe(false);
});

test("derived-path submit posts to the convert-to-tenancy route with that reservation's id + tenantPartyId only, not terms or a tenancy code", async () => {
  getTenantLinkedReservationMock.mockImplementation((tenantPartyId: string) =>
    tenantPartyId === TAGGED_TENANT.id ? Promise.resolve(LINKED_RESERVATION) : Promise.resolve(null),
  );
  renderForms();

  setField("propertyId", PROPERTY.id);
  setField("unitId", UNIT.id);
  setField("tenantPartyId", TAGGED_TENANT.id);

  await screen.findByDisplayValue("2026-09-01");

  fireEvent.click(screen.getByRole("button", { name: /Create tenancy/i }));

  await waitFor(() => {
    const call = apiFetchMock.mock.calls.find(
      ([p]) => p === `/admin/reservations/${LINKED_RESERVATION.id}/convert-to-tenancy`,
    );
    expect(call).toBeTruthy();
    const body = JSON.parse((call![1] as RequestInit).body as string);
    // No tenancyCode: convertReservationToTenancy generates it server-side.
    expect(body).toEqual({ tenantPartyId: TAGGED_TENANT.id });
  });
});

test("manual-path submit posts to /tenancy/tenancies", async () => {
  renderForms();
  setField("propertyId", PROPERTY.id);
  setField("unitId", UNIT.id);
  setField("tenantPartyId", UNTAGGED_TENANT.id);
  setField("startDate", "2026-10-01");
  setField("monthlyRentAmount", "1500");

  fireEvent.click(screen.getByRole("button", { name: /Create tenancy/i }));

  await waitFor(() => {
    const call = apiFetchMock.mock.calls.find(([p]) => p === "/tenancy/tenancies");
    expect(call).toBeTruthy();
    const body = JSON.parse((call![1] as RequestInit).body as string);
    expect(body.tenantPartyId).toBe(UNTAGGED_TENANT.id);
    expect(body.monthlyRentAmount).toBe("1500");
  });
});

test("carpark bay selection is included in the manual submit body", async () => {
  apiFetchMock.mockImplementation((url: string) => {
    if (typeof url === "string" && url.startsWith("/carparks/available")) {
      return Promise.resolve({ data: [CARPARK_BAY] });
    }
    return Promise.resolve({ data: { id: "tn-1" } });
  });

  renderForms();
  setField("unitId", UNIT.id);

  await waitFor(() => {
    expect(screen.getByRole("option", { name: /B2-01/i })).toBeInTheDocument();
  });

  const baySelect = screen.getByLabelText("Select carpark bay") as HTMLSelectElement;
  await userEvent.selectOptions(baySelect, CARPARK_BAY.id);
  fireEvent.click(screen.getByRole("button", { name: /Add bay/i }));

  setField("propertyId", PROPERTY.id);
  setField("tenantPartyId", UNTAGGED_TENANT.id);
  setField("startDate", "2026-10-01");
  setField("monthlyRentAmount", "1800");

  fireEvent.click(screen.getByRole("button", { name: /Create tenancy/i }));

  await waitFor(() => {
    const call = apiFetchMock.mock.calls.find(([p]) => p === "/tenancy/tenancies");
    expect(call).toBeTruthy();
    const body = JSON.parse((call![1] as RequestInit).body as string);
    expect(body.carparks).toEqual([
      { carparkId: CARPARK_BAY.id, monthlyCharge: CARPARK_BAY.monthlyRate },
    ]);
  });
});

test("carpark bay selection is included in the derived (convert-route) submit body", async () => {
  getTenantLinkedReservationMock.mockImplementation((tenantPartyId: string) =>
    tenantPartyId === TAGGED_TENANT.id ? Promise.resolve(LINKED_RESERVATION) : Promise.resolve(null),
  );
  apiFetchMock.mockImplementation((url: string) => {
    if (typeof url === "string" && url.startsWith("/carparks/available")) {
      return Promise.resolve({ data: [CARPARK_BAY] });
    }
    return Promise.resolve({ data: { id: "tn-1" } });
  });

  renderForms();
  setField("unitId", UNIT.id);

  await waitFor(() => {
    expect(screen.getByRole("option", { name: /B2-01/i })).toBeInTheDocument();
  });
  const baySelect = screen.getByLabelText("Select carpark bay") as HTMLSelectElement;
  await userEvent.selectOptions(baySelect, CARPARK_BAY.id);
  fireEvent.click(screen.getByRole("button", { name: /Add bay/i }));

  setField("propertyId", PROPERTY.id);
  setField("tenantPartyId", TAGGED_TENANT.id);
  await screen.findByDisplayValue("2026-09-01");

  fireEvent.click(screen.getByRole("button", { name: /Create tenancy/i }));

  await waitFor(() => {
    const call = apiFetchMock.mock.calls.find(
      ([p]) => p === `/admin/reservations/${LINKED_RESERVATION.id}/convert-to-tenancy`,
    );
    expect(call).toBeTruthy();
    const body = JSON.parse((call![1] as RequestInit).body as string);
    expect(body.carparks).toEqual([
      { carparkId: CARPARK_BAY.id, monthlyCharge: CARPARK_BAY.monthlyRate },
    ]);
  });
});

test("a tagged tenant's linked-reservation lookup still in flight shows a checking indicator and blocks submit (money-safety: never manual-submit before the lookup settles)", async () => {
  let resolveLookup!: (value: unknown) => void;
  getTenantLinkedReservationMock.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveLookup = resolve;
      }),
  );
  renderForms();

  setField("tenantPartyId", TAGGED_TENANT.id);

  await waitFor(() => {
    expect(getTenantLinkedReservationMock).toHaveBeenCalledWith(TAGGED_TENANT.id);
  });

  await waitFor(() => {
    expect(screen.getByText(/checking for a signed reservation/i)).toBeInTheDocument();
  });

  const submitButton = screen.getByRole("button", { name: /Create tenancy/i });
  expect(submitButton).toBeDisabled();

  // Defense in depth: even if the disabled button is bypassed (e.g. an Enter
  // keypress submitting the form directly), the onSubmit early-return guard
  // must still block the request while the lookup is in flight.
  fireEvent.submit(submitButton.closest("form")!);
  expect(apiFetchMock).not.toHaveBeenCalledWith(
    "/tenancy/tenancies",
    expect.anything(),
  );

  // Settle the pending promise so it doesn't leak into later tests/timers.
  resolveLookup(null);
  await waitFor(() => expect(submitButton).not.toBeDisabled());
});

test("a tagged tenant's linked-reservation lookup that REJECTS shows a blocked, retryable error state and never silently falls back to an enabled manual submit", async () => {
  getTenantLinkedReservationMock.mockRejectedValue(new Error("network down"));
  renderForms();

  setField("tenantPartyId", TAGGED_TENANT.id);

  await waitFor(() => {
    expect(getTenantLinkedReservationMock).toHaveBeenCalledWith(TAGGED_TENANT.id);
  });

  await waitFor(() => {
    expect(screen.getByText(/couldn.t check for a signed reservation/i)).toBeInTheDocument();
  });

  const submitButton = screen.getByRole("button", { name: /Create tenancy/i });
  expect(submitButton).toBeDisabled();

  // Defense in depth: even if the disabled button is bypassed (e.g. an Enter
  // keypress submitting the form directly), the onSubmit early-return guard
  // must still block the request while the lookup is errored.
  fireEvent.submit(submitButton.closest("form")!);
  expect(apiFetchMock).not.toHaveBeenCalledWith(
    "/tenancy/tenancies",
    expect.anything(),
  );

  // A retry affordance should re-invoke the lookup.
  getTenantLinkedReservationMock.mockResolvedValueOnce(null);
  fireEvent.click(screen.getByRole("button", { name: /Retry/i }));

  await waitFor(() => {
    expect(submitButton).not.toBeDisabled();
  });
});

test("a tagged tenant's linked-reservation lookup that PAUSES while offline blocks submit and never falls back to an enabled manual submit (money-safety: covers React Query v5's fetchStatus:'paused', which isFetching/isError/isSuccess all miss)", async () => {
  // The money bypass this test guards: with the production QueryClient's
  // default networkMode:'online' (apps/web/src/main.tsx has no override), an
  // offline browser makes an ENABLED query PAUSE — isFetching/isError/
  // isSuccess all read false and .data stays undefined. A gate built from
  // isFetching/isError alone reads "settled, no reservation" and would
  // enable submit for a TAGGED tenant with a real signed reservation.
  onlineManager.setOnline(false);
  renderForms();

  setField("tenantPartyId", TAGGED_TENANT.id);

  await waitFor(() => {
    expect(
      screen.getByText(/waiting to verify this tenant.s reservation/i),
    ).toBeInTheDocument();
  });

  // Paused fetches never invoke the queryFn at all (React Query defers the
  // attempt until reconnect) — the gate must not depend on the queryFn
  // having run, loading, or errored.
  expect(getTenantLinkedReservationMock).not.toHaveBeenCalled();
  expect(
    screen.queryByText(/couldn.t check for a signed reservation/i),
  ).not.toBeInTheDocument();

  const submitButton = screen.getByRole("button", { name: /Create tenancy/i });
  expect(submitButton).toBeDisabled();

  // Fill in the fields that render editable/manual while blocked (derivedReservation
  // is null here too, same as loading/error) — proves they're inert, not just
  // visually disabled behind a button.
  setField("propertyId", PROPERTY.id);
  setField("unitId", UNIT.id);
  setField("startDate", "2026-10-01");
  setField("monthlyRentAmount", "9999");

  fireEvent.submit(submitButton.closest("form")!);
  expect(apiFetchMock).not.toHaveBeenCalledWith("/tenancy/tenancies", expect.anything());

  // Recoverable, not a dead end: once connectivity returns, the paused query
  // resumes on its own (React Query auto-resumes paused queries on
  // reconnect) and the blocked state clears — no permanent stuck state.
  onlineManager.setOnline(true);
  await waitFor(() => expect(submitButton).not.toBeDisabled());
});

test("a 409 UNIT_HAS_ACTIVE_TENANCY response opens a confirm dialog; confirming re-submits with overwrite:true", async () => {
  getTenantLinkedReservationMock.mockImplementation((tenantPartyId: string) =>
    tenantPartyId === TAGGED_TENANT.id ? Promise.resolve(LINKED_RESERVATION) : Promise.resolve(null),
  );
  apiFetchMock.mockImplementation((path: string) => {
    if (typeof path === "string" && path.startsWith("/carparks/available")) {
      return Promise.resolve({ data: [] });
    }
    if (path === `/admin/reservations/${LINKED_RESERVATION.id}/convert-to-tenancy`) {
      if (apiFetchMock.mock.calls.filter((c) => c[0] === path).length === 1) {
        throw new ApiError("Unit already has an active tenancy", 409, "UNIT_HAS_ACTIVE_TENANCY", {
          incumbent: { tenantName: "Old Tenant", endDate: "2026-08-31T00:00:00.000Z" },
        });
      }
      return Promise.resolve({ data: { id: "tn-2", supersededTenancyId: "tn-old" } });
    }
    return Promise.resolve({ data: { id: "tn-1" } });
  });

  renderForms();
  setField("propertyId", PROPERTY.id);
  setField("unitId", UNIT.id);
  setField("tenantPartyId", TAGGED_TENANT.id);
  await screen.findByDisplayValue("2026-09-01");

  fireEvent.click(screen.getByRole("button", { name: /Create tenancy/i }));

  await waitFor(() => {
    expect(screen.getByText(/Old Tenant/)).toBeInTheDocument();
  });

  fireEvent.click(screen.getByRole("button", { name: /Overwrite and assign/i }));

  await waitFor(() => {
    const calls = apiFetchMock.mock.calls.filter(
      ([p]) => p === `/admin/reservations/${LINKED_RESERVATION.id}/convert-to-tenancy`,
    );
    expect(calls.length).toBe(2);
    const retryBody = JSON.parse((calls[1][1] as RequestInit).body as string);
    expect(retryBody.overwrite).toBe(true);
  });
});
