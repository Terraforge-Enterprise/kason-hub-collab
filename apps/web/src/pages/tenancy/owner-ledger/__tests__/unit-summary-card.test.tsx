// Tests for UnitSummaryCard (Task 8 — D3): one unit's month payout figures + actions.
//
// Asserts:
//   (a) the 4 figures render AND foot: income + deposit − deductible === net.
//   (b) for a REAL apartment (apartmentId != null): "Print Invoice" downloads the
//       bills-merged receipt scoped to this unit+month (downloadLedgerReceipt is
//       called with ownerPartyId, month, apartmentId), and "Attach bills" opens a
//       panel that mounts <BulkBillAttach> for this unit+month.
//   (c) for the "Unassigned / property-level" sentinel (apartmentId == null): the
//       figures render but Print/Attach actions are ABSENT (no apartment to scope to).
//
// jest-dom matchers ARE available (src/test/setup.ts imports @testing-library/jest-dom/vitest).
//
// Run with:
//   cd .../phase2-owner-billing/apps/web && \
//     ../../node_modules/.bin/vitest run \
//     src/pages/tenancy/owner-ledger/__tests__/unit-summary-card.test.tsx --no-coverage
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import React from "react";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// ── Mock useNavigate so navigation is observable for BOTH the whole-card click and
//    the "Per-unit statement" button (both call navigate), without a real router.
//    vi.hoisted → the fn exists before the hoisted mock. ─
const { mockNavigate } = vi.hoisted(() => ({ mockNavigate: vi.fn() }));
vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return { ...actual, useNavigate: () => mockNavigate };
});

// ── Mock the receipt download (Task 4) so "Print Invoice" is observable ────────
const mockDownloadReceipt = vi.fn();
vi.mock("@/api/owner-ledger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/owner-ledger")>();
  return {
    ...actual,
    downloadLedgerReceipt: (...args: unknown[]) => mockDownloadReceipt(...args),
  };
});

// ── Stub the proofs hooks BulkBillAttach uses so the Attach panel mounts cleanly ─
// useExpenseProofs is a vi.fn() so individual tests can override its return value.
vi.mock("@/api/owner-billing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/owner-billing")>();
  return {
    ...actual,
    useAttachExpenseProof: () => ({ mutate: vi.fn(), isPending: false }),
    useDetachExpenseProof: () => ({ mutate: vi.fn(), isPending: false }),
    useExpenseProofs: vi.fn(),
  };
});

import { UnitSummaryCard } from "../unit-summary-card";
import type { UnitPayoutRow } from "@/api/owner-ledger";
import { useExpenseProofs } from "@/api/owner-billing";
import type { ExpenseProofGroup } from "@/api/owner-billing";

// ── Helpers ────────────────────────────────────────────────────────────────────

// income + deposit − deductible === net  (1000 + 200 − 300 === 900)
const realUnit: UnitPayoutRow = {
  apartmentId: "apt-1",
  unitCode: "A-10-04",
  incomeCollected: "1000.00",
  depositCollected: "200.00",
  deductibleExpenses: "300.00",
  netPayout: "900.00",
};

// Sentinel property-level bucket — apartmentId null, no per-unit actions.
const sentinelUnit = {
  apartmentId: null,
  unitCode: "Unassigned / property-level",
  incomeCollected: "50.00",
  depositCollected: "0.00",
  deductibleExpenses: "20.00",
  netPayout: "30.00",
} as unknown as UnitPayoutRow;

function renderCard(unit: UnitPayoutRow) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <UnitSummaryCard unit={unit} ownerPartyId="owner-1" month="2026-06" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockNavigate.mockClear();
  // Default: no proofs attached (overridden per-test in the Task 5 suite below).
  vi.mocked(useExpenseProofs).mockReturnValue(
    ({ data: { data: [] }, isLoading: false, isError: false }) as never,
  );
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("UnitSummaryCard — figures", () => {
  it("renders the unit code and the 4 payout figures that foot", () => {
    renderCard(realUnit);

    // Unit heading
    expect(screen.getByText("A-10-04")).toBeInTheDocument();

    // 4 figure labels
    expect(screen.getByText(/Income Collected/i)).toBeInTheDocument();
    expect(screen.getByText(/Deposit Collected/i)).toBeInTheDocument();
    expect(screen.getByText(/Deductible Expenses/i)).toBeInTheDocument();
    expect(screen.getByText(/Net Payout/i)).toBeInTheDocument();

    // Figures render formatted
    expect(screen.getByText("RM 1,000.00")).toBeInTheDocument(); // income
    expect(screen.getByText("RM 200.00")).toBeInTheDocument(); // deposit
    expect(screen.getByText("RM 900.00")).toBeInTheDocument(); // net

    // Footing invariant: income + deposit − deductible === net
    const income = Number(realUnit.incomeCollected);
    const deposit = Number(realUnit.depositCollected);
    const deductible = Number(realUnit.deductibleExpenses);
    const net = Number(realUnit.netPayout);
    expect(income + deposit - deductible).toBeCloseTo(net, 2);
  });
});

describe("UnitSummaryCard — real apartment actions", () => {
  it("Print Invoice downloads the bills-merged receipt scoped to this unit + month", async () => {
    renderCard(realUnit);

    const printBtn = screen.getByRole("button", { name: /Print Invoice/i });
    expect(printBtn).toBeInTheDocument();
    fireEvent.click(printBtn);

    await waitFor(() => {
      expect(mockDownloadReceipt).toHaveBeenCalledTimes(1);
    });
    // Wired to the row's apartmentId + month (+ owner).
    expect(mockDownloadReceipt).toHaveBeenCalledWith("owner-1", "2026-06", "apt-1");
  });

  it("Attach bills opens a panel hosting BulkBillAttach for this unit + month", async () => {
    renderCard(realUnit);

    const attachBtn = screen.getByRole("button", { name: /Attach bills/i });
    expect(attachBtn).toBeInTheDocument();
    fireEvent.click(attachBtn);

    // BulkBillAttach renders its dropzone (aria-label "Upload supporting bills").
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Upload supporting bills/i }),
      ).toBeInTheDocument();
    });
  });

  it("Per-unit statement navigates to this unit's statement page", () => {
    renderCard(realUnit);

    const stmtBtn = screen.getByRole("button", { name: /Per-unit statement/i });
    expect(stmtBtn).toBeInTheDocument();
    fireEvent.click(stmtBtn);

    // Opens the per-unit statement route scoped to this owner + apartment + month.
    expect(mockNavigate).toHaveBeenCalledWith(
      "/tenancy/owners/owner-1/units/apt-1/statements/2026-06",
    );
  });
});

describe("UnitSummaryCard — property-level sentinel (apartmentId null)", () => {
  it("renders the figures but NO Print/Attach actions", () => {
    renderCard(sentinelUnit);

    // Figures still render.
    expect(screen.getByText("Unassigned / property-level")).toBeInTheDocument();
    expect(screen.getByText("RM 50.00")).toBeInTheDocument(); // income
    expect(screen.getByText("RM 30.00")).toBeInTheDocument(); // net

    // Actions are absent — there's no apartment to scope to.
    expect(screen.queryByRole("button", { name: /Print Invoice/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Attach bills/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Per-unit statement/i })).not.toBeInTheDocument();
  });
});

// ── Task 3: click card body → open full statement ───────────────────────────────

describe("UnitSummaryCard — navigation to full statement (Task 3)", () => {
  it("clicking the card body navigates to the per-unit statement route for a real apartment", () => {
    renderCard(realUnit);
    // The heading+figures area is wrapped in a role="button" div
    const cardBody = screen.getByRole("button", { name: /View full statement for A-10-04/i });
    fireEvent.click(cardBody);
    expect(mockNavigate).toHaveBeenCalledWith(
      "/tenancy/owners/owner-1/units/apt-1/statements/2026-06",
    );
  });

  it("pressing Enter on the card body navigates to the per-unit statement route", () => {
    renderCard(realUnit);
    const cardBody = screen.getByRole("button", { name: /View full statement for A-10-04/i });
    fireEvent.keyDown(cardBody, { key: "Enter" });
    expect(mockNavigate).toHaveBeenCalledWith(
      "/tenancy/owners/owner-1/units/apt-1/statements/2026-06",
    );
  });

  it("clicking Print Invoice does NOT navigate", async () => {
    mockDownloadReceipt.mockResolvedValue(undefined);
    renderCard(realUnit);
    const printBtn = screen.getByRole("button", { name: /Print Invoice/i });
    fireEvent.click(printBtn);
    await waitFor(() => expect(mockDownloadReceipt).toHaveBeenCalled());
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("clicking Attach bills does NOT navigate", () => {
    renderCard(realUnit);
    fireEvent.click(screen.getByRole("button", { name: /Attach bills/i }));
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("sentinel card (apartmentId null) has NO clickable card body and does NOT navigate", () => {
    renderCard(sentinelUnit);
    // No role="button" on the card body for the sentinel
    expect(
      screen.queryByRole("button", { name: /View full statement/i }),
    ).toBeNull();
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});

// ── Task 5: attachment count badge ─────────────────────────────────────────────
//
// UnitSummaryCard calls useExpenseProofs(ownerPartyId, month, apartmentId) for
// real apartments and renders a small count badge near "Attach bills" when the
// total proof count across all groups is > 0.
//
function mockProofsReturnValue(groups: ExpenseProofGroup[]) {
  vi.mocked(useExpenseProofs).mockReturnValue(
    ({ data: { data: groups }, isLoading: false, isError: false }) as never,
  );
}

describe("UnitSummaryCard — Task 5: attachment count badge", () => {
  it("shows a badge with the total proof count when proofs exist across multiple groups", () => {
    mockProofsReturnValue([
      {
        category: "tnb",
        proofs: [
          { id: "p1", filename: "tnb-jun.pdf", url: "https://s.example/p1" },
          { id: "p2", filename: "water-jun.pdf", url: "https://s.example/p2" },
        ],
      },
      {
        category: "cleaning",
        proofs: [
          { id: "p3", filename: "clean-jun.pdf", url: "https://s.example/p3" },
        ],
      },
    ]);

    renderCard(realUnit);

    // Badge element is present and shows the aggregate count (2 + 1 = 3).
    const badge = screen.getByTestId("attachment-count-badge");
    expect(badge).toBeTruthy();
    expect(badge.textContent).toBe("3");
  });

  it("shows no badge when there are 0 proofs (default empty return)", () => {
    // beforeEach sets useExpenseProofs to return { data: { data: [] } }
    renderCard(realUnit);
    expect(screen.queryByTestId("attachment-count-badge")).toBeNull();
  });

  it("sentinel card (apartmentId null) shows no badge regardless of proof data", () => {
    // Even though useExpenseProofs returns data, the sentinel card suppresses the badge.
    mockProofsReturnValue([
      {
        category: "tnb",
        proofs: [{ id: "p1", filename: "tnb.pdf", url: "https://s.example/p1" }],
      },
    ]);

    renderCard(sentinelUnit);
    expect(screen.queryByTestId("attachment-count-badge")).toBeNull();
  });
});
