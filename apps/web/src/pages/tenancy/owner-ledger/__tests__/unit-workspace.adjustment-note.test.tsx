// The owner ledger must SAY when a credit/debit note moved a row's money.
//
// Reported symptom, all three at once: "when I do adjustment, it's not correctly
// showing the data in the owner ledger" — the row amount didn't change, there was no
// trace of the note, and the totals didn't move.
//
// Two distinct causes sat behind that:
//
//   1. The BILLED figure was read straight off `Charge.amount`, unnetted, while the
//      COLLECTED figure beside it had always been netted at sync time. A RM 50 charge
//      with a RM 30 credit note, fully settled, rendered "billed 50 / collected 20" —
//      on screen, indistinguishable from a tenant who simply underpaid by 30.
//      (Server fix + unit coverage: owner-ledger/charged-amount.ts.)
//
//   2. Nothing on the row mentioned the note at all. On an UNPAID charge the collected
//      figure is legitimately 0 both before and after an adjustment, so raising a note
//      correctly moved nothing visible — and looked exactly like a broken feature.
//
// This file pins (2): the note is on screen, and it is absent when there is nothing to
// say. Harness mirrors unit-workspace.void-routing.test.tsx.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";

vi.mock("@/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-client")>();
  return { ...actual, apiFetch: vi.fn() };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { apiFetch } from "@/lib/api-client";
import { AuthContext, type User } from "@/lib/auth";
import type { OwnerLedgerEntryRow } from "@/api/owner-ledger";
import UnitWorkspacePage from "../unit-workspace";

const apiFetchMock = vi.mocked(apiFetch);

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

const BASE_ENTRY: OwnerLedgerEntryRow = {
  id: "entry-1",
  organizationId: "org-1",
  ownerPartyId: "owner-1",
  propertyId: "prop-1",
  apartmentId: "apt-1",
  unitCode: "A-10-04",
  listingId: null,
  tenancyId: null,
  statementMonth: "2026-08-01T00:00:00.000Z",
  transactionDate: "2026-08-05T00:00:00.000Z",
  direction: "income",
  category: "utility_income",
  description: "service fee 202608",
  remarks: null,
  amount: "0.00", // collected — the tenant has not paid
  chargedAmount: "70.00", // billed, server-side CN/DN-adjusted (50.00 + DN 20.00)
  debitAdjustmentAmount: "0.00",
  creditAdjustmentAmount: "0.00",
  sstAmount: null,
  paidBy: "tenant",
  paymentStatus: "pending",
  taxCategory: "not_applicable",
  includeInPayout: true,
  attachmentKeys: [],
  sourceType: "tenant_utility",
  sourceChargeId: "c-1",
  sourceUtilityBillId: null,
  status: "active",
  createdById: "admin-1",
  updatedById: "admin-1",
  createdAt: "2026-08-05T00:00:00.000Z",
  updatedAt: "2026-08-05T00:00:00.000Z",
};

function stubApi(entry: OwnerLedgerEntryRow) {
  apiFetchMock.mockImplementation((path: string) => {
    if (path === "/owner-ledger/units/apt-1/context") {
      return Promise.resolve({ data: CTX }) as ReturnType<typeof apiFetch>;
    }
    if (path.startsWith("/owner-ledger/owners/owner-1/units-summary")) {
      return Promise.resolve({
        data: {
          month: "2026-08",
          combined: { incomeCollected: "0.00", depositCollected: "0.00", deductibleExpenses: "0.00", netPayout: "0.00" },
          units: [{ apartmentId: "apt-1", unitCode: "A-10-04", incomeCollected: "0.00", depositCollected: "0.00", deductibleExpenses: "0.00", netPayout: "0.00" }],
        },
      }) as ReturnType<typeof apiFetch>;
    }
    if (path.startsWith("/owner-ledger/entries")) {
      return Promise.resolve({ data: { rows: [entry], total: 1 } }) as ReturnType<typeof apiFetch>;
    }
    if (path.startsWith("/owner-billing/expense-proofs")) {
      return Promise.resolve({ data: [] }) as ReturnType<typeof apiFetch>;
    }
    return Promise.resolve({ data: { rows: [], total: 0 } }) as ReturnType<typeof apiFetch>;
  });
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const user: User = { id: "u1", fullName: "Test Admin", email: "admin@example.com", role: "admin", orgId: "org-1" };
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

describe("UnitWorkspacePage — ledger rows show why an adjustment moved the money", () => {
  it("names a DEBIT note on the row it adjusted", async () => {
    // Real UAT shape: GRIDRECUR charge 50.00 + DN-0003 (+20.00), unpaid. Collected is
    // legitimately 0.00 both before and after the note — without this line the ledger
    // gives the reader nothing at all to explain the RM 70 billed figure.
    stubApi({ ...BASE_ENTRY, debitAdjustmentAmount: "20.00" });
    renderPage();

    const row = await screen.findByRole("row", { name: /Entry entry-1/i });
    expect(within(row).getByText(/Debit note \+RM 20\.00/)).toBeInTheDocument();
  });

  it("names a CREDIT note", async () => {
    stubApi({ ...BASE_ENTRY, amount: "20.00", chargedAmount: "20.00", paymentStatus: "paid", creditAdjustmentAmount: "30.00" });
    renderPage();

    const row = await screen.findByRole("row", { name: /Entry entry-1/i });
    expect(within(row).getByText(/Credit note -RM 30\.00/)).toBeInTheDocument();
  });

  it("names BOTH when a charge carries each kind", async () => {
    stubApi({ ...BASE_ENTRY, debitAdjustmentAmount: "50.00", creditAdjustmentAmount: "20.00" });
    renderPage();

    const row = await screen.findByRole("row", { name: /Entry entry-1/i });
    expect(within(row).getByText(/Debit note \+RM 50\.00 · Credit note -RM 20\.00/)).toBeInTheDocument();
  });

  it("says nothing on an unadjusted row — no noise on the overwhelming majority", async () => {
    stubApi(BASE_ENTRY);
    renderPage();

    const row = await screen.findByRole("row", { name: /Entry entry-1/i });
    expect(within(row).queryByText(/note/i)).toBeNull();
  });
});
