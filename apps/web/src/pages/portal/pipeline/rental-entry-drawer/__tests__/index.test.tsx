import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RentalEntryDrawer } from "../index";

const mockCreate = vi.fn();
const mockListProperties = vi.fn();

vi.mock("@/api/portal-rental-entries", () => ({
  createRentalEntry: (p: unknown) => mockCreate(p),
}));
vi.mock("@/api/portal-inventory", () => ({
  listPortalProperties: () => mockListProperties(),
}));

function renderDrawer() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <RentalEntryDrawer open onClose={vi.fn()} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockCreate.mockReset();
  // listPortalProperties returns the array directly (not wrapped).
  mockListProperties.mockResolvedValue([
    { id: "prop-1", name: "Tower X", propertyCode: "TX" },
  ]);
});

describe("RentalEntryDrawer", () => {
  it("renders the form with property option and unit code input", async () => {
    renderDrawer();
    await waitFor(() =>
      expect(screen.getByText(/Tower X/)).toBeInTheDocument(),
    );
    expect(screen.getByPlaceholderText(/A-12-01/i)).toBeInTheDocument();
  });

  it("shows the gold submit label", async () => {
    renderDrawer();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Submit Listing/i }),
      ).toBeInTheDocument(),
    );
  });
});
