import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { SalesTab } from "../sales-tab";

const mockListSalesUnits = vi.fn();

vi.mock("@/api/portal-sales", () => ({
  listPortalSalesUnits: () => mockListSalesUnits(),
}));

function renderTab() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <SalesTab />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => mockListSalesUnits.mockReset());

describe("SalesTab", () => {
  it("renders loading state then list with unit info", async () => {
    mockListSalesUnits.mockResolvedValue({
      data: [
        {
          id: "u1",
          unitNumber: "A-12-01",
          purpose: "rent",
          salesDate: "2026-04-30T00:00:00Z",
          sourcingApproved: false,
          project: { name: "Tower X" },
          ownerParty: { displayName: "John Tan" },
        },
      ],
    });
    renderTab();
    await waitFor(() => expect(screen.getByText("Tower X")).toBeInTheDocument());
    expect(screen.getByText(/A-12-01/)).toBeInTheDocument();
    expect(screen.getByText(/John Tan/)).toBeInTheDocument();
  });

  it("renders empty state when no units", async () => {
    mockListSalesUnits.mockResolvedValue({ data: [] });
    renderTab();
    await waitFor(() => expect(screen.getByText(/No units yet/i)).toBeInTheDocument());
  });

  it("derives 'Pending review' status for unapproved units", async () => {
    mockListSalesUnits.mockResolvedValue({
      data: [
        {
          id: "u1",
          unitNumber: "A-12-01",
          purpose: "rent",
          salesDate: "2026-04-30T00:00:00Z",
          sourcingApproved: false,
          project: { name: "Tower X" },
          ownerParty: { displayName: "John Tan" },
        },
      ],
    });
    renderTab();
    await waitFor(() => screen.getByText("Tower X"));
    expect(screen.getByText(/Pending review/i)).toBeInTheDocument();
  });

  it("derives 'Approved (own stay)' for own_stay sourcing-approved units", async () => {
    mockListSalesUnits.mockResolvedValue({
      data: [
        {
          id: "u2",
          unitNumber: "A-13-02",
          purpose: "own_stay",
          salesDate: "2026-04-30T00:00:00Z",
          sourcingApproved: true,
          project: { name: "Tower Y" },
          ownerParty: { displayName: "Jane Lee" },
        },
      ],
    });
    renderTab();
    await waitFor(() => screen.getByText("Tower Y"));
    expect(screen.getByText(/Approved \(own stay\)/i)).toBeInTheDocument();
  });
});
