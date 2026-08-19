// Smoke tests for MonthReviewSheet (M6b / T4).
// - Renders owner select + month input + Sync button
// - Shows 4 summary GlowCards with formatted values when summary data is loaded
// - Sync button calls useSyncMonth().mutate with the correct args + shows toast
// - Entries table renders when entries are loaded
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import React from "react";

// ── Mocks ──────────────────────────────────────────────────────────────────────

vi.mock("@/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-client")>();
  return { ...actual, apiFetch: vi.fn() };
});

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

import { toast } from "sonner";

// Mock API hooks
const mockSyncMutate = vi.fn();
const mockDownloadLivePdf = vi.fn();

// The sheet downloads a LIVE statement PDF — rendered on demand, stored nowhere.
// It no longer issues anything: the management fee is minted by the payment hook
// when rent settles, so the manual issuer was removed.
vi.mock("@/api/owner-billing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/owner-billing")>();
  return {
    ...actual,
    downloadLiveStatementPdf: (args: unknown) => mockDownloadLivePdf(args),
  };
});

const mockSummary = {
  grossRental: "5000.00",
  totalExpenses: "800.00",
  netRentalAfterExpenses: "4200.00",
  netPayoutToOwner: "3800.00",
  byCategory: {
    rental_income: "5000.00",
    management_fee: "400.00",
    maintenance: "400.00",
  },
};

const mockEntries = [
  {
    id: "entry-1",
    organizationId: "org-1",
    ownerPartyId: "owner-1",
    propertyId: "prop-1",
    listingId: null,
    tenancyId: null,
    statementMonth: "2026-06-01T00:00:00.000Z",
    transactionDate: "2026-06-15",
    direction: "income" as const,
    category: "rental_income" as const,
    description: "June rent",
    remarks: null,
    amount: "5000.00",
    sstAmount: null,
    paidBy: "kaen" as const,
    paymentStatus: "paid" as const,
    taxCategory: "not_applicable" as const,
    includeInPayout: true,
    attachmentKeys: [],
    sourceType: "manual",
    status: "active",
    createdById: "admin-1",
    updatedById: "admin-1",
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  },
];

vi.mock("@/api/owner-ledger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/owner-ledger")>();
  return {
    ...actual,
    useSyncMonth: () => ({
      mutate: mockSyncMutate,
      isPending: false,
    }),
    useOwnerLedgerSummary: () => ({
      data: { data: mockSummary },
      isLoading: false,
      isError: false,
    }),
    useOwnerLedgerEntries: () => ({
      data: { data: { rows: mockEntries, total: 1 } },
      isLoading: false,
    }),
  };
});

// Mock owners query (useQuery for /parties/owners)
vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useQuery: (opts: { queryKey: unknown[] }) => {
      // owners query
      if (Array.isArray(opts.queryKey) && opts.queryKey[0] === "owners") {
        return {
          data: {
            data: [
              { id: "owner-1", displayName: "Tan Sri Lim" },
              { id: "owner-2", displayName: "Datuk Wong" },
            ],
          },
          isLoading: false,
        };
      }
      return { data: undefined, isLoading: false };
    },
  };
});

import { MonthReviewSheet } from "../month-review-sheet";

// ── Render helper ───────────────────────────────────────────────────────────────

function renderSheet(props: Partial<React.ComponentProps<typeof MonthReviewSheet>> = {}) {
  const onClose = vi.fn();
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <MonthReviewSheet
          open={true}
          onClose={onClose}
          initialOwnerPartyId="owner-1"
          initialMonth="2026-06"
          {...props}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { onClose };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("MonthReviewSheet — render", () => {
  it("renders the sheet title", () => {
    renderSheet();
    expect(screen.getByText(/Month review/i)).toBeInTheDocument();
  });

  it("renders owner select + month input", () => {
    renderSheet();
    expect(screen.getByRole("combobox", { name: /Owner/i })).toBeInTheDocument();
    // Use exact aria-label to avoid matching "Month review" in the title
    expect(screen.getByLabelText("Month")).toBeInTheDocument();
  });

  it("renders the Sync this month button", () => {
    renderSheet();
    expect(screen.getByTestId("sync-button")).toBeInTheDocument();
  });

  it("renders 4 summary GlowCards with formatted RM values", () => {
    renderSheet();
    // GlowCards — assert the data-testid values
    expect(screen.getByTestId("gross-rental")).toHaveTextContent("RM 5,000.00");
    expect(screen.getByTestId("total-expenses")).toHaveTextContent("RM 800.00");
    expect(screen.getByTestId("net-rental")).toHaveTextContent("RM 4,200.00");
    expect(screen.getByTestId("net-payout")).toHaveTextContent("RM 3,800.00");
  });

  it("renders the entries table with entry data", () => {
    renderSheet();
    // The table caption
    expect(screen.getByRole("table", { name: /Ledger entries/i })).toBeInTheDocument();
    // Entry data — date appears only in the table
    expect(screen.getByText("2026-06-15")).toBeInTheDocument();
    // "Rental Income" may appear in byCategory list + table — use getAllByText
    const rentalIncomeEls = screen.getAllByText("Rental Income");
    expect(rentalIncomeEls.length).toBeGreaterThanOrEqual(1);
  });

  it("renders no manual management-fee issuer", () => {
    renderSheet();
    expect(screen.queryByTestId("issue-management-fee-button")).not.toBeInTheDocument();
  });
});

describe("MonthReviewSheet — sync", () => {
  it("calls useSyncMonth mutate with ownerPartyId + month on Sync click", async () => {
    mockSyncMutate.mockImplementation(
      (_body: unknown, opts: { onSuccess?: (res: unknown) => void }) => {
        opts?.onSuccess?.({ data: { created: 3, updated: 1, skipped: 0 } });
      },
    );

    renderSheet({ initialOwnerPartyId: "owner-1", initialMonth: "2026-06" });

    fireEvent.click(screen.getByTestId("sync-button"));

    await waitFor(() => {
      expect(mockSyncMutate).toHaveBeenCalledTimes(1);
    });

    const [body] = mockSyncMutate.mock.calls[0] as [{ ownerPartyId: string; month: string }, unknown];
    expect(body.ownerPartyId).toBe("owner-1");
    expect(body.month).toBe("2026-06");
  });

  it("shows success toast with created/updated/skipped counts", async () => {
    mockSyncMutate.mockImplementation(
      (_body: unknown, opts: { onSuccess?: (res: unknown) => void }) => {
        opts?.onSuccess?.({ data: { created: 3, updated: 1, skipped: 0 } });
      },
    );

    renderSheet({ initialOwnerPartyId: "owner-1", initialMonth: "2026-06" });

    fireEvent.click(screen.getByTestId("sync-button"));

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith(
        expect.stringMatching(/3 created.*1 updated.*0 skipped/i),
      );
    });
  });

  it("shows error toast when sync fails", async () => {
    mockSyncMutate.mockImplementation(
      (_body: unknown, opts: { onError?: (err: Error) => void }) => {
        opts?.onError?.(new Error("Sync failed — owner not found"));
      },
    );

    renderSheet({ initialOwnerPartyId: "owner-1", initialMonth: "2026-06" });

    fireEvent.click(screen.getByTestId("sync-button"));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Sync failed — owner not found");
    });
  });

  it("disables Sync button when no owner is selected", () => {
    renderSheet({ initialOwnerPartyId: "", initialMonth: "2026-06" });
    const syncBtn = screen.getByTestId("sync-button");
    expect(syncBtn).toBeDisabled();
    expect(mockSyncMutate).not.toHaveBeenCalled();
  });
});

// ── No manual management-fee issuer ────────────────────────────────────────────
// The "Issue management fee" action was removed (2026-08-01). The fee is minted
// automatically the moment a rent Charge reaches `paid` (afterPaymentSettled →
// issueMgmtFeeForPaidRent calls the same generateStatementService the button
// called), so the click was a no-op in the normal case — and on a month whose
// rent was NOT fully settled it billed the fee off CONTRACTED rent while the
// owner ledger deducts off COLLECTED, the exact mismatch the hook removed.

describe("MonthReviewSheet — no manual issuer", () => {
  it("offers no way to issue the management fee by hand", () => {
    renderSheet({ initialOwnerPartyId: "owner-1", initialMonth: "2026-06" });
    expect(screen.queryByTestId("issue-management-fee-button")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /issue/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/Issue the management fee\?/i)).not.toBeInTheDocument();
  });
});

// ── Live statement PDF ─────────────────────────────────────────────────────────
// Rendered on demand from the posted ledger and stored NOWHERE, so it needs no
// issued statement and no confirm — it writes nothing. This is admin's working
// copy; the owner's copy comes from the frozen month-end snapshot instead.

describe("MonthReviewSheet — live statement PDF", () => {
  it("downloads with the selected owner + month, and no apartmentId (combined)", async () => {
    mockDownloadLivePdf.mockResolvedValue(undefined);
    renderSheet({ initialOwnerPartyId: "owner-1", initialMonth: "2026-06" });

    fireEvent.click(screen.getByTestId("download-statement-pdf-button"));

    await waitFor(() => {
      expect(mockDownloadLivePdf).toHaveBeenCalledTimes(1);
    });
    expect(mockDownloadLivePdf).toHaveBeenCalledWith({
      ownerPartyId: "owner-1",
      billingMonth: "2026-06",
    });
  });

  it("does NOT go through a confirm dialog — the render writes nothing", async () => {
    mockDownloadLivePdf.mockResolvedValue(undefined);
    renderSheet({ initialOwnerPartyId: "owner-1", initialMonth: "2026-06" });

    fireEvent.click(screen.getByTestId("download-statement-pdf-button"));

    // The issue-flow confirm must not appear, and the fetch fires immediately.
    expect(screen.queryByText(/Issue the management fee\?/i)).not.toBeInTheDocument();
    await waitFor(() => expect(mockDownloadLivePdf).toHaveBeenCalledTimes(1));
  });

  it("surfaces a render failure instead of reporting success", async () => {
    mockDownloadLivePdf.mockRejectedValue(new Error("Download failed (500)"));
    renderSheet({ initialOwnerPartyId: "owner-1", initialMonth: "2026-06" });

    fireEvent.click(screen.getByTestId("download-statement-pdf-button"));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Download failed (500)");
    });
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("re-enables the button after a failure so a retry is possible", async () => {
    mockDownloadLivePdf.mockRejectedValue(new Error("boom"));
    renderSheet({ initialOwnerPartyId: "owner-1", initialMonth: "2026-06" });

    const btn = screen.getByTestId("download-statement-pdf-button");
    fireEvent.click(btn);

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    await waitFor(() => expect(btn).not.toBeDisabled());
  });

  it("is disabled when no owner is selected", () => {
    renderSheet({ initialOwnerPartyId: "", initialMonth: "2026-06" });
    expect(screen.getByTestId("download-statement-pdf-button")).toBeDisabled();
    expect(mockDownloadLivePdf).not.toHaveBeenCalled();
  });
});

// ── Income/Expenses grouping (owner-ledger view clarity, Task 4) ───────────────
// Wires the Task-3 shared helpers (ownerLedgerRowStatus / groupByDirection,
// ../ledger-presentation) into the entries table: two headed sections instead
// of a flat list, a share-cost Callout above Expenses, and each row's pill
// driven by settlement status instead of raw direction/paymentStatus.
const GROUPING_FIXTURE = [
  {
    ...mockEntries[0],
    id: "g-income-1",
    direction: "income" as const,
    category: "rental_income" as const,
    paymentStatus: "paid" as const,
    paidBy: "kaen" as const,
    includeInPayout: true,
    amount: "1200.00",
  },
  {
    ...mockEntries[0],
    id: "g-expense-kaen",
    direction: "expense" as const,
    category: "utilities_tnb" as const,
    paymentStatus: "pending" as const,
    paidBy: "kaen" as const,
    includeInPayout: true,
    amount: "120.00",
  },
  {
    ...mockEntries[0],
    id: "g-expense-owner",
    direction: "expense" as const,
    category: "fire_insurance" as const,
    paymentStatus: "paid" as const,
    paidBy: "owner" as const,
    includeInPayout: false,
    amount: "80.00",
  },
  // Payout row (owner-ledger view clarity, Task 4 regression fix) — paymentStatus
  // deliberately "pending" (not "paid"/"paid"-adjacent) so its rendered label is
  // unambiguous against the Income/Expenses rows above: if this were wrongly
  // routed through ownerLedgerRowStatus (whose non-income branch reads
  // includeInPayout, false here same as an owner-paid expense) it would show
  // "Owner-paid" instead — see the dedicated regression test below.
  {
    ...mockEntries[0],
    id: "g-payout-1",
    direction: "payout" as const,
    category: "owner_payout" as const,
    paymentStatus: "pending" as const,
    paidBy: "kaen" as const,
    includeInPayout: false,
    amount: "450.00",
  },
];

describe("MonthReviewSheet — Income/Expenses grouping (Task 4)", () => {
  it("groups Income/Expenses, labels status via ownerLedgerRowStatus, shows the Callout", async () => {
    // Override just this test's entries fixture — mirrors the established
    // spy-override pattern in owner-workspace.test.tsx's empty-state test
    // (vi.spyOn over the already vi.mock'd module, restored in `finally`).
    const ownerLedgerModule = await import("@/api/owner-ledger");
    const spy = vi.spyOn(ownerLedgerModule, "useOwnerLedgerEntries").mockReturnValue(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only cast to avoid the full UseQueryResult shape
      { data: { data: { rows: GROUPING_FIXTURE, total: GROUPING_FIXTURE.length } }, isLoading: false } as any,
    );
    try {
      renderSheet();
      expect(screen.getByText(/Income \(money in\)/)).toBeInTheDocument();
      expect(screen.getByText(/Expenses \(paid by KAEN, deducted from payout\)/)).toBeInTheDocument();
      expect(screen.getByText("Deducted")).toBeInTheDocument(); // KAEN-paid expense
      expect(screen.getByText("Owner-paid")).toBeInTheDocument(); // owner-paid expense
      expect(screen.getByText(/full supplier bill/)).toBeInTheDocument(); // Callout
    } finally {
      spy.mockRestore();
    }
  });

  it("hides the Expenses section when the month has income-only rows", () => {
    // Default module mock (mockEntries) is a single income-direction row —
    // covers the acceptance criterion "hide empty sections" the other way.
    renderSheet();
    expect(screen.getByText(/Income \(money in\)/)).toBeInTheDocument();
    expect(screen.queryByText(/Expenses \(paid by KAEN/)).not.toBeInTheDocument();
  });
});

// ── Payouts section (owner-ledger view clarity, Task 4 REGRESSION FIX) ────────
// groupByDirection only ever returns {income, expenses} — the review found
// that payout-direction rows were silently dropped from the sheet entirely
// (the original flat list rendered them). Mirrors owner-workspace.tsx's
// third Payouts section: a hide-when-empty group whose status pill resolves
// via getStatusTone(paymentStatus)/labelFor, NOT ownerLedgerRowStatus.
describe("MonthReviewSheet — Payouts section (Task 4 regression fix)", () => {
  it("renders a Payouts section for payout-direction rows instead of dropping them", async () => {
    const ownerLedgerModule = await import("@/api/owner-ledger");
    const spy = vi.spyOn(ownerLedgerModule, "useOwnerLedgerEntries").mockReturnValue(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only cast to avoid the full UseQueryResult shape
      { data: { data: { rows: GROUPING_FIXTURE, total: GROUPING_FIXTURE.length } }, isLoading: false } as any,
    );
    try {
      renderSheet();
      // The section heading + the payout row's amount must both be visible —
      // pre-fix, neither exists in the DOM because groupByDirection drops the
      // row before EntriesTable ever sees it.
      expect(screen.getByText("Payouts")).toBeInTheDocument();
      expect(screen.getByText("RM 450.00")).toBeInTheDocument();
      // Status label must come from getStatusTone("pending")/labelFor
      // ("Pending"), not ownerLedgerRowStatus's non-income branch (which
      // would mislabel this includeInPayout:false row "Owner-paid").
      expect(screen.getByText("Pending")).toBeInTheDocument();
    } finally {
      spy.mockRestore();
    }
  });
});
