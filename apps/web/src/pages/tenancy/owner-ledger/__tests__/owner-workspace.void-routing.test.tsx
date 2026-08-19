// Void integrity (web) — route the OWNER-workspace ledger-row "Void" button by
// the entry's source kind, instead of always firing the shallow
// { kind: "void", entry } overlay. This is the owner-level (all-units) mirror
// of ../unit-workspace.void-routing.test.tsx:
//   - charge-derived (sourceChargeId set)         -> fetch GET /billing/charges/:id
//                                                     and open the REUSED VoidChargeDialog
//                                                     (real money+document void).
//   - bill-derived (sourceUtilityBillId set,
//     sourceChargeId null)                        -> informational pointer, no mutation.
//   - manual (both null)                          -> existing shallow overlay, unchanged.
//
// Same mocking approach as the sibling: mock apiFetch + sonner, render the REAL
// VoidChargeDialog / useVoidLedgerEntry, and assert on routing only. The dialog's
// own validation/refund/fork logic is covered by void-charge-dialog's own tests.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";

vi.mock("@/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-client")>();
  return { ...actual, apiFetch: vi.fn() };
});
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { apiFetch, ApiError } from "@/lib/api-client";
import { toast } from "sonner";
import { AuthContext, type User } from "@/lib/auth";
import type { OwnerLedgerEntryRow } from "@/api/owner-ledger";
import OwnerWorkspacePage from "../owner-workspace";

const apiFetchMock = vi.mocked(apiFetch);
const toastInfoMock = vi.mocked(toast.info);
const toastErrorMock = vi.mocked(toast.error);

const OWNER_SUMMARY = {
  grossRental: "0.00",
  totalExpenses: "150.00",
  netRentalAfterExpenses: "-150.00",
  netPayoutToOwner: "-150.00",
  payoutsTotal: "0.00",
  byCategory: {},
  broughtForward: "0.00",
  periodGross: "0.00",
  periodExpenses: "150.00",
  periodPayouts: "0.00",
  netThisPeriod: "-150.00",
  depositCollected: "0.00",
  carriedForward: "-150.00",
};

const UNITS_SUMMARY = {
  month: "2026-07",
  combined: null,
  units: [],
};

// Base ledger-row fixture. Per-test overrides flip sourceChargeId /
// sourceUtilityBillId to drive each of the three routing branches. Kept as an
// EXPENSE so it lands in the All-Entries tab's Expenses section (not the
// always-visible Payout-history panel).
const BASE_ENTRY: OwnerLedgerEntryRow = {
  id: "entry-1",
  organizationId: "org-1",
  ownerPartyId: "owner-1",
  propertyId: "prop-1",
  apartmentId: "apt-1",
  unitCode: "A-10-04",
  listingId: null,
  tenancyId: null,
  statementMonth: "2026-07-01T00:00:00.000Z",
  transactionDate: "2026-07-05T00:00:00.000Z",
  direction: "expense",
  category: "utilities_tnb",
  description: "Electricity — July 2026",
  remarks: null,
  amount: "150.00",
  chargedAmount: null,
  debitAdjustmentAmount: "0.00",
  creditAdjustmentAmount: "0.00",
  sstAmount: null,
  paidBy: "kaen",
  paymentStatus: "pending",
  taxCategory: "not_applicable",
  includeInPayout: true,
  attachmentKeys: [],
  sourceType: "manual",
  sourceChargeId: null,
  sourceUtilityBillId: null,
  status: "active",
  createdById: "admin-1",
  updatedById: "admin-1",
  createdAt: "2026-07-05T00:00:00.000Z",
  updatedAt: "2026-07-05T00:00:00.000Z",
};

function stubApi(entry: OwnerLedgerEntryRow) {
  apiFetchMock.mockImplementation((path: string) => {
    if (path === "/parties/owners") {
      return Promise.resolve({
        data: [{ id: "owner-1", displayName: "Dato' Razak" }],
      }) as ReturnType<typeof apiFetch>;
    }
    if (path.startsWith("/owner-ledger/summary")) {
      return Promise.resolve({ data: OWNER_SUMMARY }) as ReturnType<typeof apiFetch>;
    }
    if (path.startsWith("/owner-ledger/owners/owner-1/units-summary")) {
      return Promise.resolve({ data: UNITS_SUMMARY }) as ReturnType<typeof apiFetch>;
    }
    if (path.startsWith("/owner-ledger/entries")) {
      return Promise.resolve({ data: { rows: [entry], total: 1 } }) as ReturnType<typeof apiFetch>;
    }
    if (path === "/billing/charges/c-1") {
      return Promise.resolve({ id: "c-1", chargeNumber: "CH-1", status: "posted" }) as ReturnType<
        typeof apiFetch
      >;
    }
    if (path === "/billing/charges/c-x") {
      return Promise.reject(
        new ApiError("CHARGE_NOT_FOUND", 404, undefined, { error: "CHARGE_NOT_FOUND" }),
      ) as ReturnType<typeof apiFetch>;
    }
    if (path === "/billing/charges/c-err") {
      return Promise.reject(new ApiError("Server error", 500)) as ReturnType<typeof apiFetch>;
    }
    return Promise.resolve({ data: { rows: [], total: 0 } }) as ReturnType<typeof apiFetch>;
  });
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const user: User = {
    id: "u1",
    fullName: "Test Admin",
    email: "admin@example.com",
    role: "admin",
    orgId: "org-1",
  };
  return render(
    <QueryClientProvider client={client}>
      <AuthContext.Provider value={{ user, setAuth: () => {}, clearAuth: () => {}, isAuthenticated: true }}>
        <MemoryRouter initialEntries={["/tenancy/owner-ledger/owner-1"]}>
          <Routes>
            <Route path="/tenancy/owner-ledger/:ownerPartyId" element={<OwnerWorkspacePage />} />
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

// The ledger rows live on the secondary "All Entries" tab — switch to it and
// wait for the row before exercising its Void button.
async function openEntriesTabRow() {
  fireEvent.click(await screen.findByRole("tab", { name: /All Entries/i }));
  return screen.findByRole("row", { name: /Entry entry-1/i });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("OwnerWorkspacePage — ledger-row Void routing by source kind (void integrity)", () => {
  it("charge-derived opens dialog: fetches the charge and opens VoidChargeDialog, not the shallow void overlay", async () => {
    const entry: OwnerLedgerEntryRow = { ...BASE_ENTRY, sourceChargeId: "c-1", sourceUtilityBillId: null };
    stubApi(entry);
    renderPage();

    const row = await openEntriesTabRow();
    fireEvent.click(within(row).getByRole("button", { name: /Void entry entry-1/i }));

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith("/billing/charges/c-1");
    });
    // VoidChargeDialog opened with the resolved charge — its title (an h2,
    // distinct from its own "Void & issue Credit Note" submit BUTTON, which
    // shares the same text) only renders once `charge !== null`.
    expect(
      await screen.findByRole("heading", { name: /Void & issue Credit Note/i }),
    ).toBeInTheDocument();
    // The shallow void confirm must NOT have opened instead.
    expect(screen.queryByText(/Void this ledger entry\?/i)).not.toBeInTheDocument();
    // And no shallow-void mutation fired (POST .../entries/:id/void).
    expect(apiFetchMock).not.toHaveBeenCalledWith(
      "/owner-ledger/entries/entry-1/void",
      expect.anything(),
    );
  });

  it("bill-derived affordance: shows the utility-bill pointer and does not fire the shallow-void mutation", async () => {
    const entry: OwnerLedgerEntryRow = {
      ...BASE_ENTRY,
      sourceChargeId: null,
      sourceUtilityBillId: "b-1",
    };
    stubApi(entry);
    renderPage();

    const row = await openEntriesTabRow();
    fireEvent.click(within(row).getByRole("button", { name: /Void entry entry-1/i }));

    await waitFor(() => {
      expect(toastInfoMock).toHaveBeenCalled();
    });
    expect(toastInfoMock.mock.calls[0]![0]).toMatch(/utility bill/i);
    // No shallow-void mutation call (POST .../entries/:id/void).
    expect(apiFetchMock).not.toHaveBeenCalledWith(
      "/owner-ledger/entries/entry-1/void",
      expect.anything(),
    );
    // Neither dialog opens.
    expect(screen.queryByRole("heading", { name: /Void & issue Credit Note/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/Void this ledger entry\?/i)).not.toBeInTheDocument();
    // The charge fetch must NOT have fired either.
    expect(apiFetchMock).not.toHaveBeenCalledWith("/billing/charges/c-1");
  });

  // NOTE (Existing-Behavior Rule): the manual (both-null) path is the
  // pre-existing, UNCHANGED default — it was the only thing the old
  // unconditional `onClick={() => setOverlay({ kind: "void", entry })}` ever
  // did. Kept as a permanent regression guard: the "Void this ledger entry?"
  // text it checks for only ever renders from the manual/shallow overlay
  // branch (charge-derived renders the "Void & issue Credit Note" dialog,
  // bill-derived renders no overlay at all), so a mis-route into either other
  // branch would fail this assertion.
  it("manual shallow void: opens the existing shallow void overlay unchanged", async () => {
    const entry: OwnerLedgerEntryRow = {
      ...BASE_ENTRY,
      sourceChargeId: null,
      sourceUtilityBillId: null,
    };
    stubApi(entry);
    renderPage();

    const row = await openEntriesTabRow();
    fireEvent.click(within(row).getByRole("button", { name: /Void entry entry-1/i }));

    expect(await screen.findByText(/Void this ledger entry\?/i)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Void & issue Credit Note/i })).not.toBeInTheDocument();
    expect(apiFetchMock).not.toHaveBeenCalledWith("/billing/charges/c-1");
    expect(toastInfoMock).not.toHaveBeenCalled();
  });

  // Fail-loud parity with unit-workspace.tsx: a 404 on the charge fetch means
  // the sync desynced (the charge this row pointed to is gone) — surface the
  // "no linked charge" copy and close the overlay so the dialog does not sit
  // silently never-opening after the admin clicked Void on a money row.
  it("charge fetch 404: shows the no-linked-charge toast and closes the overlay (no dialog)", async () => {
    const entry: OwnerLedgerEntryRow = {
      ...BASE_ENTRY,
      sourceChargeId: "c-x",
      sourceUtilityBillId: null,
    };
    stubApi(entry);
    renderPage();

    const row = await openEntriesTabRow();
    fireEvent.click(within(row).getByRole("button", { name: /Void entry entry-1/i }));

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith("/billing/charges/c-x");
    });
    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith(expect.stringMatching(/no linked charge/i));
    });
    // Overlay closed → the dialog does not appear.
    expect(screen.queryByRole("heading", { name: /Void & issue Credit Note/i })).not.toBeInTheDocument();
  });

  // A non-404 fetch failure (network blip / 500) must NOT be mislabeled as
  // "no linked charge" — that would misdirect the admin into thinking the sync
  // desynced when it is really transient. Generic retry copy, overlay closed.
  it("charge fetch non-404 error: shows a generic retry toast (not no-linked-charge) and closes the overlay", async () => {
    const entry: OwnerLedgerEntryRow = {
      ...BASE_ENTRY,
      sourceChargeId: "c-err",
      sourceUtilityBillId: null,
    };
    stubApi(entry);
    renderPage();

    const row = await openEntriesTabRow();
    fireEvent.click(within(row).getByRole("button", { name: /Void entry entry-1/i }));

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith(expect.stringMatching(/could not load/i));
    });
    expect(toastErrorMock).not.toHaveBeenCalledWith(expect.stringMatching(/no linked charge/i));
    expect(screen.queryByRole("heading", { name: /Void & issue Credit Note/i })).not.toBeInTheDocument();
  });
});
