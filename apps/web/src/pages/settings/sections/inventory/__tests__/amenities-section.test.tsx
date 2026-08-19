import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const apiMocks = vi.hoisted(() => ({
  listAmenities: vi.fn(),
  createAmenity: vi.fn(),
  updateAmenity: vi.fn(),
  deleteAmenity: vi.fn(),
  getAmenityUsage: vi.fn(),
}));
vi.mock("@/api/inventory-amenities", () => apiMocks);

import { AmenitiesSection } from "../amenities-section";

function wrap(children: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
}

const ROW = {
  id: "a1",
  organizationId: "o1",
  name: "Gym",
  sortOrder: 1,
  isActive: true,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

describe("AmenitiesSection", () => {
  it("renders the catalog rows", async () => {
    apiMocks.listAmenities.mockResolvedValue([ROW]);
    render(wrap(<AmenitiesSection canWrite={true} />));
    await waitFor(() => expect(screen.getByDisplayValue("Gym")).toBeInTheDocument());
  });

  it("opening the delete dialog fetches usage and renders count + unit list", async () => {
    apiMocks.listAmenities.mockResolvedValue([ROW]);
    apiMocks.getAmenityUsage.mockResolvedValue({
      count: 47,
      units: [
        { id: "u1", unitCode: "A-1", propertyName: "Bldg A" },
        { id: "u2", unitCode: "A-2", propertyName: "Bldg A" },
      ],
    });
    render(wrap(<AmenitiesSection canWrite={true} />));
    await waitFor(() => screen.getByDisplayValue("Gym"));
    const deleteBtn = screen
      .getAllByRole("button")
      .find((b) => b.querySelector("svg.lucide-trash-2") !== null);
    await userEvent.click(deleteBtn!);
    await waitFor(() => expect(screen.getAllByText(/47 unit/i).length).toBeGreaterThan(0));
    expect(screen.getByText("A-1 — Bldg A")).toBeInTheDocument();
    expect(screen.getByText("A-2 — Bldg A")).toBeInTheDocument();
  });

  it("Deactivate-instead button calls update with isActive:false (NOT delete)", async () => {
    apiMocks.listAmenities.mockResolvedValue([ROW]);
    apiMocks.getAmenityUsage.mockResolvedValue({ count: 5, units: [] });
    apiMocks.updateAmenity.mockResolvedValue({ ...ROW, isActive: false });
    render(wrap(<AmenitiesSection canWrite={true} />));
    await waitFor(() => screen.getByDisplayValue("Gym"));
    const deleteBtn = screen
      .getAllByRole("button")
      .find((b) => b.querySelector("svg.lucide-trash-2") !== null);
    await userEvent.click(deleteBtn!);
    await waitFor(() => screen.getByText(/Deactivate instead/i));
    await userEvent.click(screen.getByRole("button", { name: /Deactivate instead/i }));
    expect(apiMocks.updateAmenity).toHaveBeenCalledWith("a1", { isActive: false });
    expect(apiMocks.deleteAmenity).not.toHaveBeenCalled();
  });

  it("Delete button (destructive) calls delete after confirmation", async () => {
    apiMocks.listAmenities.mockResolvedValue([ROW]);
    apiMocks.getAmenityUsage.mockResolvedValue({ count: 0, units: [] });
    apiMocks.deleteAmenity.mockResolvedValue({ affectedUnitCount: 0 });
    render(wrap(<AmenitiesSection canWrite={true} />));
    await waitFor(() => screen.getByDisplayValue("Gym"));
    const deleteBtn = screen
      .getAllByRole("button")
      .find((b) => b.querySelector("svg.lucide-trash-2") !== null);
    await userEvent.click(deleteBtn!);
    await waitFor(() => screen.getByText(/0 units/i));
    const confirmDelete = screen.getByRole("button", { name: /^Delete$/ });
    await userEvent.click(confirmDelete);
    expect(apiMocks.deleteAmenity).toHaveBeenCalledWith("a1");
  });
});
