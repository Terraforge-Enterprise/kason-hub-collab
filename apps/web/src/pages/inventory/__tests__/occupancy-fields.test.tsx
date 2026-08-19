import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, it, expect, vi } from "vitest";
import { OccupancyFields } from "../occupancy-fields";
import { apiFetch } from "@/lib/api-client";

vi.mock("@/lib/api-client", () => ({ apiFetch: vi.fn().mockResolvedValue({ data: [] }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

const base = {
  occupancyStatus: "occupied" as const,
  tenantPartyId: null, tenantName: "", tenantIdType: null,
  tenantIdNumberMasked: null, tenantPhone: null,
  moveInDate: "", moveOutDate: "", monthlyRent: "",
  onSelectTenant: vi.fn(), onClearTenant: vi.fn(), onChange: vi.fn(), errors: {},
};

describe("<OccupancyFields>", () => {
  it("renders nothing when not occupied", () => {
    const { container } = render(wrap(<OccupancyFields {...base} occupancyStatus="vacant" />));
    expect(container.firstChild).toBeNull();
  });

  it("renders the tenant typeahead (not a free-text name) when no tenant picked", () => {
    render(wrap(<OccupancyFields {...base} />));
    expect(screen.getByPlaceholderText(/search existing tenants/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/move-in/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/move-out/i)).toBeInTheDocument();
  });

  it("renders the confirm card with masked IC once a tenant is selected", () => {
    render(wrap(
      <OccupancyFields {...base}
        tenantPartyId="t1" tenantName="NURUL IZZAH"
        tenantIdType="nric" tenantIdNumberMasked="••••5678" tenantPhone="+60 12-345 6789" />,
    ));
    expect(screen.getByText("NURUL IZZAH")).toBeInTheDocument();
    expect(screen.getByText("••••5678")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reveal ic/i })).toBeInTheDocument();
  });

  it("shows the tenantPartyId error text", () => {
    render(wrap(<OccupancyFields {...base} errors={{ tenantPartyId: "Select an existing tenant when occupancy is Occupied" }} />));
    expect(screen.getByText("Select an existing tenant when occupancy is Occupied")).toBeInTheDocument();
  });

  // Final-review Fix 1 flag-off parity: this file does not mock
  // @/lib/feature-flags, so isPhase2FlagEnabled reads the real (unset in
  // tests) VITE_ENABLE_PHASE2_RESERVATION_GATED_TENANCY env var and returns
  // false. The monthly-rent field must stay hidden in that state -- see
  // occupancy-fields.monthly-rent.test.tsx for the flag-ON coverage.
  it("does not render a monthly-rent input when the reservation-gating flag is off", () => {
    render(wrap(<OccupancyFields {...base} monthlyRent="4500" />));
    expect(screen.queryByLabelText(/tenancy monthly rent/i)).not.toBeInTheDocument();
  });

  // The first-month rent-preview card is a Phase-2 surface tied to the same
  // reservation-gating flag as the rent input it reads. With the flag off (the
  // client-prod state) the preview query must NOT fire and the card must NOT
  // render -- otherwise, e.g. on Edit of a unit occupied a year ago (moveInDate +
  // rentalRate prefilled), an unapproved "First invoice · <past month>" card
  // leaks into prod. See occupancy-fields.monthly-rent.test.tsx for flag-ON.
  it("does not fire the first-month rent-preview query when the reservation-gating flag is off", async () => {
    vi.mocked(apiFetch).mockClear();
    render(wrap(<OccupancyFields {...base} moveInDate="2025-03-10" monthlyRent="1500" />));
    await new Promise((r) => setTimeout(r, 30));
    const calledRentPreview = vi
      .mocked(apiFetch)
      .mock.calls.some((c) => String(c[0]).includes("rent-preview"));
    expect(calledRentPreview).toBe(false);
    expect(screen.queryByText(/first invoice/i)).not.toBeInTheDocument();
  });
});
