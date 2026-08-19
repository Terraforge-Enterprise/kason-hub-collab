import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

// Task 6 (tenant-portal-redesign) — Billing "Invoices & Charges" tab + charge
// detail drawer + relocated "Billing documents" subsection (spec R11/R13).
// Mirrors __tests__/payments.test.tsx / billing-shell.test.tsx: mock
// @/lib/portal-api + @/lib/feature-flags, native matchers only (no jest-dom),
// QueryClientProvider (retry:false) + MemoryRouter.

const portalApiFetch = vi.fn();
vi.mock("@/lib/portal-api", () => ({
  portalApiFetch: (...args: unknown[]) => portalApiFetch(...args),
  portalApiUrl: (path: string) => `/portal-api${path}`,
  PortalApiError: class PortalApiError extends Error {},
}));

vi.mock("@/lib/feature-flags", () => ({
  isPhase2FlagEnabled: vi.fn(),
}));

import { isPhase2FlagEnabled } from "@/lib/feature-flags";
import { InvoicesTab } from "../billing/invoices-tab";
import { ChargeDrawer } from "../billing/charge-drawer";

// window.open spy — PDF download opens a new tab (mirrors
// __tests__/owner-statement.test.tsx's convention).
//
// The tab is opened SYNCHRONOUSLY with "about:blank" and navigated once the signed
// URL arrives, NOT opened one-shot with the final URL: the pdf endpoint renders on
// demand on first ask (53.8s cold on UAT), so an open deferred until after the await
// has lost user activation and the popup blocker eats it. `open` therefore has to
// hand back a tab object the caller can steer.
const openSpy = vi.fn(() => openedTab);
let openedTab: { location: { href: string }; opener: unknown; close: ReturnType<typeof vi.fn> };
function freshTab() {
  openedTab = { location: { href: "" }, opener: {}, close: vi.fn() };
  return openedTab;
}
freshTab();
vi.stubGlobal("open", openSpy);

const mockIsPhase2FlagEnabled = vi.mocked(isPhase2FlagEnabled);

// --- Fixtures ----------------------------------------------------------------
// `id` is deliberately shaped like a raw internal id (and distinct from
// `chargeNumber`) so a regression that renders `charge.id` instead of
// `charge.chargeNumber` as the DOCUMENT label is caught (spec R11: "never
// show raw ids like GRIDUTIL-...").

// dueDate is deliberately in the FUTURE (relative to "today" = 2026-07-20)
// so this charge lands in the plain "unpaid, not yet due" bucket rather than
// "overdue" — isOverdueCharge(charge) must be false for this fixture.
const CHARGE_UNPAID = {
  id: "c-internal-001",
  chargeNumber: "IVTEN-0007", documentNumber: "IVTEN-0007",
  chargeType: "utility",
  description: "July utilities",
  status: "posted",
  dueDate: "2026-09-01T00:00:00.000Z",
  amount: 1060,
  outstandingAmount: 100,
  currency: "MYR",
};

// description:null exercises the description-falls-back-to-chargeType path
// (mirrors the existing `overdueCharges[0]?.description || ...chargeType`
// idiom already used in billing/index.tsx).
const CHARGE_PAID = {
  id: "c-internal-002",
  chargeNumber: "RENT-0726", documentNumber: "RENT-0726",
  chargeType: "rent",
  description: null,
  status: "posted",
  dueDate: "2026-07-01T00:00:00.000Z",
  amount: 1200,
  outstandingAmount: 0,
  currency: "MYR",
};

const CHARGE_VOID = {
  id: "c-internal-003",
  chargeNumber: "CHG-0099", documentNumber: "CHG-0099",
  chargeType: "misc",
  description: "Should never render",
  status: "void",
  dueDate: "2026-05-01T00:00:00.000Z",
  amount: 50,
  outstandingAmount: 50,
  currency: "MYR",
};

// Fully offset by a credit note — outstandingAmount is 0 but this is NOT the
// same thing as tenant-paid (B21): the "Paid" filter/status must exclude it.
const CHARGE_CREDITED_ZERO = {
  id: "c-internal-004",
  chargeNumber: "CHG-0055", documentNumber: "CHG-0055",
  chargeType: "adjustment",
  description: "Adjustment credited in full",
  status: "credited",
  dueDate: "2026-06-01T00:00:00.000Z",
  amount: 200,
  outstandingAmount: 0,
  currency: "MYR",
};

// status:"posted" + far-past dueDate -> isOverdueCharge() is true (spec's
// "Overdue" bucket).
const CHARGE_OVERDUE = {
  id: "c-internal-005",
  chargeNumber: "CHG-0023", documentNumber: "CHG-0023",
  chargeType: "rent",
  description: "April rent",
  status: "posted",
  dueDate: "2020-01-01T00:00:00.000Z",
  amount: 1200,
  outstandingAmount: 1200,
  currency: "MYR",
};

// status:"partial" + far-past dueDate -> isOverdueCharge() is DELIBERATELY
// false (the shared T5 helper only flags status==="posted" as overdue-
// eligible; partial/partially_paid is excluded by that helper's own
// contract, which this task reuses as-is, not redefines — B20). This charge
// is genuinely past due but must NOT surface under the "Overdue" filter;
// it belongs under "Unpaid" instead.
const CHARGE_PARTIAL_OVERDUE = {
  id: "c-internal-006",
  chargeNumber: "CHG-0077", documentNumber: "CHG-0077",
  chargeType: "utility",
  description: "Partially paid, past due",
  status: "partial",
  dueDate: "2020-01-01T00:00:00.000Z",
  amount: 500,
  outstandingAmount: 200,
  currency: "MYR",
};

function chargesResponse(data: unknown[]) {
  return { data, pagination: { page: 1, limit: 20, total: data.length, totalPages: 1 } };
}

function renderTab() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/portal/billing?tab=invoices"]}>
        <InvoicesTab />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  portalApiFetch.mockReset();
  openSpy.mockReset();
  openSpy.mockImplementation(() => freshTab());
  mockIsPhase2FlagEnabled.mockReset();
  mockIsPhase2FlagEnabled.mockReturnValue(false);
  portalApiFetch.mockImplementation((path: string) => {
    if (path.startsWith("/charges")) return Promise.resolve(chargesResponse([CHARGE_UNPAID, CHARGE_PAID]));
    if (path === "/documents/billing") return Promise.resolve({ data: { documents: [] } });
    return Promise.reject(new Error(`unexpected portalApiFetch path: ${path}`));
  });
});

describe("InvoicesTab — the Document column shows a DOCUMENT number", () => {
  // The column header has always read "Document" while the cell printed
  // `chargeNumber`. Every fixture above happened to carry an invoice-shaped
  // chargeNumber, which hid the defect: a real grid-minted charge's chargeNumber
  // embeds raw UUIDs, so tenants were shown
  // `GRIDEXP-202608-360f0307-7426-412f-b362-3e500534b44d-SST` under a heading
  // promising them their invoice number. This fixture is the real shape.
  const GRID_CHARGE = {
    id: "c-internal-900",
    chargeNumber: "GRIDEXP-202608-360f0307-7426-412f-b362-3e500534b44d-SST",
    documentNumber: "IVTEN-0002",
    chargeType: "expense",
    description: "test ten exp sst",
    status: "posted",
    dueDate: "2026-09-01T00:00:00.000Z",
    amount: 0.54,
    outstandingAmount: 0.54,
    currency: "MYR",
  };

  it("prints the bill number and never the UUID-bearing chargeNumber", async () => {
    portalApiFetch.mockImplementation((path: string) => {
      if (path.startsWith("/charges")) return Promise.resolve(chargesResponse([GRID_CHARGE]));
      if (path === "/documents/billing") return Promise.resolve({ data: { documents: [] } });
      return Promise.reject(new Error(`unexpected portalApiFetch path: ${path}`));
    });
    renderTab();

    expect(await screen.findByText("IVTEN-0002")).toBeTruthy();
    expect(screen.queryByText(/GRIDEXP-202608/)).toBeNull();
    expect(screen.queryByText(/360f0307/)).toBeNull();
  });

  it("prints an em dash, not an internal id, for a charge on no bill yet", async () => {
    portalApiFetch.mockImplementation((path: string) => {
      if (path.startsWith("/charges")) {
        return Promise.resolve(chargesResponse([{ ...GRID_CHARGE, documentNumber: null }]));
      }
      if (path === "/documents/billing") return Promise.resolve({ data: { documents: [] } });
      return Promise.reject(new Error(`unexpected portalApiFetch path: ${path}`));
    });
    renderTab();

    expect(await screen.findByText("test ten exp sst")).toBeTruthy();
    expect(screen.queryByText(/GRIDEXP-202608/)).toBeNull();
    expect(screen.getByText("—")).toBeTruthy();
  });

  it("still finds the row when searching by the bill number the column shows", async () => {
    portalApiFetch.mockImplementation((path: string) => {
      if (path.startsWith("/charges")) return Promise.resolve(chargesResponse([GRID_CHARGE, CHARGE_PAID]));
      if (path === "/documents/billing") return Promise.resolve({ data: { documents: [] } });
      return Promise.reject(new Error(`unexpected portalApiFetch path: ${path}`));
    });
    renderTab();
    await screen.findByText("IVTEN-0002");

    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: "IVTEN-0002" } });

    expect(screen.getByText("IVTEN-0002")).toBeTruthy();
    expect(screen.queryByText("RENT-0726")).toBeNull();
  });
});

describe("InvoicesTab — list", () => {
  it("list: renders rows with documentNumber (not raw id), formatRM amounts, formatDateMY due date, and a status label", async () => {
    renderTab();

    expect(await screen.findByText("IVTEN-0007")).toBeTruthy();
    expect(screen.getByText("RENT-0726")).toBeTruthy();

    // Raw internal ids must never appear as visible text (spec R11).
    expect(screen.queryByText("c-internal-001")).toBeNull();
    expect(screen.queryByText("c-internal-002")).toBeNull();

    // DESCRIPTION column: explicit description, and null-description
    // fallback to chargeType.
    expect(screen.getByText("July utilities")).toBeTruthy();
    expect(screen.getByText("rent")).toBeTruthy();

    // TOTAL / BALANCE via formatRM.
    expect(screen.getByText("RM 1,060.00")).toBeTruthy();
    expect(screen.getByText("RM 100.00")).toBeTruthy();
    expect(screen.getByText("RM 1,200.00")).toBeTruthy();
    // RM 0.00 appears for the paid row's BALANCE.
    expect(screen.getByText("RM 0.00")).toBeTruthy();

    // DUE via formatDateMY. (en-MY's short-month format renders September as
    // "Sept", not "Sep" — matching the actual Intl output, not a typo.)
    expect(screen.getByText("1 Sept 2026")).toBeTruthy();
    expect(screen.getByText("1 Jul 2026")).toBeTruthy();

    // STATUS badges (tenant labels chosen for this task) — scoped to the
    // table body since the status-filter <select> legitimately reuses the
    // same words ("Paid", "Unpaid") as <option> text elsewhere on the page.
    const table = screen.getByRole("table");
    expect(within(table).getByText("Unpaid")).toBeTruthy();
    expect(within(table).getByText("Paid")).toBeTruthy();
  });
});

describe("InvoicesTab — void hidden", () => {
  it("void hidden: a void charge never renders, even though a non-void charge on the same page does", async () => {
    portalApiFetch.mockImplementation((path: string) => {
      if (path.startsWith("/charges")) return Promise.resolve(chargesResponse([CHARGE_UNPAID, CHARGE_VOID]));
      if (path === "/documents/billing") return Promise.resolve({ data: { documents: [] } });
      return Promise.reject(new Error(`unexpected portalApiFetch path: ${path}`));
    });
    renderTab();

    expect(await screen.findByText("IVTEN-0007")).toBeTruthy();
    expect(screen.queryByText("CHG-0099")).toBeNull();
    expect(screen.queryByText("Should never render")).toBeNull();
  });
});

describe("InvoicesTab — search", () => {
  it("search: filters by chargeType even when the OTHER row's description is null (must not crash on null description)", async () => {
    renderTab();
    expect(await screen.findByText("IVTEN-0007")).toBeTruthy();
    expect(screen.getByText("RENT-0726")).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: "rent" } });

    expect(screen.getByText("RENT-0726")).toBeTruthy();
    expect(screen.queryByText("IVTEN-0007")).toBeNull();
  });

  it("search: filters by chargeNumber", async () => {
    renderTab();
    expect(await screen.findByText("IVTEN-0007")).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: "ivten" } });

    expect(screen.getByText("IVTEN-0007")).toBeTruthy();
    expect(screen.queryByText("RENT-0726")).toBeNull();
  });

  it("search: filters by description", async () => {
    renderTab();
    expect(await screen.findByText("IVTEN-0007")).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: "utilities" } });

    expect(screen.getByText("IVTEN-0007")).toBeTruthy();
    expect(screen.queryByText("RENT-0726")).toBeNull();
  });
});

describe("InvoicesTab — status filter", () => {
  it("filter: 'Paid' shows only truly-paid rows and excludes a credited (zero-balance but not paid) charge", async () => {
    portalApiFetch.mockImplementation((path: string) => {
      if (path.startsWith("/charges"))
        return Promise.resolve(chargesResponse([CHARGE_UNPAID, CHARGE_PAID, CHARGE_CREDITED_ZERO]));
      if (path === "/documents/billing") return Promise.resolve({ data: { documents: [] } });
      return Promise.reject(new Error(`unexpected portalApiFetch path: ${path}`));
    });
    renderTab();
    expect(await screen.findByText("IVTEN-0007")).toBeTruthy();

    fireEvent.change(screen.getByRole("combobox", { name: /status/i }), { target: { value: "paid" } });

    expect(screen.getByText("RENT-0726")).toBeTruthy();
    expect(screen.queryByText("IVTEN-0007")).toBeNull();
    // B21 — credited-zero-balance is NOT "paid".
    expect(screen.queryByText("CHG-0055")).toBeNull();

    // Nor is it "unpaid" (nothing is actually owed) — credited is its own
    // resolved state, distinct from both buckets; it only shows under "All".
    fireEvent.change(screen.getByRole("combobox", { name: /status/i }), { target: { value: "unpaid" } });
    expect(screen.queryByText("CHG-0055")).toBeNull();
  });

  it("filter: 'Overdue' shows a past-due posted charge but NOT a past-due partial charge (isOverdueCharge's own posted-only contract, reused as-is)", async () => {
    portalApiFetch.mockImplementation((path: string) => {
      if (path.startsWith("/charges"))
        return Promise.resolve(chargesResponse([CHARGE_OVERDUE, CHARGE_PARTIAL_OVERDUE]));
      if (path === "/documents/billing") return Promise.resolve({ data: { documents: [] } });
      return Promise.reject(new Error(`unexpected portalApiFetch path: ${path}`));
    });
    renderTab();
    expect(await screen.findByText("CHG-0023")).toBeTruthy();
    expect(screen.getByText("CHG-0077")).toBeTruthy();

    fireEvent.change(screen.getByRole("combobox", { name: /status/i }), { target: { value: "overdue" } });

    expect(screen.getByText("CHG-0023")).toBeTruthy();
    expect(screen.queryByText("CHG-0077")).toBeNull();

    // B20 — the past-due partial charge isn't lost, it's just categorized as
    // "Unpaid" instead of "Overdue".
    fireEvent.change(screen.getByRole("combobox", { name: /status/i }), { target: { value: "unpaid" } });
    expect(screen.getByText("CHG-0077")).toBeTruthy();
    expect(screen.queryByText("CHG-0023")).toBeNull();
  });
});

describe("InvoicesTab — empty and error states", () => {
  it("empty: zero charges from the API renders an EmptyState, not a crash", async () => {
    portalApiFetch.mockImplementation((path: string) => {
      if (path.startsWith("/charges")) return Promise.resolve(chargesResponse([]));
      if (path === "/documents/billing") return Promise.resolve({ data: { documents: [] } });
      return Promise.reject(new Error(`unexpected portalApiFetch path: ${path}`));
    });
    renderTab();

    expect(await screen.findByText(/no (invoices|charges)/i)).toBeTruthy();
  });

  it("error: a failed /charges fetch shows an error message, NOT the zero-charges EmptyState (a 500 must never look like 'you owe nothing')", async () => {
    portalApiFetch.mockImplementation((path: string) => {
      if (path.startsWith("/charges")) return Promise.reject(new Error("Server error. Try again in a moment."));
      if (path === "/documents/billing") return Promise.resolve({ data: { documents: [] } });
      return Promise.reject(new Error(`unexpected portalApiFetch path: ${path}`));
    });
    renderTab();

    // `findAllByText` (not findByText) — the message legitimately renders in
    // both the Callout's title <span> and its containing div, which is fine;
    // we only care that the error surfaces somewhere.
    expect((await screen.findAllByText(/couldn.?t load/i)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/no (invoices|charges)/i)).toBeNull();
  });
});

describe("InvoicesTab — row click opens the drawer", () => {
  it("drawer: clicking a row opens a drawer showing the charge number, Outstanding, and a Pay button — without navigating away", async () => {
    portalApiFetch.mockImplementation((path: string) => {
      if (path.startsWith("/charges/c-internal-001")) return Promise.resolve({ data: CHARGE_UNPAID });
      if (path.startsWith("/charges")) return Promise.resolve(chargesResponse([CHARGE_UNPAID]));
      if (path === "/documents/billing") return Promise.resolve({ data: { documents: [] } });
      return Promise.reject(new Error(`unexpected portalApiFetch path: ${path}`));
    });
    renderTab();

    const row = await screen.findByText("IVTEN-0007");
    fireEvent.click(row);

    // The drawer's own GET /charges/:id resolves and shows the charge number
    // again (inside the drawer this time) + an Outstanding line + Pay button.
    await waitFor(() => {
      expect(screen.getAllByText("IVTEN-0007").length).toBeGreaterThan(1);
    });
    expect(screen.getByText(/outstanding/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /pay/i })).toBeTruthy();

    // Still on the same page — no navigation occurred. The list row's own
    // "IVTEN-0007" text (asserted above via getAllByText's count > 1)
    // coexists with the drawer's copy, proving the list wasn't replaced.
    // (Base UI's Dialog correctly marks background content aria-hidden while
    // open, so `getByRole("table")` would — rightly — not find it here; that
    // reflects correct a11y behavior, not a navigation.)
  });

  it("B29 — the drawer shows its OWN freshly-fetched detail, not a copy of the (possibly stale) list row", async () => {
    // The list's /charges page says outstanding=100 (posted, "Unpaid"); the
    // drawer's own /charges/:id says the charge has since been paid in full
    // (outstanding=0). If the drawer ever rendered list-row data instead of
    // fetching its own, it would show the stale RM 100.00 — this proves it
    // reads its own query result.
    portalApiFetch.mockImplementation((path: string) => {
      if (path.startsWith("/charges/c-internal-001"))
        return Promise.resolve({
          data: { ...CHARGE_UNPAID, status: "posted", outstandingAmount: 0, amount: 1060 },
        });
      if (path.startsWith("/charges")) return Promise.resolve(chargesResponse([CHARGE_UNPAID]));
      if (path === "/documents/billing") return Promise.resolve({ data: { documents: [] } });
      return Promise.reject(new Error(`unexpected portalApiFetch path: ${path}`));
    });
    renderTab();

    const row = await screen.findByText("IVTEN-0007");
    // Confirm the LIST row shows the stale outstanding (100) before opening.
    expect(screen.getByText("RM 100.00")).toBeTruthy();

    fireEvent.click(row);

    // Once the drawer's own fetch resolves, its Outstanding line shows the
    // FRESH value (0), not the list row's stale 100.
    await waitFor(() => {
      expect(screen.getAllByText("RM 0.00").length).toBeGreaterThan(0);
    });
    expect(screen.queryByRole("button", { name: /pay/i })).toBeNull();
  });
});

// --- ChargeDrawer (direct render) --------------------------------------------
// Rendered standalone (not via a list-row click) for targeted coverage of the
// drawer's own boundary/error behavior.

function renderDrawer(onClose: () => void = () => {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ChargeDrawer chargeId="c-1" onClose={onClose} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function mockCharge(path: string, detail: unknown) {
  portalApiFetch.mockImplementation((p: string) => {
    if (p === `/charges/c-1`) return Promise.resolve({ data: detail });
    return Promise.reject(new Error(`unexpected portalApiFetch path in drawer test: ${p}`));
  });
}

describe("ChargeDrawer — canPay boundaries", () => {
  it("outstandingAmount === 0 hides the Pay button even though status is 'posted'", async () => {
    mockCharge("/charges/c-1", {
      id: "c-1", chargeNumber: "RENT-0726", documentNumber: "RENT-0726", chargeType: "rent", description: null,
      status: "posted", dueDate: "2026-07-01T00:00:00.000Z",
      amount: 1200, outstandingAmount: 0, currency: "MYR", createdAt: "2026-06-01T00:00:00.000Z",
    });
    renderDrawer();

    expect(await screen.findByText("Outstanding")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /pay/i })).toBeNull();
  });

  it("outstandingAmount > 0 but status 'credited' hides the Pay button (status not in the payable set)", async () => {
    mockCharge("/charges/c-1", {
      id: "c-1", chargeNumber: "CHG-0055", documentNumber: "CHG-0055", chargeType: "adjustment", description: null,
      status: "credited", dueDate: "2026-06-01T00:00:00.000Z",
      amount: 200, outstandingAmount: 50, currency: "MYR", createdAt: "2026-06-01T00:00:00.000Z",
    });
    renderDrawer();

    expect(await screen.findByText("CHG-0055")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /pay/i })).toBeNull();
  });

  it("negative outstandingAmount (overpayment) also hides the Pay button and still renders the signed balance", async () => {
    mockCharge("/charges/c-1", {
      id: "c-1", chargeNumber: "RENT-0900", documentNumber: "RENT-0900", chargeType: "rent", description: null,
      status: "posted", dueDate: "2026-06-01T00:00:00.000Z",
      amount: 1200, outstandingAmount: -50, currency: "MYR", createdAt: "2026-06-01T00:00:00.000Z",
    });
    renderDrawer();

    expect(await screen.findByText("RM -50.00")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /pay/i })).toBeNull();
  });
});

describe("ChargeDrawer — line items, totals, and safe optional fields", () => {
  it("renders a Line item row for EACH document (not just the first), Original total, Credit note total, and a clamped Amount paid", async () => {
    mockCharge("/charges/c-1", {
      id: "c-1", chargeNumber: "IVTEN-0007", documentNumber: "IVTEN-0007", chargeType: "utility", description: "July utilities",
      status: "partial", dueDate: "2026-07-01T00:00:00.000Z",
      amount: 1060, outstandingAmount: 800, currency: "MYR", createdAt: "2026-06-25T00:00:00.000Z",
      documents: [
        { id: "d-1", docType: "debit_note", documentNumber: "DEP-0001" },
        { id: "d-2", docType: "credit_note", documentNumber: "CN-0001" },
        { id: "d-3", docType: "credit_note", documentNumber: "CN-0002" },
      ],
      creditApplications: [
        { amount: 100, creditNoteNumber: "CN-0001" },
        { amount: 50, creditNoteNumber: "CN-0002" },
      ],
    });
    renderDrawer();

    expect(await screen.findByText("Outstanding")).toBeTruthy();

    // B18 — all three documents are reachable line items, not just the first.
    expect(screen.getByText("DEP-0001")).toBeTruthy();
    expect(screen.getByText("CN-0001")).toBeTruthy();
    expect(screen.getByText("CN-0002")).toBeTruthy();

    expect(screen.getByText("Original total")).toBeTruthy();
    expect(screen.getByText("RM 1,060.00")).toBeTruthy();
    // Credit note total = 100 + 50 = 150.
    expect(screen.getByText("-RM 150.00")).toBeTruthy();
    // Amount paid = amount(1060) - creditTotal(150) - outstanding(800) = 110.
    expect(screen.getByText("-RM 110.00")).toBeTruthy();
    expect(screen.getByText("RM 800.00")).toBeTruthy();
  });

  it("documents/creditApplications entirely omitted (undefined, not []) renders safely — no crash, no Line items/Credit note/Amount paid sections", async () => {
    mockCharge("/charges/c-1", {
      id: "c-1", chargeNumber: "RENT-0726", documentNumber: "RENT-0726", chargeType: "rent", description: null,
      status: "posted", dueDate: "2026-08-01T00:00:00.000Z",
      amount: 1200, outstandingAmount: 1200, currency: "MYR", createdAt: "2026-07-25T00:00:00.000Z",
      // documents / creditApplications keys omitted entirely.
    });
    renderDrawer();

    expect(await screen.findByText("Outstanding")).toBeTruthy();
    expect(screen.getByText("Original total")).toBeTruthy();
    expect(screen.queryByText("Credit note")).toBeNull();
    expect(screen.queryByText("Amount paid")).toBeNull();
  });

  it("B16 — inconsistent data that would derive a NEGATIVE 'Amount paid' (creditTotal exceeds amount-minus-outstanding) hides the row instead of showing a nonsensical negative", async () => {
    // amount(500) - creditTotal(700) - outstanding(50) = -250 (raw, negative)
    // — upstream data inconsistency (e.g. an overpaid/miscredited charge).
    // The clamp (Math.max(0, ...)) must hide the row entirely rather than
    // render "-RM -250.00" or any other nonsensical figure.
    mockCharge("/charges/c-1", {
      id: "c-1", chargeNumber: "CHG-0201", documentNumber: "CHG-0201", chargeType: "adjustment", description: null,
      status: "partial", dueDate: "2026-07-01T00:00:00.000Z",
      amount: 500, outstandingAmount: 50, currency: "MYR", createdAt: "2026-06-01T00:00:00.000Z",
      creditApplications: [{ amount: 700, creditNoteNumber: "CN-9001" }],
    });
    renderDrawer();

    expect(await screen.findByText("Outstanding")).toBeTruthy();
    expect(screen.getByText("RM 50.00")).toBeTruthy();
    // Credit note total (700) still renders honestly — only "Amount paid" is
    // suppressed, since that specific derived line is what would go negative.
    expect(screen.getByText("-RM 700.00")).toBeTruthy();
    expect(screen.queryByText("Amount paid")).toBeNull();
    expect(screen.queryByText(/NaN/)).toBeNull();
  });
});

describe("ChargeDrawer — fetch error", () => {
  it("a failed GET /charges/:id shows a graceful message instead of crashing or hanging on a spinner forever", async () => {
    portalApiFetch.mockImplementation((p: string) => {
      if (p === "/charges/c-1") return Promise.reject(new Error("Request failed (500)."));
      return Promise.reject(new Error(`unexpected portalApiFetch path in drawer test: ${p}`));
    });
    renderDrawer();

    expect((await screen.findAllByText(/couldn.?t load|not found/i)).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /pay/i })).toBeNull();
  });
});

describe("InvoicesTab — CN/DN-adjusted Total column (punch list B, 2026-08-06)", () => {
  it("Total shows the adjusted amount when the API provides it (payable basis, not the raw amount)", async () => {
    const adjusted = {
      ...CHARGE_UNPAID,
      amount: 400,
      debitNoteTotal: 50,
      creditNoteTotal: 100,
      adjustedAmount: 350,
      outstandingAmount: 120,
    };
    portalApiFetch.mockImplementation((path: string) => {
      if (path.startsWith("/charges")) return Promise.resolve(chargesResponse([adjusted]));
      return Promise.reject(new Error(`unexpected portalApiFetch path: ${path}`));
    });
    renderTab();

    expect(await screen.findByText("RM 350.00")).toBeTruthy();
    expect(screen.queryByText("RM 400.00")).toBeNull();
  });
});

describe("ChargeDrawer — CN/DN money breakdown (punch list B, 2026-08-06)", () => {
  // 400 original + 50 DN − 100 CN = 350 adjusted; outstanding 230 ⇒ RM 120
  // actually paid. Before this fix the drawer plugged "Amount paid" from the
  // RAW amount, so a credit note rendered as a payment the tenant never made.
  const CHARGE_ADJUSTED = {
    id: "c-1", chargeNumber: "IVTEN-0031", documentNumber: "IVTEN-0031", chargeType: "utility", description: "July utilities",
    status: "partial", dueDate: "2026-07-01T00:00:00.000Z",
    amount: 400, debitNoteTotal: 50, creditNoteTotal: 100, adjustedAmount: 350,
    outstandingAmount: 230, currency: "MYR", createdAt: "2026-06-25T00:00:00.000Z",
    documents: [], creditApplications: [],
  };

  it("renders Debit notes +, Credit notes −, Adjusted total, and the TRUE Amount paid", async () => {
    portalApiFetch.mockImplementation((p: string) => {
      if (p === "/charges/c-1") return Promise.resolve({ data: CHARGE_ADJUSTED });
      return Promise.reject(new Error(`unexpected portalApiFetch path in drawer test: ${p}`));
    });
    renderDrawer();

    expect(await screen.findByText("Debit notes")).toBeTruthy();
    expect(screen.getByText("+RM 50.00")).toBeTruthy();
    expect(screen.getByText("Credit notes")).toBeTruthy();
    expect(screen.getByText("-RM 100.00")).toBeTruthy();
    expect(screen.getByText("Adjusted total")).toBeTruthy();
    expect(screen.getByText("RM 350.00")).toBeTruthy();
    // Amount paid = 350 adjusted − 230 outstanding = RM 120 (real money only).
    expect(screen.getByText("Amount paid")).toBeTruthy();
    expect(screen.getByText("-RM 120.00")).toBeTruthy();
  });

  it("a fully-unpaid credit-noted charge shows NO 'Amount paid' row (the CN is not a payment)", async () => {
    portalApiFetch.mockImplementation((p: string) => {
      if (p === "/charges/c-1") {
        return Promise.resolve({
          data: { ...CHARGE_ADJUSTED, debitNoteTotal: 0, adjustedAmount: 300, outstandingAmount: 300 },
        });
      }
      return Promise.reject(new Error(`unexpected portalApiFetch path in drawer test: ${p}`));
    });
    renderDrawer();

    expect(await screen.findByText("Credit notes")).toBeTruthy();
    expect(screen.queryByText("Amount paid")).toBeNull();
  });
});

describe("ChargeDrawer — PDF download actions", () => {
  const CHARGE_WITH_DOCS = {
    id: "c-1", chargeNumber: "IVTEN-0007", documentNumber: "IVTEN-0007", chargeType: "utility", description: "July utilities",
    status: "partial", dueDate: "2026-07-01T00:00:00.000Z",
    amount: 1060, outstandingAmount: 100, currency: "MYR", createdAt: "2026-06-25T00:00:00.000Z",
    documents: [
      { id: "d-1", docType: "debit_note", documentNumber: "DEP-0001" },
      { id: "d-2", docType: "credit_note", documentNumber: "CN-0001" },
    ],
    creditApplications: [{ amount: 900, creditNoteNumber: "CN-0001" }],
  };

  it("'Download invoice' / 'View credit note' fetch the signed url and open it in a new tab", async () => {
    portalApiFetch.mockImplementation((p: string) => {
      if (p === "/charges/c-1") return Promise.resolve({ data: CHARGE_WITH_DOCS });
      if (p === "/documents/billing/d-1/pdf") return Promise.resolve({ data: { downloadUrl: "https://signed/dep-0001.pdf" } });
      if (p === "/documents/billing/d-2/pdf") return Promise.resolve({ data: { downloadUrl: "https://signed/cn-0001.pdf" } });
      return Promise.reject(new Error(`unexpected portalApiFetch path in drawer test: ${p}`));
    });
    renderDrawer();

    fireEvent.click(await screen.findByRole("button", { name: /download invoice/i }));
    // Opened inside the gesture, before the URL exists...
    expect(openSpy).toHaveBeenCalledWith("about:blank", "_blank");
    // ...then steered to the signed URL when it lands.
    await waitFor(() => expect(openedTab.location.href).toBe("https://signed/dep-0001.pdf"));
    expect(openedTab.opener).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /view credit note/i }));
    await waitFor(() => expect(openedTab.location.href).toBe("https://signed/cn-0001.pdf"));
  });

  it("B23 — a failed PDF fetch shows a graceful error instead of a silent no-op or an unhandled rejection", async () => {
    portalApiFetch.mockImplementation((p: string) => {
      if (p === "/charges/c-1") return Promise.resolve({ data: CHARGE_WITH_DOCS });
      if (p === "/documents/billing/d-1/pdf") return Promise.reject(new Error("That item was not found."));
      return Promise.reject(new Error(`unexpected portalApiFetch path in drawer test: ${p}`));
    });
    renderDrawer();

    fireEvent.click(await screen.findByRole("button", { name: /download invoice/i }));

    expect((await screen.findAllByText(/couldn.?t open|not found/i)).length).toBeGreaterThan(0);
    // The pre-opened tab must not be left stranded on about:blank.
    expect(openedTab.close).toHaveBeenCalled();
    expect(openedTab.location.href).toBe("");
  });
});

describe("InvoicesTab — relocated Billing documents subsection (spec R13)", () => {
  const BILLING_DOCS = {
    data: {
      documents: [
        { id: "b-1", docType: "invoice", documentNumber: "IVTEN-0055", status: "issued", issuedAt: "2026-07-01T00:00:00.000Z", billingMonth: "2026-07-01", total: "1060.00", reason: null, originalDocumentNumber: null },
        { id: "b-2", docType: "receipt", documentNumber: "RCPT-0002", status: "settled", issuedAt: "2026-07-05T00:00:00.000Z", billingMonth: null, total: "1200.00", reason: null, originalDocumentNumber: null },
      ],
    },
  };

  it("flag ON + documents present: renders a 'Billing documents' subsection with documentNumber + DOC_TYPE_LABEL", async () => {
    mockIsPhase2FlagEnabled.mockReturnValue(true);
    portalApiFetch.mockImplementation((path: string) => {
      if (path.startsWith("/charges")) return Promise.resolve(chargesResponse([CHARGE_UNPAID]));
      if (path === "/documents/billing") return Promise.resolve(BILLING_DOCS);
      return Promise.reject(new Error(`unexpected portalApiFetch path: ${path}`));
    });
    renderTab();

    expect(await screen.findByText(/billing documents/i)).toBeTruthy();
    expect(screen.getByText("IVTEN-0055")).toBeTruthy();
    expect(screen.getByText("Invoice")).toBeTruthy();
    expect(screen.getByText("RCPT-0002")).toBeTruthy();
    expect(screen.getByText("Receipt")).toBeTruthy();
  });

  it("PDF: opens the tab in the gesture, then steers it to the signed URL", async () => {
    mockIsPhase2FlagEnabled.mockReturnValue(true);
    portalApiFetch.mockImplementation((path: string) => {
      if (path.startsWith("/charges")) return Promise.resolve(chargesResponse([CHARGE_UNPAID]));
      if (path === "/documents/billing") return Promise.resolve(BILLING_DOCS);
      if (path === "/documents/billing/b-1/pdf") return Promise.resolve({ data: { downloadUrl: "https://signed/ivten-0055.pdf" } });
      return Promise.reject(new Error(`unexpected portalApiFetch path: ${path}`));
    });
    renderTab();

    fireEvent.click((await screen.findAllByRole("button", { name: /^pdf$/i }))[0]);
    expect(openSpy).toHaveBeenCalledWith("about:blank", "_blank");
    await waitFor(() => expect(openedTab.location.href).toBe("https://signed/ivten-0055.pdf"));
  });

  it("PDF: a failed fetch closes the blank tab AND says so — never a silent dead button", async () => {
    mockIsPhase2FlagEnabled.mockReturnValue(true);
    portalApiFetch.mockImplementation((path: string) => {
      if (path.startsWith("/charges")) return Promise.resolve(chargesResponse([CHARGE_UNPAID]));
      if (path === "/documents/billing") return Promise.resolve(BILLING_DOCS);
      if (path === "/documents/billing/b-1/pdf") return Promise.reject(new Error("That item was not found."));
      return Promise.reject(new Error(`unexpected portalApiFetch path: ${path}`));
    });
    renderTab();

    fireEvent.click((await screen.findAllByRole("button", { name: /^pdf$/i }))[0]);

    expect(await screen.findByText(/that item was not found/i)).toBeTruthy();
    expect(openedTab.close).toHaveBeenCalled();
    expect(openedTab.location.href).toBe("");
  });

  // A credit note's `total` only says a credit was ISSUED — past tense, reads as
  // history. Before this the tenant had no way to tell that money was still
  // sitting on their account: they saw the document and nothing else. The badge
  // is the difference between "you were credited RM50 once" and "you hold RM50".
  it("a credit note with an unspent balance shows how much is still AVAILABLE, not just its face value", async () => {
    mockIsPhase2FlagEnabled.mockReturnValue(true);
    portalApiFetch.mockImplementation((path: string) => {
      if (path.startsWith("/charges")) return Promise.resolve(chargesResponse([CHARGE_UNPAID]));
      if (path === "/documents/billing") {
        return Promise.resolve({
          data: {
            documents: [
              // Issued for 50, 30 already spent against later bills ⇒ 20 left.
              { id: "cn-1", docType: "credit_note", documentNumber: "CN-0001", status: "issued", issuedAt: "2026-07-01T00:00:00.000Z", billingMonth: null, total: "50.00", reason: "overbilled", originalDocumentNumber: "IVTEN-0004", creditRemaining: "20.00" },
            ],
          },
        });
      }
      return Promise.reject(new Error(`unexpected portalApiFetch path: ${path}`));
    });
    renderTab();

    const badge = await screen.findByTestId("credit-remaining");
    expect(badge.textContent).toMatch(/20\.00/);
    // The face value is still shown — the badge supplements it, never replaces it.
    expect(screen.getByText(/50\.00/)).toBeTruthy();
  });

  it("a FULLY SPENT credit note shows no available-balance badge", async () => {
    mockIsPhase2FlagEnabled.mockReturnValue(true);
    portalApiFetch.mockImplementation((path: string) => {
      if (path.startsWith("/charges")) return Promise.resolve(chargesResponse([CHARGE_UNPAID]));
      if (path === "/documents/billing") {
        return Promise.resolve({
          data: {
            documents: [
              { id: "cn-1", docType: "credit_note", documentNumber: "CN-0001", status: "settled", issuedAt: "2026-07-01T00:00:00.000Z", billingMonth: null, total: "50.00", reason: null, originalDocumentNumber: null, creditRemaining: null },
            ],
          },
        });
      }
      return Promise.reject(new Error(`unexpected portalApiFetch path: ${path}`));
    });
    renderTab();

    expect(await screen.findByText("CN-0001")).toBeTruthy();
    expect(screen.queryByTestId("credit-remaining")).toBeNull();
  });

  it("flag OFF: the subsection renders nothing, even though documents would otherwise be present", async () => {
    mockIsPhase2FlagEnabled.mockReturnValue(false);
    portalApiFetch.mockImplementation((path: string) => {
      if (path.startsWith("/charges")) return Promise.resolve(chargesResponse([CHARGE_UNPAID]));
      if (path === "/documents/billing") return Promise.resolve(BILLING_DOCS);
      return Promise.reject(new Error(`unexpected portalApiFetch path: ${path}`));
    });
    renderTab();

    expect(await screen.findByText("IVTEN-0007")).toBeTruthy(); // the charge row itself
    expect(screen.queryByText(/billing documents/i)).toBeNull();
    expect(screen.queryByText("RCPT-0002")).toBeNull();
    expect(screen.queryByText("IVTEN-0055")).toBeNull();
  });

  it("flag ON + zero documents: the subsection renders nothing (silent, same as the old behavior)", async () => {
    mockIsPhase2FlagEnabled.mockReturnValue(true);
    portalApiFetch.mockImplementation((path: string) => {
      if (path.startsWith("/charges")) return Promise.resolve(chargesResponse([CHARGE_UNPAID]));
      if (path === "/documents/billing") return Promise.resolve({ data: { documents: [] } });
      return Promise.reject(new Error(`unexpected portalApiFetch path: ${path}`));
    });
    renderTab();

    expect(await screen.findByText("IVTEN-0007")).toBeTruthy();
    expect(screen.queryByText(/billing documents/i)).toBeNull();
  });

  it("B24 — a malformed/garbage 'total' string never renders 'RM NaN'", async () => {
    mockIsPhase2FlagEnabled.mockReturnValue(true);
    portalApiFetch.mockImplementation((path: string) => {
      if (path.startsWith("/charges")) return Promise.resolve(chargesResponse([CHARGE_UNPAID]));
      if (path === "/documents/billing")
        return Promise.resolve({
          data: {
            documents: [
              { id: "b-3", docType: "invoice", documentNumber: "IVTEN-0099", status: "issued", issuedAt: "2026-07-01T00:00:00.000Z", billingMonth: null, total: "not-a-number", reason: null, originalDocumentNumber: null },
            ],
          },
        });
      return Promise.reject(new Error(`unexpected portalApiFetch path: ${path}`));
    });
    renderTab();

    expect(await screen.findByText("IVTEN-0099")).toBeTruthy();
    expect(screen.queryByText(/NaN/)).toBeNull();
  });
});
