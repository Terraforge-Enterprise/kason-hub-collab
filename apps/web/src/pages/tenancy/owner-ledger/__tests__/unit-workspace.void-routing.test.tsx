// Task 5 (R1, R5a-web) — route the unit-workspace ledger-row "Void" button by
// the entry's source kind, instead of always firing the shallow
// { kind: "void", entry } overlay:
//   - charge-derived (sourceChargeId set)         -> fetch GET /billing/charges/:id
//                                                     and open the REUSED VoidChargeDialog
//                                                     (real money+document void).
//   - bill-derived (sourceUtilityBillId set,
//     sourceChargeId null)                        -> informational pointer, no mutation.
//   - manual (both null)                          -> existing shallow overlay, unchanged.
//
// Mirrors the harness in ../unit-workspace.test.tsx (same mocks, same
// render helper shape) but scoped to ONLY the new routing behavior — the
// dialog's own validation/refund/three-way-fork logic is already covered by
// void-charge-dialog's own test file and unit-workspace.test.tsx's Task 9
// "Void & issue Credit Note" describe block; this file does not re-test it.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
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
import UnitWorkspacePage from "../unit-workspace";

const apiFetchMock = vi.mocked(apiFetch);
const toastInfoMock = vi.mocked(toast.info);
const toastErrorMock = vi.mocked(toast.error);

const CTX = {
  apartmentId: "apt-1",
  unitCode: "A-10-04",
  listingMode: "WHOLE",
  propertyId: "prop-1",
  propertyName: "Areca Residences",
  ownerPartyId: "owner-1",
  ownerName: "Dato' Razak",
  activeTenancies: [],
};

// Base ledger-row fixture. Per-test overrides flip sourceChargeId /
// sourceUtilityBillId to drive each of the three routing branches.
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
    if (path === "/owner-ledger/units/apt-1/context") {
      return Promise.resolve({ data: CTX }) as ReturnType<typeof apiFetch>;
    }
    if (path.startsWith("/owner-ledger/owners/owner-1/units-summary")) {
      return Promise.resolve({
        data: {
          month: "2026-07",
          combined: {
            incomeCollected: "0.00",
            depositCollected: "0.00",
            deductibleExpenses: "150.00",
            netPayout: "-150.00",
          },
          units: [
            {
              apartmentId: "apt-1",
              unitCode: "A-10-04",
              incomeCollected: "0.00",
              depositCollected: "0.00",
              deductibleExpenses: "150.00",
              netPayout: "-150.00",
            },
          ],
        },
      }) as ReturnType<typeof apiFetch>;
    }
    if (path.startsWith("/owner-ledger/entries")) {
      return Promise.resolve({ data: { rows: [entry], total: 1 } }) as ReturnType<typeof apiFetch>;
    }
    if (path.startsWith("/owner-billing/expense-proofs")) {
      return Promise.resolve({ data: [] }) as ReturnType<typeof apiFetch>;
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
        <MemoryRouter initialEntries={["/tenancy/owner-ledger/unit/apt-1"]}>
          <Routes>
            <Route path="/tenancy/owner-ledger/unit/:apartmentId" element={<UnitWorkspacePage />} />
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("UnitWorkspacePage — ledger-row Void routing by source kind (Task 5)", () => {
  it("charge-derived opens dialog: fetches the charge and opens VoidChargeDialog, not the shallow void overlay", async () => {
    const entry: OwnerLedgerEntryRow = { ...BASE_ENTRY, sourceChargeId: "c-1", sourceUtilityBillId: null };
    stubApi(entry);
    renderPage();

    await screen.findByRole("row", { name: /Entry entry-1/i });
    fireEvent.click(screen.getByRole("button", { name: /Void entry entry-1/i }));

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith("/billing/charges/c-1");
    });
    // VoidChargeDialog opened with the resolved charge — its title (an h2,
    // distinct from its own "Void & issue Credit Note" submit BUTTON, which
    // shares the same text) only renders once `charge !== null` (Dialog
    // unmounts content while closed).
    expect(
      await screen.findByRole("heading", { name: /Void & issue Credit Note/i }),
    ).toBeInTheDocument();
    // The shallow void confirm must NOT have opened instead.
    expect(screen.queryByText(/Void this ledger entry\?/i)).not.toBeInTheDocument();
  });

  it("bill-derived affordance: shows the utility-bill pointer and does not fire the shallow-void mutation", async () => {
    const entry: OwnerLedgerEntryRow = {
      ...BASE_ENTRY,
      sourceChargeId: null,
      sourceUtilityBillId: "b-1",
    };
    stubApi(entry);
    renderPage();

    await screen.findByRole("row", { name: /Entry entry-1/i });
    fireEvent.click(screen.getByRole("button", { name: /Void entry entry-1/i }));

    await waitFor(() => {
      expect(toastInfoMock).toHaveBeenCalled();
    });
    expect(toastInfoMock.mock.calls[0]![0]).toMatch(/utility bill/i);
    // No shallow-void mutation call (POST .../entries/:id/void).
    expect(apiFetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining("/owner-ledger/entries/"),
      expect.objectContaining({ method: "POST" }),
    );
    // Neither dialog opens.
    expect(screen.queryByRole("heading", { name: /Void & issue Credit Note/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/Void this ledger entry\?/i)).not.toBeInTheDocument();
  });

  it("charge fetch 404 toast: shows the no-linked-charge toast and does not open the dialog", async () => {
    const entry: OwnerLedgerEntryRow = {
      ...BASE_ENTRY,
      sourceChargeId: "c-x",
      sourceUtilityBillId: null,
    };
    stubApi(entry);
    renderPage();

    await screen.findByRole("row", { name: /Entry entry-1/i });
    fireEvent.click(screen.getByRole("button", { name: /Void entry entry-1/i }));

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith("/billing/charges/c-x");
    });
    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith(expect.stringMatching(/no linked charge/i));
    });
    expect(screen.queryByRole("heading", { name: /Void & issue Credit Note/i })).not.toBeInTheDocument();
  });

  // NOTE (Existing-Behavior Rule): the manual (both-null) path is the
  // pre-existing, UNCHANGED default — it was the only thing the old
  // unconditional `onClick={() => setOverlay({ kind: "void", entry })}` ever
  // did, so this test passes even before Task 5's routing existed. It is
  // kept as a permanent regression guard rather than driven through a fake
  // RED cycle, and it is not a vacuous assertion: the "Void this ledger
  // entry?" text it checks for only ever renders from the manual/shallow
  // overlay branch — the charge-derived branch instead renders the
  // "Void & issue Credit Note" dialog heading, and the bill-derived branch
  // renders no overlay at all (just an info toast) — so a regression that
  // mis-routes this entry into either other branch would fail this
  // assertion.
  it("manual shallow void: opens the existing shallow void overlay unchanged", async () => {
    const entry: OwnerLedgerEntryRow = {
      ...BASE_ENTRY,
      sourceChargeId: null,
      sourceUtilityBillId: null,
    };
    stubApi(entry);
    renderPage();

    await screen.findByRole("row", { name: /Entry entry-1/i });
    fireEvent.click(screen.getByRole("button", { name: /Void entry entry-1/i }));

    expect(await screen.findByText(/Void this ledger entry\?/i)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Void & issue Credit Note/i })).not.toBeInTheDocument();
    expect(apiFetchMock).not.toHaveBeenCalledWith("/billing/charges/c-1");
    expect(toastInfoMock).not.toHaveBeenCalled();
  });

  // B6 (adversarial-audit finding, inline): the routing spec defines
  // bill-derived as "sourceUtilityBillId set AND sourceChargeId null" — i.e.
  // charge-derived takes precedence when (hypothetically) both are set on
  // the same row. Locks in the CHECK ORDER so a future refactor can't
  // silently invert it (e.g. rewriting the branch as an either/or on
  // sourceUtilityBillId first).
  it("priority: an entry with BOTH source ids set routes to the charge dialog, not the bill affordance", async () => {
    const entry: OwnerLedgerEntryRow = {
      ...BASE_ENTRY,
      sourceChargeId: "c-1",
      sourceUtilityBillId: "b-1",
    };
    stubApi(entry);
    renderPage();

    await screen.findByRole("row", { name: /Entry entry-1/i });
    fireEvent.click(screen.getByRole("button", { name: /Void entry entry-1/i }));

    expect(
      await screen.findByRole("heading", { name: /Void & issue Credit Note/i }),
    ).toBeInTheDocument();
    expect(toastInfoMock).not.toHaveBeenCalled();
  });

  // B5 (adversarial-audit finding, inline): a non-404 fetch failure (network
  // blip, 500) must not be silently swallowed as "no linked charge" — that
  // would misdirect the admin into thinking the sync desynced when it's
  // really a transient failure. Generic retry copy, same fail-loud contract
  // as the existing void-document error path.
  it("charge fetch non-404 error: shows a generic retry toast, not the no-linked-charge copy", async () => {
    const entry: OwnerLedgerEntryRow = {
      ...BASE_ENTRY,
      sourceChargeId: "c-err",
      sourceUtilityBillId: null,
    };
    stubApi(entry);
    renderPage();

    await screen.findByRole("row", { name: /Entry entry-1/i });
    fireEvent.click(screen.getByRole("button", { name: /Void entry entry-1/i }));

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith(expect.stringMatching(/could not load/i));
    });
    expect(toastErrorMock).not.toHaveBeenCalledWith(expect.stringMatching(/no linked charge/i));
    expect(screen.queryByRole("heading", { name: /Void & issue Credit Note/i })).not.toBeInTheDocument();
  });
});
