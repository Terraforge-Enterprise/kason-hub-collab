// Recurring-charges (R9) — the Owner and Tenant recurring cells must each open a dialog scoped to
// THAT bearer. The dialog originally took only an apartmentId and rendered every CUSTOM recurring
// line for the apartment-month, so a tenant-borne charge was listed (and totalled) under "View
// owner recurring charges". The grid cells themselves were always right — `recurringTotalsByEntry`
// splits on bearer, proven by recurring-read.integration.test.ts — the gap was display-only.
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RecurringDialog } from "../recurring-dialog";

const mockLines = vi.fn();
vi.mock("@/api/bills-grid-recurring", async () => {
  const actual = await vi.importActual<typeof import("@/api/bills-grid-recurring")>("@/api/bills-grid-recurring");
  return { ...actual, listRecurringLines: (...a: unknown[]) => mockLines(...a) };
});

// One owner-borne + one tenant-borne CUSTOM recurring line on the same apartment-month —
// the reported scenario: "i save 2 recurring, 1 for tenant 1 for owner".
const MIXED = {
  lines: [
    { id: "L-own", name: "Owner service fee", amount: "120.00", bearer: "owner", nature: null, categoryName: "Recurring (owner)" },
    { id: "L-ten", name: "Tenant service fee", amount: "30.00", bearer: "tenant", nature: null, categoryName: "Recurring (tenant)" },
  ],
};

function renderDialog(bearer: "owner" | "tenant") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <QueryClientProvider client={queryClient}>
      <RecurringDialog apartmentId="apt-1" periodMonth="2026-08" bearer={bearer} open onClose={() => {}} />
    </QueryClientProvider>,
  );
}

describe("recurring dialog separates owner from tenant", () => {
  it("the OWNER cell's dialog lists owner lines only", async () => {
    mockLines.mockResolvedValue(MIXED);
    renderDialog("owner");
    expect(await screen.findByText("Owner service fee")).toBeInTheDocument();
    expect(screen.queryByText("Tenant service fee")).toBeNull();
  });

  it("the OWNER cell's dialog total is the owner subtotal, not owner+tenant", async () => {
    mockLines.mockResolvedValue(MIXED);
    renderDialog("owner");
    await screen.findByText("Owner service fee"); // settle the query before reading the total
    // 120 owner-only — NOT 150, which is what summing both bearers produced.
    expect(screen.getByTestId("recurring-dialog-total")).toHaveTextContent("120");
    expect(screen.getByTestId("recurring-dialog-total")).not.toHaveTextContent("150");
  });

  it("the TENANT cell's dialog lists tenant lines only, and totals the tenant subtotal", async () => {
    mockLines.mockResolvedValue(MIXED);
    renderDialog("tenant");
    expect(await screen.findByText("Tenant service fee")).toBeInTheDocument();
    expect(screen.queryByText("Owner service fee")).toBeNull();
    expect(screen.getByTestId("recurring-dialog-total")).toHaveTextContent("30");
    expect(screen.getByTestId("recurring-dialog-total")).not.toHaveTextContent("150");
  });

  it("the line count reflects the bearer's own lines, not the apartment-month's", async () => {
    mockLines.mockResolvedValue(MIXED);
    renderDialog("tenant");
    await screen.findByText("Tenant service fee");
    expect(screen.getByTestId("recurring-dialog-count")).toHaveTextContent("1 line");
  });

  it("a bearer with no lines shows the empty state even when the other bearer has some", async () => {
    mockLines.mockResolvedValue({ lines: [MIXED.lines[0]] }); // owner-only payload
    renderDialog("tenant");
    expect(await screen.findByText(/No recurring charges/)).toBeInTheDocument();
  });
});
