// P4 Task 7: Unit workspace — header, figures (UnitSummaryCard), entries, role gates.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import React from "react";

const mockNavigate = vi.fn();
// navControl lets ONE test opt into the real useNavigate so it can drive an
// actual same-route param transition (apt-1 -> apt-2) through plain MemoryRouter
// history, without swapping to react-router's data router (createMemoryRouter),
// which throws ("Expected signal to be an instance of AbortSignal") under jsdom.
const navControl = vi.hoisted(() => ({ real: false }));
vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return { ...actual, useNavigate: () => (navControl.real ? actual.useNavigate() : mockNavigate) };
});
vi.mock("@/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-client")>();
  return { ...actual, apiFetch: vi.fn() };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// Flags: owner-billing ON; billing-docs toggled per test (Tasks 8/9 sections).
// docStatus drives the ONE documents fixture's status (Task 9: issued = no
// three-way fork, settled = fork shown) — same knob the reused VoidChargeDialog
// keys its isPaid check off of (via the document→charge status mapping).
// docsError / voidDetailLoading (Critical/Minor review fix): drive the
// documents-list isError branch and the per-row pending affordance while
// useBillingDocument's detail fetch is still in flight.
const flags = vi.hoisted(() => ({
  billingDocs: false,
  docStatus: "issued" as string,
  docsError: false,
  voidDetailLoading: false,
}));
vi.mock("@/lib/feature-flags", () => ({
  isPhase2FlagEnabled: (flag: string) =>
    flag === "ENABLE_PHASE2_BILLING_DOCS" ? flags.billingDocs : true,
}));
vi.mock("@/components/charge-form", () => ({
  ChargeForm: ({ tenancyId, defaultPartyId }: { tenancyId?: string; defaultPartyId?: string }) => (
    <div data-testid="charge-form">
      charge-form:{tenancyId}:{defaultPartyId}
    </div>
  ),
}));
// P4 Task 9: Documents section. useBillingDocument is keyed by id — "doc-1"
// resolves to a detail carrying lines[0].chargeId (issuance's one-doc-per-charge
// contract), which is exactly what the reused VoidChargeDialog needs to void.
vi.mock("@/api/billing-documents", () => ({
  useBillingDocuments: () =>
    flags.docsError
      ? { data: undefined, isLoading: false, isError: true }
      : {
          data: {
            data: {
              items: [
                {
                  id: "doc-1",
                  docType: "debit_note",
                  documentNumber: "DEP-0113",
                  seriesCode: "DEP",
                  status: flags.docStatus,
                  issuedAt: "2026-07-01T00:00:00.000Z",
                  billingMonth: "2026-07-01",
                  counterpartyType: "tenant",
                  partyName: "Aisyah",
                  unitCode: "A-10-04",
                  total: "100.00",
                },
              ],
              total: 1,
            },
          },
          isLoading: false,
          isError: false,
        },
  useBillingDocument: (id: string | null) =>
    flags.voidDetailLoading
      ? { data: undefined, isLoading: true, isError: false }
      : {
          data:
            id === "doc-1"
              ? {
                  data: {
                    id: "doc-1",
                    lines: [
                      {
                        id: "line-1",
                        chargeId: "charge-1",
                        description: "Rental",
                        amount: "100.00",
                        sstRate: "0",
                        sstAmount: "0.00",
                        categoryName: "Rental",
                      },
                    ],
                  },
                }
              : undefined,
          isLoading: false,
          isError: false,
        },
}));

import { apiFetch } from "@/lib/api-client";
import { AuthContext, type User } from "@/lib/auth";
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
  activeTenancies: [
    {
      tenancyId: "ten-1",
      listingId: "list-1",
      listingType: "unit",
      tenantPartyId: "party-aisyah",
      tenantDisplayName: "Aisyah",
    },
  ],
};

const ENTRY = {
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
  direction: "income",
  category: "rental_income",
  description: "July rent",
  remarks: null,
  amount: "1000.00",
  sstAmount: null,
  paidBy: "kaen",
  paymentStatus: "paid",
  taxCategory: "not_applicable",
  includeInPayout: false,
  attachmentKeys: [],
  sourceType: "manual",
  status: "active",
  createdById: "admin-1",
  updatedById: "admin-1",
  createdAt: "2026-07-05T00:00:00.000Z",
  updatedAt: "2026-07-05T00:00:00.000Z",
};

// ── Payouts section fixtures (owner-ledger view clarity, Fix 1 — consistency +
// defensive: the schema permits an apartmentId on a payout row even though no
// current create-path sets one, so groupByDirection's drop-payout contract
// must never silently apply here) ──────────────────────────────────────────
const EXPENSE_ENTRY = {
  ...ENTRY,
  id: "expense-1",
  direction: "expense",
  category: "utilities_tnb",
  description: "TNB bill",
  amount: "50.00",
  paymentStatus: "paid",
  includeInPayout: true,
};
const PAYOUT_ENTRY = {
  ...ENTRY,
  id: "payout-1",
  direction: "payout",
  category: "owner_payout",
  description: "June payout",
  amount: "300.00",
  paymentStatus: "paid",
  includeInPayout: false,
};
const VOIDED_PAYOUT_ENTRY = {
  ...PAYOUT_ENTRY,
  id: "payout-void",
  status: "void",
};

function stubApi(ctxOverride: typeof CTX = CTX) {
  apiFetchMock.mockImplementation((path: string) => {
    if (path === "/owner-ledger/units/apt-1/context") {
      return Promise.resolve({ data: ctxOverride }) as ReturnType<typeof apiFetch>;
    }
    if (path.startsWith("/owner-ledger/owners/owner-1/units-summary")) {
      return Promise.resolve({
        data: {
          month: "2026-07",
          combined: { incomeCollected: "1000.00", depositCollected: "0.00", deductibleExpenses: "100.00", netPayout: "900.00" },
          units: [
            { apartmentId: "apt-1", unitCode: "A-10-04", incomeCollected: "1000.00", depositCollected: "0.00", deductibleExpenses: "100.00", netPayout: "900.00" },
          ],
        },
      }) as ReturnType<typeof apiFetch>;
    }
    if (path.startsWith("/owner-ledger/entries")) {
      return Promise.resolve({ data: { rows: [ENTRY], total: 1 } }) as ReturnType<typeof apiFetch>;
    }
    if (path.startsWith("/owner-billing/expense-proofs")) {
      return Promise.resolve({ data: [] }) as ReturnType<typeof apiFetch>;
    }
    if (path === "/billing-documents/doc-1/pdf") {
      return Promise.resolve({
        data: { url: "https://signed.example/doc-1.pdf" },
      }) as ReturnType<typeof apiFetch>;
    }
    return Promise.resolve({ data: { rows: [], total: 0 } }) as ReturnType<typeof apiFetch>;
  });
}

function renderPage(role = "admin") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const user: User = { id: "u1", fullName: "Test User", email: "t@example.com", role, orgId: "org-1" };
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
  mockNavigate.mockReset();
  flags.billingDocs = false;
  flags.docStatus = "issued";
  flags.docsError = false;
  flags.voidDetailLoading = false;
  navControl.real = false;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("UnitWorkspacePage (P4)", () => {
  it("renders unit header with property, owner link and tenancies", async () => {
    stubApi();
    renderPage();
    expect(await screen.findByRole("heading", { name: /A-10-04/ })).toBeInTheDocument();
    expect(screen.getByText(/Areca Residences/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Dato' Razak/ })).toHaveAttribute(
      "href",
      "/tenancy/owner-ledger/owner-1",
    );
    expect(screen.getByText(/Aisyah/)).toBeInTheDocument();
  });

  it("renders the month figures via UnitSummaryCard (foots to the payout engine)", async () => {
    stubApi();
    renderPage();
    await screen.findByRole("heading", { name: /A-10-04/ });
    // Net Payout figure from the units-summary fixture.
    expect(await screen.findByText(/900\.00/)).toBeInTheDocument();
    // UnitSummaryCard actions are present (reuse manifest).
    expect(screen.getByRole("button", { name: /Print Invoice/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Attach bills/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Per-unit statement/i })).toBeInTheDocument();
  });

  it("lists the unit's ledger entries for the month", async () => {
    stubApi();
    renderPage();
    // Scoped to the entries table: the description "July rent" is unique
    // page-wide, but the amount "1,000.00" ALSO appears in the UnitSummaryCard's
    // Income Collected figure (same fixture value) — scope to the table to
    // disambiguate rather than asserting page-wide.
    expect(await screen.findByText("July rent")).toBeInTheDocument();
    const table = screen.getByRole("table", { name: /Unit ledger entries/i });
    // Scoped to the entry's own row (Task 6, R4): a single-row section's
    // subtotal legitimately repeats the same figure as the row's own amount
    // cell, so a whole-table text query would now match twice.
    const row = within(table).getByRole("row", { name: /Entry entry-1/i });
    expect(within(row).getByText(/1,000\.00/)).toBeInTheDocument();
  });

  it("shows the BILLED price for an income entry, not collected 0.00 (chargedAmount)", async () => {
    // Income row: `amount` = collected-so-far (0 while the tenant hasn't paid);
    // `chargedAmount` = the billed price. The table must show the price.
    const billedEntry = {
      ...ENTRY,
      id: "e-billed",
      description: "August rent",
      amount: "0.00",
      chargedAmount: "800.00",
      paymentStatus: "pending",
    };
    apiFetchMock.mockImplementation((path: string) => {
      if (path === "/owner-ledger/units/apt-1/context") {
        return Promise.resolve({ data: CTX }) as ReturnType<typeof apiFetch>;
      }
      if (path.startsWith("/owner-ledger/owners/owner-1/units-summary")) {
        return Promise.resolve({
          data: {
            month: "2026-07",
            combined: { incomeCollected: "0.00", depositCollected: "0.00", deductibleExpenses: "0.00", netPayout: "0.00" },
            units: [{ apartmentId: "apt-1", unitCode: "A-10-04", incomeCollected: "0.00", depositCollected: "0.00", deductibleExpenses: "0.00", netPayout: "0.00" }],
          },
        }) as ReturnType<typeof apiFetch>;
      }
      if (path.startsWith("/owner-ledger/entries")) {
        return Promise.resolve({ data: { rows: [billedEntry], total: 1 } }) as ReturnType<typeof apiFetch>;
      }
      return Promise.resolve({ data: { rows: [], total: 0 } }) as ReturnType<typeof apiFetch>;
    });
    renderPage();
    await screen.findByText("August rent");
    const table = screen.getByRole("table", { name: /Unit ledger entries/i });
    // Scoped to the entry's own row (Task 6, R4): a single-row section's
    // subtotal legitimately repeats the same figure as the row's own amount
    // cell, so a whole-table text query would now match twice.
    const row = within(table).getByRole("row", { name: /Entry e-billed/i });
    // Billed price shown…
    expect(within(row).getByText(/800\.00/)).toBeInTheDocument();
    // …and the collected-0 is NOT what the amount cell displays.
    expect(within(row).queryByText("RM 0.00")).not.toBeInTheDocument();
  });

  it("orders the ledger columns with Status before Paid By", async () => {
    stubApi();
    renderPage();
    const table = await screen.findByRole("table", { name: /Unit ledger entries/i });
    const headers = within(table)
      .getAllByRole("columnheader")
      .map((h) => h.textContent ?? "");
    const statusIdx = headers.findIndex((t) => /Status/i.test(t));
    const paidByIdx = headers.findIndex((t) => /Paid By/i.test(t));
    expect(statusIdx).toBeGreaterThanOrEqual(0);
    expect(paidByIdx).toBeGreaterThanOrEqual(0);
    expect(statusIdx).toBeLessThan(paidByIdx);
  });

  it("requests entries scoped by owner + apartment + month (read-through sync trigger)", async () => {
    stubApi();
    renderPage();
    await waitFor(() => {
      const call = apiFetchMock.mock.calls.find(
        (c) =>
          typeof c[0] === "string" &&
          c[0].startsWith("/owner-ledger/entries") &&
          c[0].includes("ownerPartyId=owner-1") &&
          c[0].includes("apartmentId=apt-1") &&
          c[0].includes("month="),
      );
      expect(call).toBeTruthy();
    });
  });

  it("hides the entry Void action from a manager (admin-only write)", async () => {
    stubApi();
    renderPage("manager");
    // Wait for the entry row itself (its aria-label is unique) rather than the
    // "1,000.00" text, which also appears in the UnitSummaryCard figures.
    await screen.findByRole("row", { name: /Entry entry-1/i });
    expect(screen.queryByRole("button", { name: /Void entry/i })).not.toBeInTheDocument();
  });

  it("hides the entry Void action from an editor (admin-only write; ROLE_RANK excludes manager AND editor)", async () => {
    stubApi();
    renderPage("editor");
    await screen.findByRole("row", { name: /Entry entry-1/i });
    expect(screen.queryByRole("button", { name: /Void entry/i })).not.toBeInTheDocument();
  });

  it("shows the entry Void action to an admin", async () => {
    stubApi();
    renderPage("admin");
    await screen.findByRole("row", { name: /Entry entry-1/i });
    expect(screen.getByRole("button", { name: /Void entry entry-1/i })).toBeInTheDocument();
  });

  it("guards Void buttons + shows a busy state while a newly-picked unit's entries fetch is still pending (stale placeholder data)", async () => {
    const CTX2 = { ...CTX, apartmentId: "apt-2", unitCode: "A-10-05" };
    const ENTRY2 = { ...ENTRY, id: "entry-2", apartmentId: "apt-2", description: "August rent" };

    let resolveApt2Entries: (value: { data: { rows: (typeof ENTRY)[]; total: number } }) => void =
      () => {};
    const apt2EntriesPromise = new Promise<{ data: { rows: (typeof ENTRY)[]; total: number } }>(
      (resolve) => {
        resolveApt2Entries = resolve;
      },
    );

    apiFetchMock.mockImplementation((path: string) => {
      if (path === "/owner-ledger/units/apt-1/context") {
        return Promise.resolve({ data: CTX }) as ReturnType<typeof apiFetch>;
      }
      if (path === "/owner-ledger/units/apt-2/context") {
        return Promise.resolve({ data: CTX2 }) as ReturnType<typeof apiFetch>;
      }
      if (path.startsWith("/owner-ledger/owners/owner-1/units-summary")) {
        return Promise.resolve({
          data: {
            month: "2026-07",
            combined: {
              incomeCollected: "2000.00",
              depositCollected: "0.00",
              deductibleExpenses: "200.00",
              netPayout: "1800.00",
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
              {
                apartmentId: "apt-2",
                unitCode: "A-10-05",
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
        if (path.includes("apartmentId=apt-2")) {
          return apt2EntriesPromise as ReturnType<typeof apiFetch>;
        }
        return Promise.resolve({ data: { rows: [ENTRY], total: 1 } }) as ReturnType<typeof apiFetch>;
      }
      return Promise.resolve({ data: { rows: [], total: 0 } }) as ReturnType<typeof apiFetch>;
    });

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
    });
    const user: User = {
      id: "u1",
      fullName: "Test User",
      email: "t@example.com",
      role: "admin",
      orgId: "org-1",
    };
    // Opt this ONE test into the real useNavigate so a plain MemoryRouter
    // (same declarative setup every other test in this file uses) performs an
    // actual same-route param transition — apt-1 -> apt-2 — while
    // UnitWorkspacePage stays mounted, exactly like the ApartmentPicker's
    // onSelect->navigate(...) call does in production. A hidden trigger button
    // stands in for the picker's own search UI.
    navControl.real = true;
    function NavTrigger({ to }: { to: string }) {
      const navigate = useNavigate();
      return (
        <button type="button" onClick={() => navigate(to)}>
          jump
        </button>
      );
    }
    render(
      <QueryClientProvider client={client}>
        <AuthContext.Provider
          value={{ user, setAuth: () => {}, clearAuth: () => {}, isAuthenticated: true }}
        >
          <MemoryRouter initialEntries={["/tenancy/owner-ledger/unit/apt-1"]}>
            <NavTrigger to="/tenancy/owner-ledger/unit/apt-2" />
            <Routes>
              <Route path="/tenancy/owner-ledger/unit/:apartmentId" element={<UnitWorkspacePage />} />
            </Routes>
          </MemoryRouter>
        </AuthContext.Provider>
      </QueryClientProvider>,
    );

    // Initial unit (apt-1): live entry + live Void button.
    await screen.findByRole("row", { name: /Entry entry-1/i });
    expect(screen.getByRole("button", { name: /Void entry entry-1/i })).toBeInTheDocument();

    // Simulate the ApartmentPicker jump to apt-2. Its entries fetch is left
    // pending on purpose.
    fireEvent.click(screen.getByRole("button", { name: /jump/i }));

    // While apt-2's fetch is in flight, TanStack's placeholderData:(prev)=>prev
    // keeps rendering apt-1's row — but Void must be gated off (it would
    // otherwise still be bound to apt-1's entry id) and the card must read busy.
    await waitFor(() => {
      expect(screen.getByText(/Refreshing…/i)).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: /Void entry/i })).not.toBeInTheDocument();
    const entriesTable = screen.getByRole("table", { name: /Unit ledger entries/i });
    const entriesCard = entriesTable.closest("[aria-busy]");
    expect(entriesCard).toHaveAttribute("aria-busy", "true");

    // Resolve apt-2's fetch — Void reappears, bound ONLY to the new unit's row.
    resolveApt2Entries({ data: { rows: [ENTRY2], total: 1 } });
    await screen.findByRole("row", { name: /Entry entry-2/i });
    expect(screen.getByRole("button", { name: /Void entry entry-2/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Void entry entry-1/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/Refreshing…/i)).not.toBeInTheDocument();
    expect(entriesTable.closest("[aria-busy]")).toHaveAttribute("aria-busy", "false");
  });

  it("shows 'No owner assigned' copy in the entries card when the unit has no owner (mirrors the figures card)", async () => {
    const CTX_NO_OWNER = { ...CTX, ownerPartyId: null, ownerName: null };
    apiFetchMock.mockImplementation((path: string) => {
      if (path === "/owner-ledger/units/apt-1/context") {
        return Promise.resolve({ data: CTX_NO_OWNER }) as ReturnType<typeof apiFetch>;
      }
      return Promise.resolve({ data: { rows: [], total: 0 } }) as ReturnType<typeof apiFetch>;
    });
    renderPage();
    expect(await screen.findByRole("heading", { name: /A-10-04/ })).toBeInTheDocument();
    // Both the figures card AND the entries card show the mirrored copy — not
    // the generic "no entries" message.
    const noOwnerCopy = await screen.findAllByText(
      /No owner assigned — assign an owner before booking ledger entries\./,
    );
    expect(noOwnerCopy.length).toBe(2);
    const table = screen.getByRole("table", { name: /Unit ledger entries/i });
    expect(
      within(table).getByText(/No owner assigned — assign an owner before booking ledger entries\./),
    ).toBeInTheDocument();
    expect(
      within(table).queryByText(/No ledger entries for this unit in this month\./),
    ).not.toBeInTheDocument();
  });

  it("shows a not-found card for an unknown apartment", async () => {
    apiFetchMock.mockImplementation((path: string) => {
      if (path === "/owner-ledger/units/apt-1/context") {
        return Promise.reject(new Error("404: Not found")) as ReturnType<typeof apiFetch>;
      }
      return Promise.resolve({ data: { rows: [], total: 0 } }) as ReturnType<typeof apiFetch>;
    });
    renderPage();
    expect(await screen.findByText(/Unit not found/i)).toBeInTheDocument();
  });
});

describe("UnitWorkspacePage — add actions (P4 Task 8)", () => {
  it("shows Add tenant charge to an editor when billing-docs flag is on, opening ChargeForm with the single tenancy", async () => {
    flags.billingDocs = true;
    stubApi();
    renderPage("editor");
    // Wait for the apartment context to resolve (heading only renders the
    // unit code once ctx loads) — the button is disabled until then, so
    // clicking too early would be a no-op.
    await screen.findByRole("heading", { name: /A-10-04/ });
    const btn = await screen.findByRole("button", { name: /Add tenant charge/i });
    await waitFor(() => expect(btn).not.toBeDisabled());
    fireEvent.click(btn);
    expect(await screen.findByTestId("charge-form")).toHaveTextContent("charge-form:ten-1");
  });

  it("hides Add tenant charge while the billing-docs flag is dark", async () => {
    flags.billingDocs = false;
    stubApi();
    renderPage("editor");
    await screen.findByRole("heading", { name: /A-10-04/ });
    expect(screen.queryByRole("button", { name: /Add tenant charge/i })).not.toBeInTheDocument();
  });

  it("shows Add ledger entry to admin only", async () => {
    flags.billingDocs = true;
    stubApi();
    renderPage("editor");
    await screen.findByRole("heading", { name: /A-10-04/ });
    expect(screen.queryByRole("button", { name: /Add ledger entry/i })).not.toBeInTheDocument();
  });

  it("opens the EntryFormDrawer pre-scoped to this unit for an admin", async () => {
    flags.billingDocs = true;
    stubApi();
    renderPage("admin");
    // Wait for ctx (heading) before clicking — the button is disabled until
    // ctx.ownerPartyId resolves.
    await screen.findByRole("heading", { name: /A-10-04/ });
    const btn = await screen.findByRole("button", { name: /Add ledger entry/i });
    await waitFor(() => expect(btn).not.toBeDisabled());
    fireEvent.click(btn);
    expect(await screen.findByText(/New ledger entry/i)).toBeInTheDocument();
  });

  it("pins ChargeForm's defaultPartyId to the single auto-selected tenancy (no org-wide re-pick)", async () => {
    flags.billingDocs = true;
    stubApi();
    renderPage("editor");
    await screen.findByRole("heading", { name: /A-10-04/ });
    const btn = await screen.findByRole("button", { name: /Add tenant charge/i });
    await waitFor(() => expect(btn).not.toBeDisabled());
    fireEvent.click(btn);
    expect(await screen.findByTestId("charge-form")).toHaveTextContent(
      "charge-form:ten-1:party-aisyah",
    );
  });

  it("re-pins ChargeForm's defaultPartyId when switching the Tenancy select on a partitioned unit", async () => {
    flags.billingDocs = true;
    const CTX_PARTITIONED = {
      ...CTX,
      listingMode: "PARTITIONED",
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
    stubApi(CTX_PARTITIONED);
    renderPage("editor");
    await screen.findByRole("heading", { name: /A-10-04/ });
    const btn = await screen.findByRole("button", { name: /Add tenant charge/i });
    await waitFor(() => expect(btn).not.toBeDisabled());
    fireEvent.click(btn);

    // Two active tenancies -> the tenancy select renders and nothing is
    // auto-selected; ChargeForm doesn't mount until a tenancy is picked.
    const select = await screen.findByRole("combobox", { name: /Charge tenancy/i });
    expect(screen.queryByTestId("charge-form")).not.toBeInTheDocument();

    fireEvent.change(select, { target: { value: "ten-1" } });
    expect(await screen.findByTestId("charge-form")).toHaveTextContent(
      "charge-form:ten-1:party-aisyah",
    );

    // Switching the select must re-pin defaultPartyId to the NEWLY selected
    // tenancy's tenant — never leave it bound to the previous pick.
    fireEvent.change(select, { target: { value: "ten-2" } });
    expect(await screen.findByTestId("charge-form")).toHaveTextContent(
      "charge-form:ten-2:party-farid",
    );
    expect(screen.getByTestId("charge-form")).not.toHaveTextContent("party-aisyah");
  });

  it("hides both Add actions from a viewer (read-only role)", async () => {
    flags.billingDocs = true;
    stubApi();
    renderPage("viewer");
    await screen.findByRole("heading", { name: /A-10-04/ });
    expect(screen.queryByRole("button", { name: /Add tenant charge/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add ledger entry/i })).not.toBeInTheDocument();
  });
});

describe("UnitWorkspacePage — documents (P4 Task 9)", () => {
  it("renders the documents section with Void & CN for admin when the flag is on", async () => {
    flags.billingDocs = true;
    stubApi();
    renderPage("admin");
    expect(await screen.findByText("DEP-0113")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Void document DEP-0113/i })).toBeInTheDocument();
  });

  it("hides the documents section while the flag is dark", async () => {
    flags.billingDocs = false;
    stubApi();
    renderPage("admin");
    await screen.findByRole("heading", { name: /A-10-04/ });
    expect(screen.queryByText("DEP-0113")).not.toBeInTheDocument();
  });

  it("hides Void & CN from a manager", async () => {
    flags.billingDocs = true;
    stubApi();
    renderPage("manager");
    expect(await screen.findByText("DEP-0113")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Void document/i })).not.toBeInTheDocument();
  });

  it("opens the document PDF in a new tab via the signed URL", async () => {
    flags.billingDocs = true;
    const openSpy = vi.fn();
    vi.stubGlobal("open", openSpy);
    stubApi();
    renderPage("admin");
    fireEvent.click(await screen.findByRole("button", { name: /Open PDF DEP-0113/i }));
    await waitFor(() =>
      expect(openSpy).toHaveBeenCalledWith("https://signed.example/doc-1.pdf", "_blank", "noopener"),
    );
  });

  // Critical review fix: the section used to have no isError branch at all,
  // so a broken query (e.g. the month-format 400 this fix addresses) just
  // rendered the ordinary "no documents" empty state — indistinguishable
  // from a genuinely empty month. Pin the now-visible error text.
  it("shows an inline error instead of a silent empty state when the documents fetch fails", async () => {
    flags.billingDocs = true;
    flags.docsError = true;
    stubApi();
    renderPage("admin");
    await screen.findByRole("heading", { name: /A-10-04/ });
    expect(await screen.findByText(/could not load documents/i)).toBeInTheDocument();
    expect(screen.queryByText("DEP-0113")).not.toBeInTheDocument();
  });
});

// Reuse check (P3.T11 -> P4.T9): components/void-charge-dialog.tsx is ALREADY
// the "Void & issue Credit Note" dialog (its own docstring names "unit
// workspace (Plan 4)" as a mount site) with full reason-gate/three-way-fork/
// refund/orphan-cleanup coverage in its own test file. These tests exercise
// ONLY the NEW workspace wiring — resolving the document's chargeId via
// useBillingDocument and mapping BillingDocumentStatus -> the dialog's
// charge-status vocabulary — not the dialog's internal validation, which is
// already covered elsewhere.
describe("UnitWorkspacePage — Void & issue Credit Note (P4 Task 9, reuses VoidChargeDialog)", () => {
  it("resolves the charge via the document detail and posts the Plan-3 void endpoint for an unpaid (issued) document — no three-way fork", async () => {
    flags.billingDocs = true;
    flags.docStatus = "issued";
    stubApi();
    renderPage("admin");
    fireEvent.click(await screen.findByRole("button", { name: /Void document DEP-0113/i }));

    // Dialog mounts once useBillingDocument resolves lines[0].chargeId.
    await screen.findByLabelText(/reason/i);
    expect(screen.queryByLabelText(/hold as credit/i)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: "Wrong amount billed" } });
    fireEvent.click(screen.getByRole("button", { name: /void & issue credit note/i }));

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith(
        "/billing/charges/charge-1/void",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ reason: "Wrong amount billed" }),
        }),
      );
    });
    // Success closes the dialog (VoidChargeDialog's own onSuccess -> onClose()).
    await waitFor(() => expect(screen.queryByLabelText(/reason/i)).not.toBeInTheDocument());
  });

  it("shows the three-way fork for a settled document and posts hold_credit against the resolved charge", async () => {
    flags.billingDocs = true;
    flags.docStatus = "settled";
    stubApi();
    renderPage("admin");
    fireEvent.click(await screen.findByRole("button", { name: /Void document DEP-0113/i }));

    fireEvent.click(await screen.findByLabelText(/hold as credit/i));
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: "Tenant overbilled" } });
    fireEvent.click(screen.getByRole("button", { name: /void & issue credit note/i }));

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith(
        "/billing/charges/charge-1/void",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ reason: "Tenant overbilled", paidHandling: "hold_credit" }),
        }),
      );
    });
  });

  // Minor review fix: clicking "Void & CN" is a no-op from the admin's POV
  // until useBillingDocument resolves the linked charge and the dialog pops
  // in — the "disclosed load-flash". Pin the row-level pending affordance
  // (disabled button + spinner) that now covers that gap.
  it("disables the clicked row's Void & CN button and shows a spinner while its detail is still loading", async () => {
    flags.billingDocs = true;
    flags.voidDetailLoading = true;
    stubApi();
    renderPage("admin");

    const voidBtn = await screen.findByRole("button", { name: /Void document DEP-0113/i });
    expect(voidBtn).not.toBeDisabled();
    fireEvent.click(voidBtn);

    await waitFor(() => expect(voidBtn).toBeDisabled());
    // Dialog can't open yet — useBillingDocument hasn't resolved a chargeId.
    expect(screen.queryByLabelText(/reason/i)).not.toBeInTheDocument();
  });
});

// owner-ledger view clarity, Fix 1: mirrors the Payouts section already shipped
// on owner-workspace.tsx / month-review-sheet.tsx. Today's apartmentId-scoped
// query structurally never returns a payout row (payouts are created without
// an apartmentId), so this is a defensive/consistency fix for a latent gap,
// not a fix for an observed bug — these fixtures exercise the code path
// directly regardless of what production traffic currently sends.
describe("UnitWorkspacePage — Payouts section (owner-ledger view clarity, Fix 1)", () => {
  it("renders a Payouts section below Income/Expenses with a sky-toned amount and the payment-status pill (not Owner-paid)", async () => {
    apiFetchMock.mockImplementation((path: string) => {
      if (path === "/owner-ledger/units/apt-1/context") {
        return Promise.resolve({ data: CTX }) as ReturnType<typeof apiFetch>;
      }
      if (path.startsWith("/owner-ledger/owners/owner-1/units-summary")) {
        return Promise.resolve({
          data: {
            month: "2026-07",
            combined: { incomeCollected: "1000.00", depositCollected: "0.00", deductibleExpenses: "50.00", netPayout: "650.00" },
            units: [{ apartmentId: "apt-1", unitCode: "A-10-04", incomeCollected: "1000.00", depositCollected: "0.00", deductibleExpenses: "50.00", netPayout: "650.00" }],
          },
        }) as ReturnType<typeof apiFetch>;
      }
      if (path.startsWith("/owner-ledger/entries")) {
        return Promise.resolve({
          data: { rows: [ENTRY, EXPENSE_ENTRY, PAYOUT_ENTRY], total: 3 },
        }) as ReturnType<typeof apiFetch>;
      }
      if (path.startsWith("/owner-billing/expense-proofs")) {
        return Promise.resolve({ data: [] }) as ReturnType<typeof apiFetch>;
      }
      return Promise.resolve({ data: { rows: [], total: 0 } }) as ReturnType<typeof apiFetch>;
    });
    renderPage();
    await screen.findByRole("heading", { name: /A-10-04/ });

    // Section order: Income, Expenses, then Payouts (below Expenses).
    const sectionHeadings = (await screen.findAllByRole("heading", { level: 4 })).map(
      (h) => h.textContent,
    );
    expect(sectionHeadings).toEqual([
      "Income (money in)",
      "Expenses (paid by KAEN, deducted from payout)",
      "Payouts",
    ]);

    const payoutRow = await screen.findByRole("row", { name: /Entry payout-1/i });
    // Status pill: the payment-status label, never ownerLedgerRowStatus's
    // non-income mislabel ("Owner-paid" — includeInPayout is false here too).
    expect(within(payoutRow).getByText("Paid")).toBeInTheDocument();
    expect(within(payoutRow).queryByText("Owner-paid")).not.toBeInTheDocument();
    // Amount: sky-toned, distinct from income's emerald (money leaving KAEN).
    const amountEl = within(payoutRow).getByText("RM 300.00");
    expect(amountEl.className).toContain("sky");
    expect(amountEl.className).not.toContain("emerald");
  });

  it("shows Void (not the raw payment status) for a voided payout row", async () => {
    apiFetchMock.mockImplementation((path: string) => {
      if (path === "/owner-ledger/units/apt-1/context") {
        return Promise.resolve({ data: CTX }) as ReturnType<typeof apiFetch>;
      }
      if (path.startsWith("/owner-ledger/owners/owner-1/units-summary")) {
        return Promise.resolve({
          data: {
            month: "2026-07",
            combined: { incomeCollected: "0.00", depositCollected: "0.00", deductibleExpenses: "0.00", netPayout: "-300.00" },
            units: [{ apartmentId: "apt-1", unitCode: "A-10-04", incomeCollected: "0.00", depositCollected: "0.00", deductibleExpenses: "0.00", netPayout: "-300.00" }],
          },
        }) as ReturnType<typeof apiFetch>;
      }
      if (path.startsWith("/owner-ledger/entries")) {
        return Promise.resolve({
          data: { rows: [VOIDED_PAYOUT_ENTRY], total: 1 },
        }) as ReturnType<typeof apiFetch>;
      }
      if (path.startsWith("/owner-billing/expense-proofs")) {
        return Promise.resolve({ data: [] }) as ReturnType<typeof apiFetch>;
      }
      return Promise.resolve({ data: { rows: [], total: 0 } }) as ReturnType<typeof apiFetch>;
    });
    renderPage();
    const row = await screen.findByRole("row", { name: /Entry payout-void/i });
    // A voided payout must read "Void" — NOT the raw paymentStatus label
    // ("Paid"), which the naive getStatusTone(paymentStatus)/labelFor
    // resolver would show without a void-first check (unlike unit-workspace's
    // Income/Expenses sections, whose default resolveStatus is
    // ownerLedgerRowStatus, itself void-first).
    expect(within(row).getByText("Void")).toBeInTheDocument();
    expect(within(row).queryByText("Paid")).not.toBeInTheDocument();
  });
});
