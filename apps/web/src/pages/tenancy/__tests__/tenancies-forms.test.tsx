import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { vi } from "vitest";

const apiFetch = vi.fn();
vi.mock("@/lib/api-client", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

import { TenancyForms } from "../tenancies-forms";

const PROPERTY = { id: "p-1", name: "Sky Residences", propertyCode: "SKY" };
const UNIT = { id: "u-1", propertyId: "p-1", propertyName: "Sky Residences", unitCode: "A-101" };
const TENANT = { id: "t-1", displayName: "Tenant Smith" };

const RESERVATION = {
  id: "res-1",
  referenceCode: "RES-00001",
  unitId: "u-1",
  status: "signed",
  agreedMonthlyRent: "2200.00",
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
        tenants={[TENANT]}
        tenancies={[]}
        reservations={[RESERVATION]}
        {...props}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockResolvedValue({ data: { id: "tn-1" } });
});

test("renders a reservation picker in the Create tenancy form", () => {
  renderForms();
  expect(screen.getByText("Source from reservation (optional)")).toBeInTheDocument();
});

test("selecting a reservation prefills monthly rent (read-only) and submits reservationId without monthlyRentAmount", async () => {
  renderForms();

  // Fill the required selects/inputs the create form needs.
  function setField(name: string, value: string) {
    const el = document.querySelector(`[name="${name}"]`) as HTMLInputElement | HTMLSelectElement | null;
    if (!el) throw new Error(`field ${name} not found`);
    fireEvent.change(el, { target: { value } });
  }
  setField("propertyId", PROPERTY.id);
  setField("unitId", UNIT.id);
  setField("tenantPartyId", TENANT.id);
  setField("startDate", "2026-09-01");

  // Pick the reservation (the picker is a UI-only control named reservationPicker;
  // reservationId is injected into the payload on submit).
  const resSelect = document.querySelector('[name="reservationPicker"]') as HTMLSelectElement;
  await userEvent.selectOptions(resSelect, RESERVATION.id);

  // Monthly rent input is now prefilled + read-only.
  const rent = document.querySelector('[name="monthlyRentAmount"]') as HTMLInputElement;
  expect(rent.value).toBe("2200.00");
  expect(rent.readOnly).toBe(true);

  // Submit.
  const submit = screen.getByRole("button", { name: /Create tenancy/i });
  fireEvent.click(submit);

  await waitFor(() => {
    const createCall = apiFetch.mock.calls.find(
      ([p, init]) => p === "/tenancy/tenancies" && (init as RequestInit | undefined)?.method === "POST",
    );
    expect(createCall).toBeTruthy();
    const body = JSON.parse((createCall![1] as RequestInit).body as string);
    expect(body.reservationId).toBe(RESERVATION.id);
    // Rent is sourced from the reservation server-side; the form must not send
    // a competing monthlyRentAmount.
    expect(body.monthlyRentAmount).toBeUndefined();
  });
});

test("initialReservationId (from query param) preselects the reservation and prefills rent", () => {
  renderForms({ initialReservationId: RESERVATION.id });

  const resSelect = document.querySelector('[name="reservationPicker"]') as HTMLSelectElement;
  expect(resSelect.value).toBe(RESERVATION.id);
  const rent = document.querySelector('[name="monthlyRentAmount"]') as HTMLInputElement;
  expect(rent.value).toBe("2200.00");
  expect(rent.readOnly).toBe(true);
});

test("carpark bay picker renders and shows available bays after unit selection", async () => {
  apiFetch.mockImplementation((url: string) => {
    if (typeof url === "string" && url.startsWith("/carparks/available")) {
      return Promise.resolve({ data: [CARPARK_BAY] });
    }
    return Promise.resolve({ data: { id: "tn-1" } });
  });

  renderForms({ reservations: [] });

  // Bay picker section is present before unit selection (disabled/placeholder).
  expect(screen.getByLabelText("Select carpark bay")).toBeInTheDocument();
  expect(screen.getByText("Pick a unit first")).toBeInTheDocument();

  // Select a unit — triggers the available-carparks query scoped to the property.
  const unitSelect = document.querySelector('[name="unitId"]') as HTMLSelectElement;
  fireEvent.change(unitSelect, { target: { value: UNIT.id } });

  // Wait for bay options to load and appear in the picker.
  await waitFor(() => {
    expect(
      screen.getByRole("option", { name: /B2-01 · Dato Razak · RM 150\.00/i }),
    ).toBeInTheDocument();
  });
});

test("selected carpark bays appear in the submitted create tenancy body", async () => {
  apiFetch.mockImplementation((url: string) => {
    if (typeof url === "string" && url.startsWith("/carparks/available")) {
      return Promise.resolve({ data: [CARPARK_BAY] });
    }
    return Promise.resolve({ data: { id: "tn-1" } });
  });

  renderForms({ reservations: [] });

  function setField(name: string, value: string) {
    const el = document.querySelector(`[name="${name}"]`) as HTMLInputElement | HTMLSelectElement | null;
    if (!el) throw new Error(`field ${name} not found`);
    fireEvent.change(el, { target: { value } });
  }

  // Select unit to trigger the carparks query.
  setField("unitId", UNIT.id);

  // Wait for the bay to appear in the picker.
  await waitFor(() => {
    expect(
      screen.getByRole("option", { name: /B2-01/i }),
    ).toBeInTheDocument();
  });

  // Select the bay — charge auto-fills with the bay's monthlyRate.
  const baySelect = screen.getByLabelText("Select carpark bay") as HTMLSelectElement;
  await userEvent.selectOptions(baySelect, CARPARK_BAY.id);

  // Confirm the charge input was pre-filled.
  const chargeInput = screen.getByLabelText("Monthly charge override") as HTMLInputElement;
  expect(chargeInput.value).toBe(CARPARK_BAY.monthlyRate);

  // Add the bay.
  fireEvent.click(screen.getByRole("button", { name: /Add bay/i }));

  // The added bay appears in the list.
  expect(screen.getByText(/B2-01/i)).toBeInTheDocument();

  // Fill the remaining required fields.
  setField("propertyId", PROPERTY.id);
  setField("tenantPartyId", TENANT.id);
  setField("startDate", "2026-09-01");
  setField("monthlyRentAmount", "1800");

  // Submit.
  fireEvent.click(screen.getByRole("button", { name: /Create tenancy/i }));

  await waitFor(() => {
    const createCall = apiFetch.mock.calls.find(
      ([p, init]) => p === "/tenancy/tenancies" && (init as RequestInit | undefined)?.method === "POST",
    );
    expect(createCall).toBeTruthy();
    const body = JSON.parse((createCall![1] as RequestInit).body as string);
    expect(body.carparks).toEqual([
      { carparkId: CARPARK_BAY.id, monthlyCharge: CARPARK_BAY.monthlyRate },
    ]);
  });
});

test("without a reservation the monthly rent field stays editable and is sent", async () => {
  renderForms({ reservations: [] });

  function setField(name: string, value: string) {
    const el = document.querySelector(`[name="${name}"]`) as HTMLInputElement | HTMLSelectElement | null;
    if (!el) throw new Error(`field ${name} not found`);
    fireEvent.change(el, { target: { value } });
  }
  setField("propertyId", PROPERTY.id);
  setField("unitId", UNIT.id);
  setField("tenantPartyId", TENANT.id);
  setField("startDate", "2026-09-01");

  const rent = document.querySelector('[name="monthlyRentAmount"]') as HTMLInputElement;
  expect(rent.readOnly).toBe(false);
  fireEvent.change(rent, { target: { value: "1800" } });

  fireEvent.click(screen.getByRole("button", { name: /Create tenancy/i }));

  await waitFor(() => {
    const createCall = apiFetch.mock.calls.find(
      ([p, init]) => p === "/tenancy/tenancies" && (init as RequestInit | undefined)?.method === "POST",
    );
    expect(createCall).toBeTruthy();
    const body = JSON.parse((createCall![1] as RequestInit).body as string);
    expect(body.monthlyRentAmount).toBe("1800");
    expect(body.reservationId).toBeUndefined();
    // No carparks selected — field omitted entirely.
    expect(body.carparks).toBeUndefined();
  });
});
