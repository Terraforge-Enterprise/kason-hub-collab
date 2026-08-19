import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ReconciliationPanel } from "../reconciliation-panel";
import type { OwnerPayableReconciliation } from "@/api/portal-owner-statements";

const usePortalOwnerReconciliationMock = vi.fn();
vi.mock("@/api/portal-owner-statements", () => ({
  usePortalOwnerReconciliation: (month: string) => usePortalOwnerReconciliationMock(month),
}));

const BASE_RECONCILIATION: OwnerPayableReconciliation = {
  ownerPartyId: "owner-1",
  apartmentId: null,
  periodMonth: "2026-07",
  openingPayableC: 100000, // RM 1,000.00
  collectionsC: 250000, // +RM 2,500.00
  offsetDeductionsC: 30000, // -RM 300.00
  passThroughExpensesC: 20000, // -RM 200.00
  grossRemittancesC: 150000, // -RM 1,500.00
  reversalsC: 5000, // +RM 50.00
  closingPayableC: 155000, // RM 1,550.00 (1000+2500-300-200-1500+50)
  balanced: true,
  discrepancyC: 0,
  periodStatus: "open",
  frozenNetPayableAtCloseC: null,
  remainingPayableNowC: 155000,
};

function mockQuery(overrides: Partial<OwnerPayableReconciliation> = {}) {
  usePortalOwnerReconciliationMock.mockReturnValue({
    data: { data: { ...BASE_RECONCILIATION, ...overrides } },
    isLoading: false,
    isError: false,
  });
}

beforeEach(() => {
  usePortalOwnerReconciliationMock.mockReset();
});

describe("ReconciliationPanel", () => {
  it("renders all 7 waterfall rows with correct labels, signs, and amounts", () => {
    mockQuery();
    render(<ReconciliationPanel month="2026-07" />);

    expect(screen.getByText("Opening payable")).toBeInTheDocument();
    expect(screen.getByText("Collections received")).toBeInTheDocument();
    expect(screen.getByText("Offset settlements")).toBeInTheDocument();
    expect(screen.getByText("Pass-through expenses")).toBeInTheDocument();
    expect(screen.getByText("Gross remittances")).toBeInTheDocument();
    expect(screen.getByText("Reversals & corrections")).toBeInTheDocument();
    expect(screen.getByText("Closing payable")).toBeInTheDocument();

    expect(screen.getByText(/\+ RM 2,500\.00/)).toBeInTheDocument();
    expect(screen.getByText(/\+ RM 50\.00/)).toBeInTheDocument();
    expect(screen.getByText(/− RM 300\.00/)).toBeInTheDocument();
    expect(screen.getByText(/− RM 200\.00/)).toBeInTheDocument();
    expect(screen.getByText(/− RM 1,500\.00/)).toBeInTheDocument();

    expect(screen.getAllByText("RM 1,000.00").length).toBeGreaterThan(0); // opening running total
    expect(screen.getAllByText("RM 1,550.00").length).toBeGreaterThan(0); // closing running total

    // Row order matches R15's formula order exactly (table rows, not just presence).
    const rows = screen.getAllByRole("row");
    const bodyRowLabels = rows.slice(1).map((r) => r.textContent); // rows[0] is the header row
    expect(bodyRowLabels[0]).toContain("Opening payable");
    expect(bodyRowLabels[1]).toContain("Collections received");
    expect(bodyRowLabels[2]).toContain("Offset settlements");
    expect(bodyRowLabels[3]).toContain("Pass-through expenses");
    expect(bodyRowLabels[4]).toContain("Gross remittances");
    expect(bodyRowLabels[5]).toContain("Reversals & corrections");
    expect(bodyRowLabels[6]).toContain("Closing payable");

    // Representative increase row (Collections): green class + ArrowUp icon present.
    const collectionsRow = rows[2]; // header + opening + collections
    expect(collectionsRow.querySelector(".text-emerald-600")).not.toBeNull();
    expect(collectionsRow.querySelector("svg.lucide-arrow-up")).not.toBeNull();

    // Representative decrease row (Offset settlements): rose class + ArrowDown icon present.
    const offsetsRow = rows[3];
    expect(offsetsRow.querySelector(".text-rose-600")).not.toBeNull();
    expect(offsetsRow.querySelector("svg.lucide-arrow-down")).not.toBeNull();
  });

  it("never renders a self-contradictory sign/color/icon if a row's amount is unexpectedly negative (defense-in-depth against a contract-violating API value)", () => {
    // The contract says collectionsC is an unsigned magnitude, but nothing at
    // runtime enforces that — assert the display never shows a negative-
    // looking figure (which would contradict its own green "+" sign/icon) if
    // the server ever sends one. Distinct from the other fields' amounts so
    // the assertion targets this row unambiguously.
    mockQuery({ collectionsC: -12300 });
    render(<ReconciliationPanel month="2026-07" />);
    expect(screen.queryByText(/RM -123\.00/)).not.toBeInTheDocument();
    expect(screen.getByText(/\+ RM 123\.00/)).toBeInTheDocument();
  });

  it("shows the Reconciled pill when balanced, the discrepancy alert when not", () => {
    mockQuery({ balanced: true });
    const { rerender } = render(<ReconciliationPanel month="2026-07" />);
    expect(screen.getByText("Reconciled")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    mockQuery({ balanced: false, discrepancyC: 12345 });
    rerender(<ReconciliationPanel month="2026-07" />);
    expect(screen.queryByText("Reconciled")).not.toBeInTheDocument();
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/discrepancy/i);
    expect(alert).toHaveTextContent("RM 123.45");
  });

  it("never claims a specific zero-amount discrepancy (an internally-inconsistent balanced:false + discrepancyC:0 server response)", () => {
    mockQuery({ balanced: false, discrepancyC: 0 });
    render(<ReconciliationPanel month="2026-07" />);
    const alert = screen.getByRole("alert");
    expect(alert).not.toHaveTextContent("RM 0.00");
    expect(alert).toHaveTextContent(/contact your property manager/i);
  });

  it("also falls back to the generic message for a non-finite discrepancyC (NaN), not 'RM 0.00'", () => {
    mockQuery({ balanced: false, discrepancyC: NaN });
    render(<ReconciliationPanel month="2026-07" />);
    const alert = screen.getByRole("alert");
    expect(alert).not.toHaveTextContent("RM 0.00");
    expect(alert).toHaveTextContent(/contact your property manager/i);
  });

  it("renders both R18 figures, and 'Not yet frozen' when frozenNetPayableAtCloseC is null", () => {
    mockQuery({ frozenNetPayableAtCloseC: null, remainingPayableNowC: 155000 });
    const { rerender } = render(<ReconciliationPanel month="2026-07" />);
    expect(screen.getByText("Not yet frozen")).toBeInTheDocument();
    expect(screen.getByTestId("remaining-payable-now-value")).toHaveTextContent("RM 1,550.00");

    mockQuery({ frozenNetPayableAtCloseC: 155000, remainingPayableNowC: 160000 });
    rerender(<ReconciliationPanel month="2026-07" />);
    expect(screen.queryByText("Not yet frozen")).not.toBeInTheDocument();
    expect(screen.getByTestId("frozen-net-payable-value")).toHaveTextContent("RM 1,550.00");
    expect(screen.getByTestId("remaining-payable-now-value")).toHaveTextContent("RM 1,600.00");
    expect(screen.getByText("Frozen")).toBeInTheDocument();
  });

  it("renders a danger Callout instead of throwing when the fetch errors", () => {
    usePortalOwnerReconciliationMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    });
    render(<ReconciliationPanel month="2026-07" />);
    expect(screen.getByText(/couldn't load your reconciliation/i)).toBeInTheDocument();
  });

  it("defaults to the current wall-clock month when no month prop is given, and passes an explicit month through exactly", () => {
    mockQuery();
    render(<ReconciliationPanel />);
    const now = new Date();
    const expectedDefault = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    expect(usePortalOwnerReconciliationMock).toHaveBeenCalledWith(expectedDefault);

    usePortalOwnerReconciliationMock.mockReset();
    mockQuery();
    render(<ReconciliationPanel month="2026-05" />);
    expect(usePortalOwnerReconciliationMock).toHaveBeenCalledWith("2026-05");
  });
});
