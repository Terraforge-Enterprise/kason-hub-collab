import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { vi } from "vitest";

// One ready-now unit so the form (not the empty state) renders.
const ELIGIBLE_UNIT = {
  id: "11111111-1111-1111-1111-111111111111",
  unitCode: "A-101",
  unitType: "apartment",
  bedrooms: 2,
  sourcingAgentId: null,
  property: { id: "22222222-2222-2222-2222-222222222222", name: "The Sky Residences", propertyCode: "SKY" },
};

const portalApiFetch = vi.fn();

vi.mock("@/lib/portal-api", () => ({
  portalApiFetch: (...args: unknown[]) => portalApiFetch(...args),
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

// usePortalSession is only used for the "own/other source" filter.
vi.mock("@/api/portal-auth", () => ({
  usePortalSession: () => ({ data: { partyId: "agent-1" } }),
}));

const navigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, useNavigate: () => navigate };
});

import ReservationNewPage from "../reservation-new";

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/portal/reservations/new"]}>
        <ReservationNewPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  portalApiFetch.mockReset();
  navigate.mockReset();
  portalApiFetch.mockImplementation((path: string, init?: RequestInit) => {
    if (path === "/reservations/eligible-units") {
      return Promise.resolve({ data: [ELIGIBLE_UNIT] });
    }
    if (path === "/reservations" && init?.method === "POST") {
      return Promise.resolve({
        data: { id: "res-1", referenceCode: "RES-1", publicToken: "tok", expiresAt: "x", status: "pending_customer" },
      });
    }
    return Promise.resolve({ data: [] });
  });
});

test("renders an Agreed Monthly Rent input in the charges section", async () => {
  renderPage();
  await waitFor(() => expect(screen.getByText("Section 1 — Reservation & Admin Charges")).toBeInTheDocument());
  expect(screen.getByText("Agreed Monthly Rent")).toBeInTheDocument();
});

test("includes agreedMonthlyRent in the POST payload (normalised to 2 decimals)", async () => {
  renderPage();
  // Wait for the eligible-units query to settle so the property <select> has
  // its real option (not the "Loading..." placeholder).
  await waitFor(() => {
    const propertySelect = document.querySelectorAll("select")[0] as HTMLSelectElement;
    expect(propertySelect.querySelector(`option[value="${ELIGIBLE_UNIT.property.id}"]`)).toBeTruthy();
  });

  // Property + unit selects, driven via the option's value so the
  // controlled-select onChange fires.
  const propertySelect = document.querySelectorAll("select")[0] as HTMLSelectElement;
  await userEvent.selectOptions(propertySelect, ELIGIBLE_UNIT.property.id);
  await waitFor(() => {
    const unitSelect = document.querySelectorAll("select")[1] as HTMLSelectElement;
    expect(unitSelect.querySelector(`option[value="${ELIGIBLE_UNIT.id}"]`)).toBeTruthy();
  });
  const unitSelect = document.querySelectorAll("select")[1] as HTMLSelectElement;
  await userEvent.selectOptions(unitSelect, ELIGIBLE_UNIT.id);

  // Dates.
  const dateInputs = Array.from(document.querySelectorAll('input[type="date"]')) as HTMLInputElement[];
  fireEvent.change(dateInputs[0], { target: { value: "2026-09-01" } });

  // Money + email fields by label.
  function setByLabel(labelText: string, value: string) {
    const span = Array.from(document.querySelectorAll("span")).find(
      (s) => s.textContent === labelText,
    );
    const label = span?.closest("label");
    const input = label?.querySelector("input") as HTMLInputElement | null;
    if (!input) throw new Error(`input for "${labelText}" not found`);
    fireEvent.change(input, { target: { value } });
  }
  setByLabel("Reservation Deposit", "500");
  setByLabel("Documentation Fee", "100");
  setByLabel("Agreed Monthly Rent", "2200");
  setByLabel("Rental Deposit", "2400");
  setByLabel("Utility Deposit", "300");
  setByLabel("Access Card Deposit", "50");
  setByLabel("Customer Email", "customer@example.com");

  fireEvent.click(screen.getByRole("button", { name: /Save & Get Sign Link/i }));

  await waitFor(() => {
    const postCall = portalApiFetch.mock.calls.find(
      ([p, init]) => p === "/reservations" && (init as RequestInit | undefined)?.method === "POST",
    );
    expect(postCall).toBeTruthy();
    const body = JSON.parse((postCall![1] as RequestInit).body as string);
    expect(body.agreedMonthlyRent).toBe("2200.00");
  });
});
