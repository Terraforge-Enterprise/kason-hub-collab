import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Workstream E, Part 5 — the tenant's combined statement renders one group per
// UNIT CONTEXT (residential unit → its unit code, carpark → "Carpark") plus a
// grand total. The owner's identity is NEVER shown to the tenant (PDPA, fix #5):
// groups are labelled by unit code / "Carpark", not "Paid to <owner>".
// Sub-project B adds (1) a per-line payment-status pill derived from line.status
// and (2) a "Pay outstanding" CTA that routes to the existing /portal/pay
// multi-invoice surface when outstandingTotal > 0.
//
// NOTE: jest-dom matchers are NOT functional under the worktree vitest env
// (dual-package hazard via the repo-root binary — setup.ts imports jest-dom but
// expect.extend lands on a different `expect` instance), so this file uses
// NATIVE matchers only: getByText/getByRole throw when absent; toBeTruthy /
// toBeNull assert presence / absence. Same pattern as pay.test.tsx.

const portalApiFetch = vi.fn();
vi.mock("@/lib/portal-api", () => ({
  portalApiFetch: (...args: unknown[]) => portalApiFetch(...args),
}));

const navigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, useNavigate: () => navigate };
});

import PortalCombinedStatementPage from "../combined-statement";

const STATEMENT = {
  data: {
    month: "2026-06-01",
    monthLabel: "June 2026",
    currency: "MYR",
    groups: [
      {
        // De-identified tenant payload: grouped + labelled by UNIT context (the
        // apartment's unit code), never the owner. ownerName/ownerPartyId remain
        // here ONLY as "poison" — they must NOT surface in the rendered page
        // (PDPA #5). The real API no longer returns any owner identifier.
        groupKey: "unit-res",
        groupLabel: "B-10-01",
        ownerPartyId: "owner-b",
        ownerName: "Owner B",
        lines: [
          {
            id: "c-res",
            chargeNumber: "RENT-RES",
            chargeType: "rent",
            description: null,
            status: "paid",
            dueDate: "2026-06-05T00:00:00.000Z",
            amount: 1500,
            outstandingAmount: 0,
            currency: "MYR",
          },
        ],
        subtotal: 1500,
        outstandingSubtotal: 0,
      },
      {
        groupKey: "carpark-1",
        groupLabel: "Carpark",
        ownerPartyId: "owner-a",
        ownerName: "Owner A",
        lines: [
          {
            id: "c-cp",
            chargeNumber: "RENT-CARPARK",
            chargeType: "rent",
            description: null,
            status: "posted",
            dueDate: "2026-06-05T00:00:00.000Z",
            amount: 150,
            outstandingAmount: 150,
            currency: "MYR",
          },
        ],
        subtotal: 150,
        outstandingSubtotal: 150,
      },
    ],
    total: 1650,
    outstandingTotal: 150,
  },
};

// Every line settled → outstandingTotal 0, so the Pay CTA must be hidden.
const PAID_STATEMENT = {
  data: {
    ...STATEMENT.data,
    groups: STATEMENT.data.groups.map((g) => ({
      ...g,
      outstandingSubtotal: 0,
      lines: g.lines.map((l) => ({ ...l, status: "paid", outstandingAmount: 0 })),
    })),
    outstandingTotal: 0,
  },
};

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <PortalCombinedStatementPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  portalApiFetch.mockReset();
  navigate.mockReset();
  portalApiFetch.mockResolvedValue(STATEMENT);
});

describe("PortalCombinedStatementPage", () => {
  it("groups by unit context (unit code / \"Carpark\") and never leaks the owner's name", async () => {
    renderPage();

    // Group headings are the UNIT context — the apartment's unit code and
    // "Carpark" — so a tenant can tell their charges apart without learning who
    // their owner is.
    expect(await screen.findByText("B-10-01")).toBeTruthy();
    expect(screen.getByText("Carpark")).toBeTruthy();

    // PDPA (#5): the owner's real name must NEVER reach the tenant. Even though
    // the fixture still carries ownerName, there is no "Paid to <owner>" heading
    // and no owner display-name text on the page.
    expect(screen.queryByText(/Paid to/i)).toBeNull();
    expect(screen.queryByText("Owner A")).toBeNull();
    expect(screen.queryByText("Owner B")).toBeNull();

    // The carpark + residential charges still land in their groups.
    expect(screen.getByText("RENT-RES")).toBeTruthy();
    expect(screen.getByText("RENT-CARPARK")).toBeTruthy();

    // Grand total across both groups (unchanged behaviour).
    expect(screen.getByText(/Total for June 2026/)).toBeTruthy();
    expect(screen.getByText("MYR 1,650.00")).toBeTruthy();
  });

  it("hits the statement endpoint with the selected month", async () => {
    renderPage();
    await waitFor(() =>
      expect(portalApiFetch).toHaveBeenCalledWith(expect.stringContaining("/charges/statement?month=")),
    );
  });

  it("renders a per-line payment-status pill derived from line.status", async () => {
    renderPage();

    // paid line → emerald "Paid" pill.
    const paidPill = await screen.findByText("Paid");
    expect(paidPill.className).toContain("emerald");

    // posted (not yet settled) line → sky "Pending" pill.
    const pendingPill = screen.getByText("Pending");
    expect(pendingPill.className).toContain("sky");
  });

  it("shows a Pay-outstanding CTA when outstandingTotal > 0 and routes to /portal/pay", async () => {
    renderPage();

    const payBtn = await screen.findByRole("button", { name: /Pay outstanding/i });
    expect(payBtn).toBeTruthy();

    fireEvent.click(payBtn);
    expect(navigate).toHaveBeenCalledWith("/portal/pay");
  });

  it("hides the Pay-outstanding CTA when nothing is outstanding", async () => {
    portalApiFetch.mockResolvedValue(PAID_STATEMENT);
    renderPage();

    // Wait for the statement body to render, then assert the CTA is absent.
    await screen.findByText(/Total for June 2026/);
    expect(screen.queryByRole("button", { name: /Pay outstanding/i })).toBeNull();
  });
});
