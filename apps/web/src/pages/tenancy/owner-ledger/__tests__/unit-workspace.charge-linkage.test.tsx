// P4 Task 8 regression (review round 2, Critical finding): the sibling
// unit-workspace.test.tsx mocks ChargeForm entirely, so it only ever asserts
// the PROP passed in (defaultPartyId) — it can never catch ChargeForm seeding
// its own partyId state via useState(defaultPartyId ?? "") with no resync
// effect. Without a `key` on the ChargeForm mount, switching the Tenancy
// select on a partitioned unit reconciled the SAME instance: the prop updated
// but the internal partyId state didn't, and since needsPartyPick becomes
// false the stale bill-to party is invisible — submit() POSTs the OLD
// partyId against the NEW tenancyId/unitId.
//
// This file deliberately does NOT mock @/components/charge-form — it renders
// the real ChargeForm and asserts the actual POST body reaching /billing/charges,
// pinning the real prop -> internal-state -> submitted-payload linkage that the
// fix (key={chargeTenancyId} in unit-workspace.tsx) restores.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";

vi.mock("@/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-client")>();
  return { ...actual, apiFetch: vi.fn() };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { apiFetch } from "@/lib/api-client";
import { AuthContext, type User } from "@/lib/auth";
import { currentMonth } from "@/lib/date-utils";
import UnitWorkspacePage from "../unit-workspace";

const apiFetchMock = vi.mocked(apiFetch);

const CTX_PARTITIONED = {
  apartmentId: "apt-1",
  unitCode: "A-10-04",
  listingMode: "PARTITIONED",
  propertyId: "prop-1",
  propertyName: "Areca Residences",
  ownerPartyId: "owner-1",
  ownerName: "Dato' Razak",
  activeTenancies: [
    {
      tenancyId: "ten-1",
      listingId: "list-1",
      listingType: "master",
      tenantPartyId: "party-aisyah",
      tenantDisplayName: "Aisyah",
    },
    {
      tenancyId: "ten-2",
      listingId: "list-2",
      listingType: "middle",
      tenantPartyId: "party-farid",
      tenantDisplayName: "Farid",
    },
  ],
};

const CATEGORIES = {
  items: [
    {
      id: "cat-rental",
      code: "rental",
      name: "Monthly rental",
      family: "pay_back_landlord",
      docType: "debit_note",
      seriesId: "s-dep",
      seriesCode: "DEP",
      defaultSstRate: "0",
      eInvoiceEligible: false,
      ledgerCategory: "rental_income",
      isSystem: true,
      active: true,
      sortOrder: 200,
      description: null,
      updatedAt: "2026-07-02T00:00:00.000Z",
    },
  ],
};

function stubApi() {
  apiFetchMock.mockImplementation((path: string, init?: RequestInit) => {
    if (path === "/owner-ledger/units/apt-1/context") {
      return Promise.resolve({ data: CTX_PARTITIONED }) as ReturnType<typeof apiFetch>;
    }
    if (path.startsWith("/owner-ledger/owners/owner-1/units-summary")) {
      return Promise.resolve({
        data: {
          month: "2026-07",
          combined: {
            incomeCollected: "1000.00",
            depositCollected: "0.00",
            deductibleExpenses: "100.00",
            netPayout: "900.00",
          },
          units: [
            {
              apartmentId: "apt-1",
              unitCode: "A-10-04",
              incomeCollected: "1000.00",
              depositCollected: "0.00",
              deductibleExpenses: "100.00",
              netPayout: "900.00",
            },
          ],
        },
      }) as ReturnType<typeof apiFetch>;
    }
    if (path.startsWith("/owner-ledger/entries")) {
      return Promise.resolve({ data: { rows: [], total: 0 } }) as ReturnType<typeof apiFetch>;
    }
    if (path.startsWith("/owner-billing/expense-proofs")) {
      return Promise.resolve({ data: [] }) as ReturnType<typeof apiFetch>;
    }
    if (path.startsWith("/charge-categories")) {
      return Promise.resolve(CATEGORIES) as ReturnType<typeof apiFetch>;
    }
    if (path === "/billing/charges" && init?.method === "POST") {
      return Promise.resolve({ id: "charge-99" }) as ReturnType<typeof apiFetch>;
    }
    return Promise.resolve({ data: [] }) as ReturnType<typeof apiFetch>;
  });
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const user: User = { id: "u1", fullName: "Test User", email: "t@example.com", role: "editor", orgId: "org-1" };
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
  vi.stubEnv("VITE_ENABLE_PHASE2_BILLING_DOCS", "true");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("UnitWorkspacePage + real ChargeForm — tenancy-switch party linkage (review round 2)", () => {
  it("remounts ChargeForm on tenancy switch: resets the form AND submits the NEWLY selected tenancy's partyId (never the stale one)", async () => {
    stubApi();
    renderPage();

    await screen.findByRole("heading", { name: /A-10-04/ });
    const openBtn = await screen.findByRole("button", { name: /Add tenant charge/i });
    await waitFor(() => expect(openBtn).not.toBeDisabled());
    fireEvent.click(openBtn);

    // Partitioned unit -> tenancy picker renders, ChargeForm not mounted yet.
    const tenancySelect = await screen.findByRole("combobox", { name: /Charge tenancy/i });

    // Pick tenancy A (Aisyah) and fill the form.
    fireEvent.change(tenancySelect, { target: { value: "ten-1" } });
    const categorySelectA = (await screen.findByLabelText("Category")) as HTMLSelectElement;
    await waitFor(() => expect(categorySelectA.querySelectorAll("option[value]").length).toBeGreaterThan(1));
    fireEvent.change(categorySelectA, { target: { value: "cat-rental" } });
    fireEvent.change(screen.getByLabelText("Amount (RM)"), { target: { value: "500" } });
    expect((screen.getByLabelText("Amount (RM)") as HTMLInputElement).value).toBe("500");

    // Switch to tenancy B (Farid) — the fix keys ChargeForm on chargeTenancyId,
    // so this must remount the form fresh: amount clears back to "".
    fireEvent.change(tenancySelect, { target: { value: "ten-2" } });
    await waitFor(() => {
      expect((screen.getByLabelText("Amount (RM)") as HTMLInputElement).value).toBe("");
    });
    // Category also resets on the fresh instance (no defaultCategoryCode).
    const categorySelectB = screen.getByLabelText("Category") as HTMLSelectElement;
    expect(categorySelectB.value).toBe("");

    // Fill the fresh (tenancy-B) instance and submit.
    fireEvent.change(categorySelectB, { target: { value: "cat-rental" } });
    fireEvent.change(screen.getByLabelText("Amount (RM)"), { target: { value: "700" } });
    fireEvent.click(screen.getByRole("button", { name: "Create draft charge" }));

    await waitFor(() => {
      const call = apiFetchMock.mock.calls.find((c) => c[0] === "/billing/charges");
      expect(call).toBeTruthy();
    });
    const call = apiFetchMock.mock.calls.find((c) => c[0] === "/billing/charges")!;
    const body = JSON.parse((call[1] as RequestInit).body as string);

    // The load-bearing assertion: the POSTed bill-to party is tenancy B's
    // (Farid's) party — NEVER tenancy A's (Aisyah's) stale party — while the
    // tenancyId/unitId also correctly point at tenancy B.
    expect(body.partyId).toBe("party-farid");
    expect(body.partyId).not.toBe("party-aisyah");
    expect(body.tenancyId).toBe("ten-2");
    expect(body.unitId).toBe("list-2");
    expect(body.amount).toBe("700");
  });
});

// Critical review finding (Task 9 follow-up): unit-workspace.tsx used to send
// `month: `${month}-01`` to useBillingDocuments, but listBillingDocumentsQuery
// (packages/shared/src/schemas/billing-documents.ts) requires bare
// `^\d{4}-\d{2}$` — every real request 400s and the Documents section
// silently fell back to its empty state (no isError branch existed to show
// it). This file doesn't mock @/api/billing-documents, so the assertion below
// exercises the REAL hook -> apiFetch -> query-string wire, same as the
// tenancy-switch test above does for /billing/charges. It must fail again if
// a future edit reintroduces the "-01" suffix (or "fixes" it back thinking it
// should match the OTHER owner-ledger units-summary contracts, which use a
// mix of bare "YYYY-MM" and "YYYY-MM-01" depending on the endpoint — see the
// comment on documentsQuery in unit-workspace.tsx).
describe("UnitWorkspacePage — billing-documents wire contract (Critical fix regression)", () => {
  it("requests /billing-documents with a bare YYYY-MM month, never a day-suffixed value", async () => {
    stubApi();
    renderPage();

    await screen.findByRole("heading", { name: /A-10-04/ });

    await waitFor(() => {
      const call = apiFetchMock.mock.calls.find(
        (c) => typeof c[0] === "string" && c[0].startsWith("/billing-documents?"),
      );
      expect(call).toBeTruthy();
    });

    const call = apiFetchMock.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].startsWith("/billing-documents?"),
    )!;
    const url = new URL(call[0] as string, "http://localhost");
    const monthParam = url.searchParams.get("month");

    // Exact match against the bare currentMonth() AND the strict
    // ^\d{4}-\d{2}$ shape — a reintroduced `${month}-01` fails both (wrong
    // value, and 10 chars instead of 7).
    expect(monthParam).toBe(currentMonth());
    expect(monthParam).toMatch(/^\d{4}-\d{2}$/);
  });
});
