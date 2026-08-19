import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SalesClaimDefaultsSection } from "../sales-claim-defaults-section";

const mockGet = vi.fn();
const mockUpsert = vi.fn();

vi.mock("@/api/sales-claim-defaults", () => ({
  getSalesClaimDefault: () => mockGet(),
  upsertSalesClaimDefault: (input: any) => mockUpsert(input),
}));

function renderSection(canWrite = true) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <SalesClaimDefaultsSection canWrite={canWrite} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockGet.mockReset();
  mockUpsert.mockReset();
});

describe("SalesClaimDefaultsSection", () => {
  it("loads and displays the current defaults", async () => {
    mockGet.mockResolvedValue({
      data: {
        id: "d1", organizationId: "o1", appliesTo: "__catchall__",
        commissionType: "percent_of_purchase", commissionValue: "2.00",
        paymentType: "full", notes: null, updatedAt: "", updatedById: null,
        defaultSplits: [
          { id: "sp1", organizationId: "o1", defaultId: "d1", roleLabel: "Sales Commission", splitType: "percent", splitValue: "100.00", sortOrder: 0 },
        ],
      },
    });
    renderSection();
    await waitFor(() => expect(screen.getByDisplayValue("2")).toBeInTheDocument());
    expect(screen.getByDisplayValue("Sales Commission")).toBeInTheDocument();
  });

  it("save button calls upsertSalesClaimDefault with current form state", async () => {
    mockGet.mockResolvedValue({
      data: {
        id: "d1", organizationId: "o1", appliesTo: "__catchall__",
        commissionType: "percent_of_purchase", commissionValue: "2.00",
        paymentType: "full", notes: null, updatedAt: "", updatedById: null,
        defaultSplits: [
          { id: "sp1", organizationId: "o1", defaultId: "d1", roleLabel: "Sales Commission", splitType: "percent", splitValue: "100.00", sortOrder: 0 },
        ],
      },
    });
    mockUpsert.mockResolvedValue({ data: { id: "d1" } });
    renderSection();
    await waitFor(() => screen.getByDisplayValue("Sales Commission"));
    await userEvent.click(screen.getByRole("button", { name: /Save/i }));
    await waitFor(() =>
      expect(mockUpsert).toHaveBeenCalledWith(expect.objectContaining({
        commissionType: "percent_of_purchase",
        commissionValue: 2,
        splits: expect.arrayContaining([
          expect.objectContaining({ roleLabel: "Sales Commission", splitValue: 100 }),
        ]),
      })),
    );
  });

  it("hides Save when canWrite=false", async () => {
    mockGet.mockResolvedValue({
      data: {
        id: "d1", organizationId: "o1", appliesTo: "__catchall__",
        commissionType: "fixed", commissionValue: "1000.00",
        paymentType: "full", notes: null, updatedAt: "", updatedById: null,
        defaultSplits: [],
      },
    });
    renderSection(false);
    await waitFor(() => screen.getByDisplayValue("1000"));
    expect(screen.queryByRole("button", { name: /^Save$/i })).not.toBeInTheDocument();
  });
});
