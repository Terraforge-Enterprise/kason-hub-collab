import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import OwnerStatementPage from "../owner-statement";

// ─── Mock portal API fetch ─────────────────────────────────────────────────────
// useOwnerLedger hits /owner-ledger; page also hits /statements for the PDF button.
// PortalApiError must be the REAL class so the page's `instanceof` branch works.

const portalApiFetch = vi.fn();
vi.mock("@/lib/portal-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/portal-api")>("@/lib/portal-api");
  return {
    PortalApiError: actual.PortalApiError,
    portalApiFetch: (...args: unknown[]) => portalApiFetch(...args),
  };
});

// window.open spy — PDF download opens a new tab.
const openSpy = vi.fn();
vi.stubGlobal("open", openSpy);

// ─── Mock the 5-section portal hook (2c-4 drill-in) ────────────────────────────
// Keep useOwnerLedger real (it goes through the mocked portalApiFetch above);
// only override usePortalStatementSections so we control the drill-in data.
const { usePortalStatementSectionsMock } = vi.hoisted(() => ({
  usePortalStatementSectionsMock: vi.fn(),
}));
vi.mock("@/api/portal-owner-ledger", async () => {
  const actual = await vi.importActual<typeof import("@/api/portal-owner-ledger")>(
    "@/api/portal-owner-ledger",
  );
  return { ...actual, usePortalStatementSections: usePortalStatementSectionsMock };
});

/** Full 5-section YannieSections fixture (empty rows — only headings are asserted). */
const FULL_SECTIONS = {
  header: {
    reportMonth: "June 2026",
    propertyName: "PV9",
    ownerName: "Ahmad",
    bankName: null,
    accountHolder: null,
    accountNumberMasked: null,
  },
  occupancy: { rows: [], occupiedCount: 0, vacantCount: 0, totalMonthlyRental: "0.00" },
  payoutSummary: { lines: [], netPayoutToOwner: "0.00", depositCollected: "0.00" },
  incomeBreakdown: { rows: [], totalIncome: "0.00", totalMgmtFee: "0.00" },
  expenseBreakdown: { rows: [], totalExpenses: "0.00" },
};

/** A statement item with an arbitrary status for the month. */
function makeStatementItem(status: string, id = "stmt-x") {
  return { id, periodMonth: "2026-06-01T00:00:00.000Z", status, totalAmount: "0.00", netRemittance: "0.00" };
}

// ─── Shared row factories ──────────────────────────────────────────────────────

function makeRow(overrides: Partial<typeof BASE_INCOME_ROW> = {}) {
  return { ...BASE_INCOME_ROW, ...overrides };
}

const BASE_INCOME_ROW = {
  id: "row-income-1",
  statementMonth: "2026-06",
  transactionDate: "2026-06-01",
  direction: "income",
  category: "rental_income",
  description: "Rent — A-101",
  remarks: null,
  amount: "2500.00",
  sstAmount: null,
  paidBy: "owner",       // income rows: paidBy is conventionally "owner"
  paymentStatus: "paid",
  taxCategory: "rental_income",
  attachmentKeys: [],
  propertyId: "prop-1",
  apartmentId: "apt-1",
  unitCode: "A-101",
  listingId: null,
};

/** KAEN-paid expense (includeInPayout === true in DB — derived from paidBy==="kaen"). */
const KAEN_EXPENSE_ROW = makeRow({
  id: "row-kaen-exp",
  direction: "expense",
  category: "management_fee",
  description: "Management fee — June",
  amount: "250.00",
  paidBy: "kaen",
  taxCategory: "rental_expense",
});

/** Owner-paid expense (includeInPayout === false — paidBy !== "kaen"). */
const OWNER_EXPENSE_ROW = makeRow({
  id: "row-owner-exp",
  direction: "expense",
  category: "assessment",
  description: "Quit rent",
  amount: "320.00",
  paidBy: "owner",
  taxCategory: "govt_assessment",
});

const SUMMARY = {
  grossRental: "2500.00",
  totalExpenses: "570.00",
  netRentalAfterExpenses: "1930.00",
  netPayoutToOwner: "2250.00",   // 2500 − 250 (KAEN-paid only)
  payoutsTotal: "0.00",
  byCategory: { management_fee: "250.00", assessment: "320.00" },
  // Balance fields
  broughtForward: "500.00",
  carriedForward: "2750.00",
};

const SUMMARY_NEGATIVE_CF = {
  ...SUMMARY,
  broughtForward: "-300.00",
  carriedForward: "-550.00",
};

const EMPTY_STATEMENTS = { data: { month: "2026-06", statements: [] } };

const DOWNLOADABLE_STATEMENT_ITEM = {
  id: "stmt-sent",
  periodMonth: "2026-06-01T00:00:00.000Z",
  status: "sent",
  totalAmount: "250.00",
  netRemittance: "2250.00",
};

const STATEMENTS_WITH_DOWNLOADABLE = {
  data: {
    month: "2026-06",
    statements: [DOWNLOADABLE_STATEMENT_ITEM],
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeOwnerLedgerResponse(
  rows: typeof BASE_INCOME_ROW[],
  summary = SUMMARY,
) {
  return { data: { rows, summary } };
}

/** Route the mock: /owner-ledger → ledger; /statements/:id/pdf → PDF; /statements → list. */
function routeMock(opts: {
  ledger: unknown;
  statements?: unknown;
  pdf?: () => Promise<unknown>;
}) {
  portalApiFetch.mockImplementation(async (path: string) => {
    if (/^\/owner-ledger/.test(path)) return opts.ledger;
    if (/^\/statements\/[^/]+\/pdf$/.test(path)) {
      if (opts.pdf) return opts.pdf();
      return { data: { downloadUrl: "https://signed/stmt-sent" } };
    }
    if (/^\/statements/.test(path)) return opts.statements ?? EMPTY_STATEMENTS;
    throw new Error(`unexpected path: ${path}`);
  });
}

function wrap(children: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
}

// ─── Task 10 live-ledger fixtures (/owner-live surface) ────────────────────────

const LIVE_FLAG = "VITE_ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER";

const now = new Date();
/** Current wall-clock month "YYYY-MM" — included under Transactions, never under Statements. */
const CUR_M = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

/** GET /owner-live/transactions → { balance (summary), rows (settled cash) }. */
const LIVE_TX_RESPONSE = {
  data: {
    scope: "combined",
    apartmentId: null,
    balance: {
      broughtForward: "500.00",
      periodGross: "2500.00",
      periodExpenses: "570.00",
      periodPayouts: "0.00",
      netThisPeriod: "2250.00",
      depositCollected: "1000.00",
      carriedForward: "2750.00",
    },
    rows: [
      {
        id: "tx-cur",
        statementMonth: CUR_M,
        transactionDate: `${CUR_M}-05T00:00:00.000Z`,
        direction: "income",
        category: "rental_income",
        description: "Live rent this month",
        amount: "2500.00",
        paymentStatus: "paid",
        apartmentId: "apt-1",
      },
    ],
  },
};

/** GET /owner-live/statements → { items } — frozen (PAST) months only. */
const LIVE_STMT_RESPONSE = {
  data: {
    items: [
      {
        id: "period-may",
        month: "2026-05",
        apartmentId: null,
        issuedAt: "2026-06-01T00:00:00.000Z",
        openingBalanceC: 50000,
        closingBalanceC: 275000,
        netPayoutC: 225000,
        pdfKey: "owner-statements/o/2026-05.pdf",
      },
      {
        id: "period-apr",
        month: "2026-04",
        apartmentId: null,
        issuedAt: "2026-05-01T00:00:00.000Z",
        openingBalanceC: 0,
        closingBalanceC: 50000,
        netPayoutC: 50000,
        pdfKey: "owner-statements/o/2026-04.pdf",
      },
    ],
  },
};

/** GET /owner-live/reconciliation → { data: OwnerPayableReconciliation }. */
const LIVE_RECONCILIATION_RESPONSE = {
  data: {
    ownerPartyId: "owner-1",
    apartmentId: null,
    periodMonth: CUR_M,
    openingPayableC: 50000,
    collectionsC: 250000,
    offsetDeductionsC: 0,
    passThroughExpensesC: 0,
    grossRemittancesC: 0,
    reversalsC: 0,
    closingPayableC: 300000,
    balanced: true,
    discrepancyC: 0,
    periodStatus: "open",
    frozenNetPayableAtCloseC: null,
    remainingPayableNowC: 300000,
  },
};

/**
 * Route the mock for the live-ledger surface (/owner-live/*), with benign
 * fall-throughs for the legacy paths so a not-yet-wired page (RED) fails on an
 * assertion, not a thrown "unexpected path".
 */
function routeLive() {
  portalApiFetch.mockImplementation(async (path: string) => {
    if (/^\/owner-live\/transactions/.test(path)) return LIVE_TX_RESPONSE;
    if (/^\/owner-live\/statements\/[^/]+\/pdf$/.test(path))
      return { data: { url: "https://signed/period-may.pdf" } };
    if (/^\/owner-live\/reconciliation/.test(path)) return LIVE_RECONCILIATION_RESPONSE;
    if (/^\/owner-live\/statements/.test(path)) return LIVE_STMT_RESPONSE;
    if (/^\/owner-ledger/.test(path)) return { data: { rows: [], summary: SUMMARY } };
    if (/^\/statements/.test(path)) return EMPTY_STATEMENTS;
    throw new Error(`unexpected path: ${path}`);
  });
}

// Every test unstubs env after itself so a flag-ON stub can't bleed into the
// flag-OFF (legacy) suites below.
afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("OwnerStatementPage", () => {
  beforeEach(() => {
    portalApiFetch.mockReset();
    openSpy.mockReset();
    // Pin the legacy suites to flag-OFF explicitly (they rely on the flag being
    // dark — the current, unchanged behavior).
    vi.stubEnv(LIVE_FLAG, "false");
    // Default: drill-in hook disabled / no data (existing tests don't post statements).
    usePortalStatementSectionsMock.mockReset();
    usePortalStatementSectionsMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
    });
  });

  it("shows the KAEN-paid expense and excludes the owner-paid expense", async () => {
    routeMock({
      ledger: makeOwnerLedgerResponse([
        BASE_INCOME_ROW as typeof BASE_INCOME_ROW,
        KAEN_EXPENSE_ROW as typeof BASE_INCOME_ROW,
        OWNER_EXPENSE_ROW as typeof BASE_INCOME_ROW,
      ]),
    });
    render(wrap(<OwnerStatementPage />));

    // Wait for data to load.
    expect(await screen.findByText("Payout Breakdown")).toBeInTheDocument();

    // KAEN-paid expense (management_fee) IS shown under "Less — Paid by KAEN".
    // humaniseCategory("management_fee") → "Management Fee"
    expect(screen.getByText("Management Fee")).toBeInTheDocument();

    // The KAEN expense's amount appears as a deduction at least once
    // (it may appear in both the per-category line and the total row).
    expect(screen.getAllByText(/− RM 250\.00/).length).toBeGreaterThan(0);

    // Owner-paid expense (assessment) is NOT shown in the payout breakdown.
    // humaniseCategory("assessment") → "Assessment" — must not appear.
    expect(screen.queryByText("Assessment")).not.toBeInTheDocument();

    // "Quit rent" description of the owner-paid row must not appear either.
    expect(screen.queryByText("Quit rent")).not.toBeInTheDocument();
  });

  it("shows the Net Payout to You from summary.netPayoutToOwner", async () => {
    routeMock({
      ledger: makeOwnerLedgerResponse([
        BASE_INCOME_ROW as typeof BASE_INCOME_ROW,
        KAEN_EXPENSE_ROW as typeof BASE_INCOME_ROW,
        OWNER_EXPENSE_ROW as typeof BASE_INCOME_ROW,
      ]),
    });
    render(wrap(<OwnerStatementPage />));

    // The GlowCard + the breakdown section both show the net payout.
    // We assert on the data-testid for the GlowCard value (authoritative display).
    const payoutCell = await screen.findByTestId("net-payout-value");
    expect(payoutCell).toHaveTextContent("RM 2,250.00");
  });

  it("renders the Callout pointer about owner-paid items in Income & Tax", async () => {
    routeMock({
      ledger: makeOwnerLedgerResponse([BASE_INCOME_ROW as typeof BASE_INCOME_ROW]),
    });
    render(wrap(<OwnerStatementPage />));

    // The Callout text (normalised for entity encoding) should appear.
    expect(
      await screen.findByText(
        /owner-paid items appear in income & tax — they don't reduce this payout/i,
      ),
    ).toBeInTheDocument();
  });

  it("shows a Download PDF button when a formal statement exists for the month", async () => {
    routeMock({
      ledger: makeOwnerLedgerResponse([BASE_INCOME_ROW as typeof BASE_INCOME_ROW]),
      statements: STATEMENTS_WITH_DOWNLOADABLE,
    });
    render(wrap(<OwnerStatementPage />));

    const btn = await screen.findByTestId("download-pdf-btn");
    expect(btn).toBeInTheDocument();
    expect(btn).toBeEnabled();
  });

  it("hides the Download PDF button when no formal statement exists", async () => {
    routeMock({
      ledger: makeOwnerLedgerResponse([BASE_INCOME_ROW as typeof BASE_INCOME_ROW]),
      statements: EMPTY_STATEMENTS,
    });
    render(wrap(<OwnerStatementPage />));

    // Wait for the statement section to load (empty state message).
    expect(await screen.findByText("No formal statement for this month")).toBeInTheDocument();
    expect(screen.queryByTestId("download-pdf-btn")).not.toBeInTheDocument();
  });

  it("opens the signed URL when Download PDF is clicked", async () => {
    routeMock({
      ledger: makeOwnerLedgerResponse([BASE_INCOME_ROW as typeof BASE_INCOME_ROW]),
      statements: STATEMENTS_WITH_DOWNLOADABLE,
    });
    // The handler opens a blank tab synchronously (popup-blocker-safe) inside
    // the click gesture, then navigates that tab to the fetched signed URL.
    const fakeWin = { opener: null as unknown, location: { href: "" }, close: vi.fn() };
    openSpy.mockReturnValue(fakeWin);
    render(wrap(<OwnerStatementPage />));

    const btn = await screen.findByTestId("download-pdf-btn");
    fireEvent.click(btn);

    expect(openSpy).toHaveBeenCalledWith("about:blank", "_blank");
    await waitFor(() => expect(fakeWin.location.href).toBe("https://signed/stmt-sent"));
  });

  it("shows 'Rent Collected' income and the correct total", async () => {
    routeMock({
      ledger: makeOwnerLedgerResponse([BASE_INCOME_ROW as typeof BASE_INCOME_ROW]),
    });
    render(wrap(<OwnerStatementPage />));

    // Income line description.
    expect(await screen.findByText("Rent — A-101")).toBeInTheDocument();
    // "Rent Collected" appears at least once (stat card label + breakdown heading).
    expect(screen.getAllByText("Rent Collected").length).toBeGreaterThan(0);
  });

  it("shows Running Balance section with Brought Forward + Carried Forward", async () => {
    routeMock({
      ledger: makeOwnerLedgerResponse([BASE_INCOME_ROW as typeof BASE_INCOME_ROW], SUMMARY),
    });
    render(wrap(<OwnerStatementPage />));

    expect(await screen.findByText("Running Balance")).toBeInTheDocument();
    expect(screen.getByText("Brought forward")).toBeInTheDocument();
    expect(screen.getByText("Carried forward")).toBeInTheDocument();

    const cf = screen.getByTestId("carried-forward-portal-value");
    expect(cf).toHaveTextContent("RM 2,750.00");
    expect(cf.className).toContain("emerald");
  });

  it("shows carried-forward in rose when negative and shows KAEN fronted message", async () => {
    routeMock({
      ledger: makeOwnerLedgerResponse([BASE_INCOME_ROW as typeof BASE_INCOME_ROW], SUMMARY_NEGATIVE_CF),
    });
    render(wrap(<OwnerStatementPage />));

    await screen.findByText("Running Balance");

    const cf = screen.getByTestId("carried-forward-portal-value");
    expect(cf.className).toContain("rose");
    // formatRM renders negative as "RM -550.00" (locale hyphen-minus)
    expect(cf).toHaveTextContent("RM");

    expect(screen.getByText(/KAEN has fronted/i)).toBeInTheDocument();
  });

  // ─── 5-section drill-in (Task 2c-4) ──────────────────────────────────────────

  it("renders all 5 statement sections for a POSTED (approved) month", async () => {
    routeMock({
      ledger: makeOwnerLedgerResponse([BASE_INCOME_ROW as typeof BASE_INCOME_ROW]),
      statements: { data: { month: "2026-06", statements: [makeStatementItem("approved")] } },
    });
    usePortalStatementSectionsMock.mockReturnValue({
      data: { data: FULL_SECTIONS },
      isLoading: false,
      isError: false,
    });
    render(wrap(<OwnerStatementPage />));

    // All five admin-parity section headings render (read-only drill-in).
    expect(await screen.findByText("Statement Details")).toBeInTheDocument();
    expect(screen.getByText("Occupancy")).toBeInTheDocument();
    expect(screen.getByText("Payout Summary")).toBeInTheDocument();
    expect(screen.getByText("Income Breakdown")).toBeInTheDocument();
    expect(screen.getByText("Expense Breakdown")).toBeInTheDocument();
  });

  it("shows 'Pending' and NO 5-section drill-in for a DRAFT month", async () => {
    routeMock({
      ledger: makeOwnerLedgerResponse([BASE_INCOME_ROW as typeof BASE_INCOME_ROW]),
      statements: {
        data: { month: "2026-06", statements: [makeStatementItem("draft", "stmt-draft")] },
      },
    });
    render(wrap(<OwnerStatementPage />));

    // Draft month → "Pending", no drill-in.
    expect(await screen.findByText(/pending/i)).toBeInTheDocument();

    // The 5 section headings must NOT render before the statement is posted.
    expect(screen.queryByText("Statement Details")).not.toBeInTheDocument();
    expect(screen.queryByText("Occupancy")).not.toBeInTheDocument();
    expect(screen.queryByText("Income Breakdown")).not.toBeInTheDocument();
    expect(screen.queryByText("Expense Breakdown")).not.toBeInTheDocument();
  });
});

// ─── Task 10: transaction history (live) vs statements (frozen) ────────────────

describe("OwnerStatementPage — live ledger (Task 10)", () => {
  beforeEach(() => {
    portalApiFetch.mockReset();
    openSpy.mockReset();
    usePortalStatementSectionsMock.mockReset();
    usePortalStatementSectionsMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
    });
  });

  it("(a) flag ON → Transactions tab shows live rows + balance summary (current month included)", async () => {
    vi.stubEnv(LIVE_FLAG, "true");
    routeLive();
    render(wrap(<OwnerStatementPage />));

    // The new two-view surface exposes a Transactions / Statements switcher.
    expect(await screen.findByRole("radio", { name: /transactions/i })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /statements/i })).toBeInTheDocument();

    // The CURRENT month's settled row is listed under Transactions (current month INCLUDED).
    expect(await screen.findByText("Live rent this month")).toBeInTheDocument();

    // The authoritative balance SUMMARY renders (carried forward 2750 is unique to it).
    expect(screen.getAllByText(/RM 2,750\.00/).length).toBeGreaterThan(0);

    // Wired to the /owner-live prefix (NOT /owner).
    expect(
      portalApiFetch.mock.calls.some((c: unknown[]) =>
        /^\/owner-live\/transactions/.test(String(c[0])),
      ),
    ).toBe(true);
  });

  it("(b) Statements tab shows frozen docs only (current month absent) with a PDF download", async () => {
    vi.stubEnv(LIVE_FLAG, "true");
    routeLive();
    render(wrap(<OwnerStatementPage />));

    fireEvent.click(await screen.findByRole("radio", { name: /statements/i }));

    // A frozen (past) statement document is listed.
    expect(await screen.findByText(/May 2026/i)).toBeInTheDocument();

    // Each frozen doc offers a PDF download affordance.
    expect(
      (await screen.findAllByRole("button", { name: /download pdf/i })).length,
    ).toBeGreaterThan(0);

    // The current open month's live row is NOT under Statements (current month EXCLUDED).
    expect(screen.queryByText("Live rent this month")).not.toBeInTheDocument();

    // Wired to the /owner-live prefix.
    expect(
      portalApiFetch.mock.calls.some((c: unknown[]) =>
        /^\/owner-live\/statements/.test(String(c[0])),
      ),
    ).toBe(true);
  });

  it("(b2) downloading a frozen statement opens its signed /owner-live PDF URL", async () => {
    vi.stubEnv(LIVE_FLAG, "true");
    routeLive();
    const fakeWin = { opener: null as unknown, location: { href: "" }, close: vi.fn() };
    openSpy.mockReturnValue(fakeWin);
    render(wrap(<OwnerStatementPage />));

    fireEvent.click(await screen.findByRole("radio", { name: /statements/i }));
    const dl = (await screen.findAllByRole("button", { name: /download pdf/i }))[0];
    fireEvent.click(dl);

    expect(openSpy).toHaveBeenCalledWith("about:blank", "_blank");
    await waitFor(() => expect(fakeWin.location.href).toBe("https://signed/period-may.pdf"));
    expect(
      portalApiFetch.mock.calls.some((c: unknown[]) =>
        /^\/owner-live\/statements\/[^/]+\/pdf$/.test(String(c[0])),
      ),
    ).toBe(true);
  });

  it("(d) Statements tab also renders the reconciliation panel (waterfall + Reconciled pill)", async () => {
    vi.stubEnv(LIVE_FLAG, "true");
    routeLive();
    render(wrap(<OwnerStatementPage />));

    fireEvent.click(await screen.findByRole("radio", { name: /statements/i }));

    expect(await screen.findByText("Payable Reconciliation")).toBeInTheDocument();
    expect(screen.getByText("Opening payable")).toBeInTheDocument();
    expect(screen.getByText("Closing payable")).toBeInTheDocument();
    expect(screen.getByText("Reconciled")).toBeInTheDocument();

    expect(
      portalApiFetch.mock.calls.some((c: unknown[]) =>
        /^\/owner-live\/reconciliation\?month=/.test(String(c[0])),
      ),
    ).toBe(true);
  });

  it("(e) reconciliation panel still renders even when the frozen-statements fetch itself errors", async () => {
    vi.stubEnv(LIVE_FLAG, "true");
    // Deliberately does NOT reuse routeLive(): /owner-live/statements throws
    // while /owner-live/reconciliation still succeeds, so this proves the two
    // data sources are isolated (the 4-site {reconciliationPanel} wrap must
    // reach the isError branch too, not just the happy-path branch).
    portalApiFetch.mockImplementation(async (path: string) => {
      if (/^\/owner-live\/transactions/.test(path)) return LIVE_TX_RESPONSE;
      if (/^\/owner-live\/reconciliation/.test(path)) return LIVE_RECONCILIATION_RESPONSE;
      if (/^\/owner-live\/statements/.test(path)) throw new Error("boom");
      if (/^\/owner-ledger/.test(path)) return { data: { rows: [], summary: SUMMARY } };
      if (/^\/statements/.test(path)) return EMPTY_STATEMENTS;
      throw new Error(`unexpected path: ${path}`);
    });
    render(wrap(<OwnerStatementPage />));

    fireEvent.click(await screen.findByRole("radio", { name: /statements/i }));

    // Frozen-statements list shows its own error state...
    expect(await screen.findByText(/couldn't load your statements/i)).toBeInTheDocument();
    // ...but the reconciliation panel (a separate data source) still renders.
    expect(screen.getByText("Payable Reconciliation")).toBeInTheDocument();
    expect(screen.getByText("Reconciled")).toBeInTheDocument();
  });

  it("(c) flag OFF → legacy page unchanged (no tabs, Payout Breakdown shown)", async () => {
    vi.stubEnv(LIVE_FLAG, "false");
    routeLive();
    render(wrap(<OwnerStatementPage />));

    expect(await screen.findByText("Payout Breakdown")).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /transactions/i })).not.toBeInTheDocument();
  });
});
