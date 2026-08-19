import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";

// Task 7 (tenant-portal-redesign) — Billing "Payments" tab + payment detail
// drawer + FPX return banner (spec R17 ops-polish carryover). Mirrors
// __tests__/payments.test.tsx (FPX banner) and __tests__/billing-invoices.test.tsx
// (list/drawer structure): mock @/lib/portal-api, native matchers only (no
// jest-dom), QueryClientProvider (retry:false) + MemoryRouter.

const portalApiFetch = vi.fn();
vi.mock("@/lib/portal-api", () => ({
  portalApiFetch: (...args: unknown[]) => portalApiFetch(...args),
  portalApiUrl: (path: string) => `/portal-api${path}`,
  PortalApiError: class PortalApiError extends Error {},
}));

import { PaymentsTab } from "../billing/payments-tab";
import PortalBillingPage from "../billing";

// --- Fixtures ----------------------------------------------------------------
// `id` deliberately shaped like a raw internal id, distinct from `paymentNumber`
// (mirrors billing-invoices.test.tsx's CHARGE_UNPAID convention) so a
// regression rendering `payment.id` instead of `payment.paymentNumber` is
// caught.

// status "completed" is DELIBERATELY not in getStatusTone's known buckets
// (see apps/web/src/components/format.ts) — it falls through to "slate",
// which Badge has no variant for. Exercises the badgeTone fallback (B4).
const PAYMENT_BANK_TRANSFER = {
  id: "p-internal-001",
  paymentNumber: "PAY-0013",
  paymentMethod: "bank_transfer",
  status: "completed",
  amount: 1200,
  currency: "MYR",
  receivedAt: "2026-07-20T00:00:00.000Z",
  referenceNote: "July rent",
};

// A real status value used elsewhere in this exact module
// (portal.payments.repository.ts) — known amber bucket in getStatusTone.
const PAYMENT_FPX = {
  id: "p-internal-002",
  paymentNumber: "PAY-0014",
  paymentMethod: "fpx",
  status: "pending_approval",
  amount: 500,
  currency: "MYR",
  receivedAt: "2026-07-05T00:00:00.000Z",
  referenceNote: null,
};

// paymentMethod deliberately NOT in the explicit humanize map, to prove the
// generic underscore->title-case fallback (not just the three named methods).
const PAYMENT_UNMAPPED_METHOD = {
  id: "p-internal-003",
  paymentNumber: "PAY-0015",
  paymentMethod: "online_wallet",
  status: "posted",
  amount: 250,
  currency: "MYR",
  receivedAt: "2026-06-15T00:00:00.000Z",
  referenceNote: null,
};

function paymentsResponse(data: unknown[]) {
  return { data, pagination: { page: 1, limit: 20, total: data.length, totalPages: 1 } };
}

function renderTab() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/portal/billing?tab=payments"]}>
        <PaymentsTab />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  portalApiFetch.mockReset();
  portalApiFetch.mockImplementation((path: string) => {
    if (path.startsWith("/payments"))
      return Promise.resolve(
        paymentsResponse([PAYMENT_BANK_TRANSFER, PAYMENT_FPX, PAYMENT_UNMAPPED_METHOD]),
      );
    return Promise.reject(new Error(`unexpected portalApiFetch path: ${path}`));
  });
});

afterEach(() => {
  openSpy.mockReset();
});

describe("PaymentsTab — list", () => {
  it("list: renders rows with paymentNumber (not raw id), humanized method (mapped + fallback), formatRM amount, formatDateMY date, and a status badge", async () => {
    renderTab();

    expect(await screen.findByText("PAY-0013")).toBeTruthy();
    expect(screen.getByText("PAY-0014")).toBeTruthy();
    expect(screen.getByText("PAY-0015")).toBeTruthy();

    // Raw internal ids must never appear as visible text.
    expect(screen.queryByText("p-internal-001")).toBeNull();
    expect(screen.queryByText("p-internal-002")).toBeNull();

    // METHOD humanized — two explicitly-mapped methods, plus the generic
    // underscore -> Title Case fallback for an unmapped one.
    expect(screen.getByText("Bank transfer")).toBeTruthy();
    expect(screen.getByText("FPX")).toBeTruthy();
    expect(screen.getByText("Online Wallet")).toBeTruthy();

    // DATE via formatDateMY.
    expect(screen.getByText("20 Jul 2026")).toBeTruthy();
    expect(screen.getByText("5 Jul 2026")).toBeTruthy();
    expect(screen.getByText("15 Jun 2026")).toBeTruthy();

    // AMOUNT via formatRM.
    expect(screen.getByText("RM 1,200.00")).toBeTruthy();
    expect(screen.getByText("RM 500.00")).toBeTruthy();
    expect(screen.getByText("RM 250.00")).toBeTruthy();

    // STATUS badges — humanized, NOT the raw DB token. A tenant reading
    // "pending_approval" learns nothing about what is happening to their money.
    //
    // And the label depends on the METHOD, because the same status means two
    // different things: a bank transfer waits on a PERSON here to check the
    // slip, a bank redirect waits on the BANK. PAY-0014 is FPX, so it must read
    // as waiting on the bank — telling that tenant we are "verifying" a slip
    // they never uploaded is the wrong promise about who is doing what.
    const table = screen.getByRole("table");
    expect(within(table).getByText("completed")).toBeTruthy();
    expect(within(table).getByText("Waiting for your bank")).toBeTruthy();
    expect(within(table).queryByText("Being verified")).toBeNull();
    expect(within(table).getByText("Confirmed")).toBeTruthy();
    expect(within(table).queryByText("pending_approval")).toBeNull();

    // Badge tone correctness, asserted on the real rendered attribute (not
    // just text presence) — Badge has no "slate" variant, so an unmapped
    // status ("completed", outside getStatusTone's known buckets) MUST
    // resolve to a real Badge variant ("secondary"), never the literal
    // "slate" DOM attribute cva would silently no-op on. Tone still derives
    // from the RAW status, so humanizing the label cannot shift the colour.
    expect(within(table).getByText("completed").getAttribute("data-variant")).toBe("secondary");
    expect(within(table).getByText("Waiting for your bank").getAttribute("data-variant")).toBe("amber");
    expect(within(table).getByText("Confirmed").getAttribute("data-variant")).toBe("emerald");
  });
});

describe("PaymentsTab — empty and error states", () => {
  it("empty: zero payments from the API renders an EmptyState, not a crash", async () => {
    portalApiFetch.mockImplementation((path: string) => {
      if (path.startsWith("/payments")) return Promise.resolve(paymentsResponse([]));
      return Promise.reject(new Error(`unexpected portalApiFetch path: ${path}`));
    });
    renderTab();

    expect(await screen.findByText(/no payments/i)).toBeTruthy();
  });

  it("error: a failed /payments fetch shows an error message, NOT the zero-payments EmptyState (a 500 must never look like 'no payments')", async () => {
    portalApiFetch.mockImplementation((path: string) => {
      if (path.startsWith("/payments")) return Promise.reject(new Error("Server error. Try again in a moment."));
      return Promise.reject(new Error(`unexpected portalApiFetch path: ${path}`));
    });
    renderTab();

    expect((await screen.findAllByText(/couldn.?t load/i)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/no payments/i)).toBeNull();
  });
});

// window.open spy — "Download receipt" opens a new tab, mirroring the
// existing ChargeDrawer / BillingDocumentsSection "fetch then window.open"
// idiom (owner-statement.test.tsx convention).
const openSpy = vi.fn();
vi.stubGlobal("open", openSpy);

describe("PaymentsTab — row click opens the drawer", () => {
  it("drawer: clicking a row opens a Sheet showing the payment number, date, method, and amount — without navigating away", async () => {
    renderTab();

    const row = await screen.findByText("PAY-0013");
    fireEvent.click(row);

    // The drawer shows its own copy of the payment number (so getAllByText
    // now finds 2: the list row + the drawer), plus date/method/amount.
    await waitFor(() => {
      expect(screen.getAllByText("PAY-0013").length).toBeGreaterThan(1);
    });
    expect(screen.getAllByText("20 Jul 2026").length).toBeGreaterThan(1);
    expect(screen.getAllByText("Bank transfer").length).toBeGreaterThan(1);
    expect(screen.getAllByText("RM 1,200.00").length).toBeGreaterThan(1);

    // Still on the same page — list row coexists with the drawer's copy
    // (proves no navigation occurred).
  });

  it("drawer: 'Applied to' shows the referenceNote when present", async () => {
    renderTab();

    fireEvent.click(await screen.findByText("PAY-0013"));

    await waitFor(() => expect(screen.getByText(/applied to/i)).toBeTruthy());
    expect(screen.getByText("July rent")).toBeTruthy();
  });

  it("drawer: 'Applied to' row is absent when referenceNote is null", async () => {
    renderTab();

    fireEvent.click(await screen.findByText("PAY-0014"));

    // Wait for the drawer to actually open (its own copy of the payment
    // number renders twice) before asserting the absence of "Applied to".
    await waitFor(() => {
      expect(screen.getAllByText("PAY-0014").length).toBeGreaterThan(1);
    });
    expect(screen.queryByText(/applied to/i)).toBeNull();
  });

  it("drawer: shows the Receipt number and a 'Download receipt' button; clicking it opens a new tab (no crash, no navigation)", async () => {
    renderTab();

    // PAY-0015 is the "posted" fixture — only settled money gets a receipt.
    fireEvent.click(await screen.findByText("PAY-0015"));
    // Exact match ("Receipt") so this doesn't also match the "Download
    // receipt" button's own text (a substring/regex match would hit both).
    await waitFor(() => expect(screen.getByText("Receipt")).toBeTruthy());

    const downloadBtn = screen.getByRole("button", { name: /download receipt/i });
    fireEvent.click(downloadBtn);

    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy.mock.calls[0][1]).toBe("_blank");
  });

  // A receipt asserts money was received. Handing one out for a payment still
  // under review would let a tenant produce proof of a payment the org has not
  // accepted — and for a refused one, proof of a payment it rejected outright.
  it("drawer: a payment awaiting verification offers NO receipt download", async () => {
    renderTab();

    fireEvent.click(await screen.findByText("PAY-0014"));
    await waitFor(() => expect(screen.getAllByText("PAY-0014").length).toBeGreaterThan(1));

    expect(screen.queryByRole("button", { name: /download receipt/i })).toBeNull();
    expect(screen.getByText(/receipt becomes available once this payment is confirmed/i)).toBeTruthy();
  });

  it("drawer: a bank-redirect payment says the BANK is still working, not that we're checking a slip", async () => {
    renderTab();

    // PAY-0014 is FPX. The old copy told every unverified payer we were
    // "checking your transfer slip against our bank account" — for a bank
    // redirect there is no slip and nobody here is checking anything, so it
    // promised a review that was never going to happen.
    fireEvent.click(await screen.findByText("PAY-0014"));
    await waitFor(() => expect(screen.getAllByText("PAY-0014").length).toBeGreaterThan(1));

    // Appears twice by design — the row badge and the drawer heading agree.
    expect(screen.getAllByText(/waiting for your bank/i).length).toBeGreaterThan(1);
    // Says the wait is NORMAL — on FPX a company account needs a second person
    // to approve, so a tenant told only "unconfirmed" reasonably pays again.
    expect(screen.getByText(/second person to approve/i)).toBeTruthy();
    expect(screen.getByText(/please don't pay them again/i)).toBeTruthy();
    expect(screen.queryByText(/transfer slip against our bank account/i)).toBeNull();
  });

  it("drawer: a bank-transfer payment still says we're checking the slip", async () => {
    // The other half of the same branch — a manual transfer genuinely IS waiting
    // on a person here, so that copy must survive.
    portalApiFetch.mockImplementation((path: string) => {
      if (path.startsWith("/payments")) {
        return Promise.resolve(
          paymentsResponse([
            { ...PAYMENT_FPX, id: "p-slip", paymentNumber: "PAY-9001", paymentMethod: "bank_transfer" },
          ]),
        );
      }
      return Promise.reject(new Error(`unexpected portalApiFetch path: ${path}`));
    });
    renderTab();

    fireEvent.click(await screen.findByText("PAY-9001"));
    await waitFor(() => expect(screen.getAllByText("PAY-9001").length).toBeGreaterThan(1));

    expect(screen.getByText(/we're verifying this/i)).toBeTruthy();
    expect(screen.getByText(/transfer slip against our bank account/i)).toBeTruthy();
  });
});

// --- FPX return banner, rendered through the FULL Billing shell -------------
// The gateway/mock returns the payer to /portal/billing?tab=payments&fpx=...
// (PaymentsToBillingRedirect in router.tsx forwards the legacy
// /portal/payments?fpx=... URL there, query-preserving). These tests render
// the real PortalBillingPage (not just PaymentsTab in isolation) so they also
// prove the mount wiring in billing/index.tsx, not just PaymentsTab alone.

const SUCCESS_TEXT = "Your payment was received.";
const FAILED_TEXT = "Your payment didn't complete — please try again.";

const BASE_DASHBOARD = {
  data: {
    tenant: { displayName: "Jane Tan", partyType: "tenant" },
    lease: {
      tenancyCode: "TC-0001",
      unitCode: "A-12-03",
      propertyName: "Kaen Residences",
      startDate: "2026-01-01",
      endDate: null,
      monthlyRentAmount: 1200,
      status: "active",
    },
    upcomingCharges: [],
    recentPayments: [],
    announcements: [],
    balance: { totalCharges: 0, totalPayments: 0, totalCredits: 0, netBalance: 0, currency: "MYR" },
  },
};

const EMPTY_CHARGES = { data: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 1 } };

function mockShellApi() {
  portalApiFetch.mockImplementation((path: string) => {
    if (path.startsWith("/dashboard")) return Promise.resolve(BASE_DASHBOARD);
    if (path.startsWith("/charges")) return Promise.resolve(EMPTY_CHARGES);
    if (path.startsWith("/payments")) return Promise.resolve(paymentsResponse([PAYMENT_BANK_TRANSFER]));
    return Promise.reject(new Error(`unexpected portalApiFetch path: ${path}`));
  });
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location-search">{location.search}</div>;
}

function renderShellAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <PortalBillingPage />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("PortalBillingPage — Payments tab mount + FPX return banner", () => {
  beforeEach(() => {
    portalApiFetch.mockReset();
    mockShellApi();
  });

  it("mount: tab=payments renders the real Payments table (T7), not the old 'Coming in T7' placeholder", async () => {
    renderShellAt("/portal/billing?tab=payments");

    expect(await screen.findByText("PAY-0013")).toBeTruthy();
    expect(screen.queryByText(/coming in t7/i)).toBeNull();
  });

  it("fpx banner: ?fpx=success at tab=payments → shows the success banner", async () => {
    renderShellAt("/portal/billing?tab=payments&fpx=success");

    expect(await screen.findByText(SUCCESS_TEXT)).toBeTruthy();
    expect(screen.queryByText(FAILED_TEXT)).toBeNull();
  });

  it("fpx banner: ?fpx=failed at tab=payments → shows the failure banner", async () => {
    renderShellAt("/portal/billing?tab=payments&fpx=failed");

    expect(await screen.findByText(FAILED_TEXT)).toBeTruthy();
    expect(screen.queryByText(SUCCESS_TEXT)).toBeNull();
  });

  it("fpx banner: no ?fpx param → shows no banner", async () => {
    renderShellAt("/portal/billing?tab=payments");

    expect(await screen.findByText("PAY-0013")).toBeTruthy();
    expect(screen.queryByText(SUCCESS_TEXT)).toBeNull();
    expect(screen.queryByText(FAILED_TEXT)).toBeNull();
  });

  it("fpx banner: dismiss button hides the banner", async () => {
    renderShellAt("/portal/billing?tab=payments&fpx=success");

    expect(await screen.findByText(SUCCESS_TEXT)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /dismiss notification/i }));
    await waitFor(() => expect(screen.queryByText(SUCCESS_TEXT)).toBeNull());
  });

  it("fpx banner: read-once-then-strip removes ONLY ?fpx from the URL, preserving ?tab=payments", async () => {
    renderShellAt("/portal/billing?tab=payments&fpx=success");

    expect(await screen.findByText(SUCCESS_TEXT)).toBeTruthy();
    await waitFor(() => {
      const search = screen.getByTestId("location-search").textContent;
      expect(search).toBe("?tab=payments");
    });
  });
});
