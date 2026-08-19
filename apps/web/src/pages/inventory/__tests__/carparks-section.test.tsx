// CarparksSection — renders the bay list from a mocked hook, shows each
// bay's label / rate / owner name, and the inline Add-carpark control.
// Follows the test harness established by edit-apartment-dialog.test.tsx.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { CarparksSection } from "../carparks-section";
import type { CarparkRow } from "@/api/carparks";

// ─── Mock the carparks API hooks ──────────────────────────────────────────────
const useCarparksByApartmentMock = vi.hoisted(() => vi.fn());
const useCreateCarparkMock = vi.hoisted(() => vi.fn());
const useDeactivateCarparkMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/carparks", () => ({
  useCarparksByApartment: useCarparksByApartmentMock,
  useCreateCarpark: useCreateCarparkMock,
  useDeactivateCarpark: useDeactivateCarparkMock,
}));

// Sonner toast — silence + capture.
const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: toastMock }));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

const MOCK_BAYS: CarparkRow[] = [
  {
    id: "cp-1",
    label: "Bay A1",
    monthlyRate: "350.00",
    status: "available",
    apartmentId: "apt-1",
    propertyId: "prop-1",
    ownerPartyId: "owner-1",
    ownerName: "Dato' Razak",
  },
  {
    id: "cp-2",
    label: "Bay B2",
    monthlyRate: "400.00",
    status: "rented",
    apartmentId: "apt-1",
    propertyId: "prop-1",
    ownerPartyId: "owner-1",
    ownerName: "Dato' Razak",
  },
];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("CarparksSection", () => {
  beforeEach(() => {
    // Default: two bays loaded, mutations idle
    useCarparksByApartmentMock.mockReturnValue({
      data: { data: MOCK_BAYS },
      isLoading: false,
    });
    useCreateCarparkMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
    useDeactivateCarparkMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
    toastMock.success.mockReset();
    toastMock.error.mockReset();
  });

  it("renders each bay's label, rate, and owner name", () => {
    render(wrap(<CarparksSection apartmentId="apt-1" propertyId="prop-1" />));

    // Labels — getByText throws if not found (implicit existence assertion)
    expect(screen.getByText("Bay A1")).toBeTruthy();
    expect(screen.getByText("Bay B2")).toBeTruthy();

    // Rates (contained in longer strings)
    expect(screen.getByText(/350/)).toBeTruthy();
    expect(screen.getByText(/400/)).toBeTruthy();

    // Owner name — appears once per bay
    const ownerCells = screen.getAllByText(/Dato' Razak/);
    expect(ownerCells.length).toBeGreaterThanOrEqual(1);
  });

  it("renders the inline Add carpark inputs (label + rate)", () => {
    render(wrap(<CarparksSection apartmentId="apt-1" propertyId="prop-1" />));

    expect(screen.getByPlaceholderText(/bay label/i)).toBeTruthy();
    expect(screen.getByPlaceholderText(/monthly rate/i)).toBeTruthy();
  });

  it("renders an Add bay button", () => {
    render(wrap(<CarparksSection apartmentId="apt-1" propertyId="prop-1" />));
    expect(screen.getByRole("button", { name: /add bay/i })).toBeTruthy();
  });

  it("renders a Deactivate button for each bay", () => {
    render(wrap(<CarparksSection apartmentId="apt-1" propertyId="prop-1" />));
    const deactivateButtons = screen.getAllByRole("button", { name: /deactivate/i });
    expect(deactivateButtons).toHaveLength(MOCK_BAYS.length);
  });

  it("shows a loading state when isLoading is true", () => {
    useCarparksByApartmentMock.mockReturnValue({ data: undefined, isLoading: true });
    render(wrap(<CarparksSection apartmentId="apt-1" propertyId="prop-1" />));
    expect(screen.getByText(/loading/i)).toBeTruthy();
  });

  it("shows an empty message when there are no bays", () => {
    useCarparksByApartmentMock.mockReturnValue({ data: { data: [] }, isLoading: false });
    render(wrap(<CarparksSection apartmentId="apt-1" propertyId="prop-1" />));
    expect(screen.getByText(/no carparks/i)).toBeTruthy();
  });

  it("calls useCreateCarpark.mutate with correct args when Add is clicked", async () => {
    const mutateMock = vi.fn();
    useCreateCarparkMock.mockReturnValue({ mutate: mutateMock, isPending: false });
    const user = userEvent.setup();

    render(wrap(<CarparksSection apartmentId="apt-1" propertyId="prop-1" />));

    await user.type(screen.getByPlaceholderText(/bay label/i), "Bay C3");
    await user.type(screen.getByPlaceholderText(/monthly rate/i), "500");
    await user.click(screen.getByRole("button", { name: /add bay/i }));

    expect(mutateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apartmentId: "apt-1",
        label: "Bay C3",
        monthlyRate: "500",
      }),
      expect.anything(),
    );
  });

  it("calls useDeactivateCarpark.mutate with the bay id when Deactivate is clicked", async () => {
    const mutateMock = vi.fn();
    useDeactivateCarparkMock.mockReturnValue({ mutate: mutateMock, isPending: false });
    const user = userEvent.setup();

    render(wrap(<CarparksSection apartmentId="apt-1" propertyId="prop-1" />));

    const [firstDeactivate] = screen.getAllByRole("button", { name: /deactivate/i });
    await user.click(firstDeactivate!);

    expect(mutateMock).toHaveBeenCalledWith("cp-1", expect.anything());
  });
});
