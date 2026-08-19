import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

// pay.tsx redesign (2026-07-20 tenant-portal-redesign, Task 8): two-mode payment
// flow — "Pay all outstanding" (default, auto-selects overdue+due-now, NEVER
// upcoming) vs "Select charges" (checkboxes, grouped Overdue -> Due now ->
// Upcoming). Continue -> review step (paying list, subtotal, TOTAL, method
// radios FPX/Bank transfer) -> submit -> result step (payment number,
// applied-to, Return to Billing). FULL-OUTSTANDING LOCK preserved: every
// selected charge always pays allocatedAmount = outstandingAmount.toFixed(2);
// there is no editable amount field anywhere in this UI.
//
// This file REPLACES the pre-redesign single-mode suite (commits 4fc918c9,
// 93e9f161, 4b6b2d38, b77e4dcf), which asserted a `<select>` method dropdown
// (fpx/cash/bank_transfer) and an immediate "Pay" button with no review step
// — both intentionally removed by this rewrite. Every risk the old suite
// covered (full-outstanding lock, FPX redirect, multi-charge basket summing)
// is carried forward here under the new two-step interaction model; "cash" is
// dropped as a method per the brief's explicit two-radio (FPX/Bank transfer)
// requirement.

const portalApiFetch = vi.fn();
vi.mock("@/lib/portal-api", () => ({
  portalApiFetch: (...args: unknown[]) => portalApiFetch(...args),
  PortalApiError: class PortalApiError extends Error {
    status: number;
    body: unknown;
    constructor(message: string, status: number, body?: unknown) {
      super(message);
      this.status = status;
      this.body = body;
    }
  },
}));

const navigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, useNavigate: () => navigate };
});

import PortalPayPage from "../pay";

// --- Fixture dates -----------------------------------------------------
// Anchored to the REAL current date at test-run time (Asia/Kuala_Lumpur), at
// 04:00 UTC (= noon MY) so each fixture sits safely mid-day, far from any
// midnight/timezone boundary. The dedicated timezone-boundary test below uses
// its own hand-picked near-midnight instants instead of this helper.
const MY_TZ = "Asia/Kuala_Lumpur";
const MY_DATE_ONLY = new Intl.DateTimeFormat("en-CA", { timeZone: MY_TZ });

function isoAtMyOffsetDays(offsetDays: number): string {
  const todayMY = MY_DATE_ONLY.format(new Date()); // "YYYY-MM-DD"
  const [y, m, d] = todayMY.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 4, 0, 0));
  dt.setUTCDate(dt.getUTCDate() + offsetDays);
  return dt.toISOString();
}

type PayableCharge = {
  id: string;
  chargeNumber: string;
  chargeType: string;
  description: string | null;
  dueDate: string;
  amount: number;
  outstandingAmount: number;
  currency: string;
  invoiceId: string | null;
  invoiceNumber: string | null;
  /** The bill number the server resolves for this charge (IVTEN-0002), or null when
   * it is on no bill yet. Mirrors the page's own optional field. */
  documentNumber?: string | null;
};

// Amounts chosen deliberately: 1200.50 + 99.55 = 1300.05 — exercises
// thousands-separator formatting AND exact-cents summation (B32/B33).
// OVERDUE has invoiceNumber: null to exercise the chargeNumber fallback (B34).
const OVERDUE: PayableCharge = {
  id: "c-overdue",
  chargeNumber: "CHG-0023",
  chargeType: "rent",
  description: "April rent",
  dueDate: isoAtMyOffsetDays(-30),
  amount: 1200.5,
  outstandingAmount: 1200.5,
  currency: "MYR",
  invoiceId: null,
  invoiceNumber: null,
};

const DUE: PayableCharge = {
  id: "c-due",
  chargeNumber: "IVTEN-0007",
  chargeType: "utility",
  description: "July cleaning",
  dueDate: isoAtMyOffsetDays(0),
  amount: 99.55,
  outstandingAmount: 99.55,
  currency: "MYR",
  invoiceId: "inv-1",
  invoiceNumber: "IVTEN-0007",
};

const UPCOMING: PayableCharge = {
  id: "c-upcoming",
  chargeNumber: "RENT-0826",
  chargeType: "rent",
  description: "August rent",
  dueDate: isoAtMyOffsetDays(30),
  amount: 1200,
  outstandingAmount: 1200,
  currency: "MYR",
  invoiceId: null,
  invoiceNumber: null,
};

const assignMock = vi.fn();

// ── transfer-slip helpers ──────────────────────────────────────────────────
// A manual (non-FPX) payment now REQUIRES proof of transfer: the page asks the
// API for a signed upload URL, PUTs the file straight to storage, then submits
// the returned key. Every manual-path test therefore has to attach a slip, or
// the submit button stays disabled by design.

const SLIP_KEY = "orgs/org-1/payment-slips/party-1/aaaa-slip.jpg";

/** The route's response shape (server mints the key; browser PUTs the bytes). */
function slipTicket() {
  return {
    data: {
      storageKey: SLIP_KEY,
      uploadUrl: "https://storage.example/upload/aaaa",
      method: "PUT",
      headers: { "content-type": "image/jpeg" },
    },
  };
}

/** Attach a slip to the review step's file input. */
function attachSlip(name = "slip.jpg") {
  const input = screen.getByLabelText(/transfer slip/i) as HTMLInputElement;
  const file = new File(["slip-bytes"], name, { type: "image/jpeg" });
  fireEvent.change(input, { target: { files: [file] } });
  return file;
}

/** The manual-path submit button. Labelled "Submit RM… for verification" —
 * deliberately NOT "Pay", because nothing is settled until an admin agrees. */
function submitButton() {
  return screen.getByRole("button", { name: /^Submit RM/i }) as HTMLButtonElement;
}

/** Tick the point-of-purchase consent box on the review step. Neither submit
 * button is enabled until this happens, so every test that pays goes through
 * it — that is the point of the gate, not incidental setup. */
function agreeToTerms() {
  fireEvent.click(screen.getByRole("checkbox", { name: /I agree to the Terms/i }));
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/portal/pay"]}>
        <PortalPayPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function mockCharges(data: PayableCharge[]) {
  portalApiFetch.mockImplementation((path: string) => {
    if (path.startsWith("/payments/payable-charges")) {
      return Promise.resolve({
        data,
        pagination: { page: 1, limit: 50, total: data.length, totalPages: 1 },
      });
    }
    return Promise.reject(new Error(`unhandled portalApiFetch call in test: ${path}`));
  });
}

beforeEach(() => {
  portalApiFetch.mockReset();
  navigate.mockReset();
  assignMock.mockReset();
  vi.stubGlobal("crypto", { randomUUID: () => "11111111-1111-4111-8111-111111111111" });

  // The slip upload PUTs straight to storage via global fetch (NOT
  // portalApiFetch, which only mints the signed URL). Default to success; a
  // test that cares about upload failure overrides this.
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

  // window.location.assign leaves the SPA on FPX success — stub it so the
  // test can assert the redirect target without jsdom attempting real nav.
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: {
      assign: assignMock,
      href: "http://localhost/portal/pay",
      origin: "http://localhost",
      search: "",
    },
  });

  mockCharges([OVERDUE, DUE, UPCOMING]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("PortalPayPage — pay all default", () => {
  it("selects Pay all outstanding by default, includes overdue+due, excludes upcoming, and sums correctly", async () => {
    renderPage();

    // Mode radio: "Pay all outstanding" is selected by default.
    const allRadio = (await screen.findByRole("radio", {
      name: /Pay all outstanding/i,
    })) as HTMLInputElement;
    expect(allRadio.checked).toBe(true);
    const selectRadio = screen.getByRole("radio", { name: /Select charges/i }) as HTMLInputElement;
    expect(selectRadio.checked).toBe(false);

    // Grouped, in order: Overdue -> Due now -> Upcoming. Group headers are
    // semantic headings, distinct from the per-row status Badge (a span) that
    // happens to render the same uppercase strings for overdue/upcoming.
    const groupHeaders = screen.getAllByRole("heading", { level: 2 });
    expect(groupHeaders.map((el) => el.textContent)).toEqual(["OVERDUE", "DUE NOW", "UPCOMING"]);

    // Each row: label, bill reference, formatted due date, formatted amount.
    //
    // The reference NO LONGER falls back to chargeNumber (was B34). That fallback
    // was the leak: grid-minted charges have no Charge.invoiceId, so every one of
    // them printed an internal id — `GRIDEXP-202608-360f0307-…-SST`. A charge with
    // no bill now shows its due date alone, which is honest and readable.
    expect(screen.getByText("April rent")).toBeTruthy();
    expect(screen.queryByText(/CHG-0023/)).toBeNull();
    expect(screen.getByText("July cleaning")).toBeTruthy();
    expect(screen.getByText(/IVTEN-0007/)).toBeTruthy();
    expect(screen.getByText("August rent")).toBeTruthy();

    // Status badges per group — scoped to each row, since the OVERDUE/UPCOMING
    // group headings render the identical uppercase string (UNPAID does not
    // collide with any heading, since the "due" group's heading is "DUE NOW").
    const overdueRow = screen.getByText("April rent").parentElement!.parentElement as HTMLElement;
    expect(within(overdueRow).getByText("OVERDUE")).toBeTruthy();
    expect(screen.getByText("UNPAID")).toBeTruthy();
    const upcomingRow = screen.getByText("August rent").parentElement!.parentElement as HTMLElement;
    expect(within(upcomingRow).getByText("UPCOMING")).toBeTruthy();

    // Footer live totals: eligible-only total (1200.50 + 99.55 = 1300.05,
    // thousands-separated), payment amount identical in "all" mode since
    // every eligible charge is auto-selected and upcoming is excluded.
    expect(screen.getByText("Total outstanding RM 1,300.05")).toBeTruthy();
    expect(screen.getByText("Payment amount RM 1,300.05")).toBeTruthy();
    expect(screen.getByText(/^2 charges? selected/)).toBeTruthy();

    // Upcoming (RM 1,200.00) must NOT be folded into either total.
    expect(screen.queryByText(/RM 2,500\.05/)).toBeNull();
  });
});

describe("PortalPayPage — select subset", () => {
  it("switching to Select charges shows checkboxes; unchecking one drops the payment amount", async () => {
    renderPage();
    await screen.findByText("April rent");

    fireEvent.click(screen.getByRole("radio", { name: /Select charges/i }));

    // Both eligible charges start checked (same default as pay-all).
    const overdueCheckbox = (await screen.findByRole("checkbox", {
      name: /April rent/i,
    })) as HTMLInputElement;
    const dueCheckbox = screen.getByRole("checkbox", { name: /July cleaning/i }) as HTMLInputElement;
    expect(overdueCheckbox.checked).toBe(true);
    expect(dueCheckbox.checked).toBe(true);
    expect(screen.getByText("Payment amount RM 1,300.05")).toBeTruthy();

    // Uncheck the overdue charge (RM 1,200.50) — payment amount drops to the
    // due-now charge's outstanding alone (RM 99.55).
    fireEvent.click(overdueCheckbox);

    expect(overdueCheckbox.checked).toBe(false);
    expect(screen.getByText("Payment amount RM 99.55")).toBeTruthy();
    // Total outstanding (reference figure, independent of selection) is unchanged.
    expect(screen.getByText("Total outstanding RM 1,300.05")).toBeTruthy();
    expect(screen.getByText(/^1 charge selected/)).toBeTruthy();
  });
});

describe("PortalPayPage — upcoming not prepaid", () => {
  it("never auto-checks the upcoming charge, in pay-all default or after switching to Select charges", async () => {
    renderPage();
    await screen.findByText("April rent");

    // Pay-all mode (default): no checkbox at all for upcoming, only the
    // eligible charges show the included-checkmark.
    const upcomingRowAll = screen.getByText("August rent").parentElement!.parentElement as HTMLElement;
    expect(within(upcomingRowAll).queryByRole("checkbox")).toBeNull();

    // Switch to Select charges — the upcoming row now HAS a checkbox, but it
    // must be unchecked (never auto-selected), even though this is a fresh
    // seed of the manual-selection state distinct from pay-all mode.
    fireEvent.click(screen.getByRole("radio", { name: /Select charges/i }));
    const upcomingCheckbox = (await screen.findByRole("checkbox", {
      name: /August rent/i,
    })) as HTMLInputElement;
    expect(upcomingCheckbox.checked).toBe(false);

    // It remains manually checkable though — this is not a disabled row.
    fireEvent.click(upcomingCheckbox);
    expect(upcomingCheckbox.checked).toBe(true);
  });
});

describe("PortalPayPage — malformed due date", () => {
  it("classifies an unparseable dueDate as Upcoming (never auto-selected), not Overdue", async () => {
    mockCharges([{ ...DUE, id: "c-bad-date", dueDate: "not-a-real-date" }]);
    renderPage();

    // Renders without crashing, under the Upcoming heading — the one bucket
    // that is never auto-selected in pay-all mode.
    const heading = await screen.findByRole("heading", { level: 2 });
    expect(heading.textContent).toBe("UPCOMING");
    expect(screen.getByText("Payment amount RM 0.00")).toBeTruthy();
    expect(screen.getByText(/^0 charges selected/)).toBeTruthy();
  });
});

describe("PortalPayPage — due-now timezone boundary", () => {
  it("classifies using the Malaysia calendar day, not the UTC calendar day", async () => {
    // System time: 2026-07-20T20:00:00.000Z = 2026-07-21T04:00+08:00 (MY).
    // UTC calendar day is still the 20th; MY calendar day is already the
    // 21st. A charge due at 2026-07-21T00:00:00.000Z (= 08:00 MY on the
    // 21st) is, in MY terms, due THIS calendar day (Due now / UNPAID /
    // auto-selected in pay-all). A UTC-anchored classifier would instead see
    // due-date-UTC "2026-07-21" > today-UTC "2026-07-20" and wrongly bucket
    // it as Upcoming (excluded from auto-select) — exactly the anti-prepay
    // invariant this app cares about, inverted by a timezone bug.
    // Fake only Date (not setTimeout/setInterval) — RTL's findBy/waitFor
    // polling internally relies on real timers to resolve.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-20T20:00:00.000Z"));

    mockCharges([{ ...DUE, id: "c-boundary", dueDate: "2026-07-21T00:00:00.000Z" }]);
    renderPage();

    const heading = await screen.findByRole("heading", { level: 2 });
    expect(heading.textContent).toBe("DUE NOW");
    expect(screen.getByText("UNPAID")).toBeTruthy();
    expect(screen.getByText("Payment amount RM 99.55")).toBeTruthy(); // auto-selected, not upcoming
  });
});

describe("PortalPayPage — review step", () => {
  it("Continue to payment shows the paying list, subtotal, TOTAL, and method radios", async () => {
    renderPage();
    await screen.findByText("April rent");

    fireEvent.click(screen.getByRole("button", { name: /Continue to payment/i }));

    // Paying list — one line per selected (eligible) charge; upcoming absent.
    expect(await screen.findByText("April rent")).toBeTruthy();
    expect(screen.getByText("July cleaning")).toBeTruthy();
    expect(screen.queryByText("August rent")).toBeNull();

    expect(screen.getByText("Subtotal RM 1,300.05")).toBeTruthy();
    expect(screen.getByText("TOTAL RM 1,300.05")).toBeTruthy();

    const fpxRadio = screen.getByRole("radio", { name: /FPX/i }) as HTMLInputElement;
    const bankRadio = screen.getByRole("radio", { name: /Bank transfer/i }) as HTMLInputElement;
    expect(fpxRadio.checked).toBe(true); // FPX is the default method
    expect(bankRadio.checked).toBe(false);

    // Mode-select UI (radios, charge list) is gone on the review step.
    expect(screen.queryByRole("radio", { name: /Pay all outstanding/i })).toBeNull();
  });

  it("0 selected charges disables Continue to payment", async () => {
    renderPage();
    await screen.findByText("April rent");

    fireEvent.click(screen.getByRole("radio", { name: /Select charges/i }));
    const overdueCheckbox = await screen.findByRole("checkbox", { name: /April rent/i });
    const dueCheckbox = screen.getByRole("checkbox", { name: /July cleaning/i });
    fireEvent.click(overdueCheckbox);
    fireEvent.click(dueCheckbox);

    expect(screen.getByText(/^0 charges selected/)).toBeTruthy();
    const continueButton = screen.getByRole("button", { name: /Continue to payment/i }) as HTMLButtonElement;
    expect(continueButton.disabled).toBe(true);

    // Clicking a disabled button must not advance to the review step.
    fireEvent.click(continueButton);
    expect(screen.queryByText("Subtotal RM 0.00")).toBeNull();
  });
});

describe("PortalPayPage — result screen", () => {
  it("successful manual (bank transfer) pay shows payment number, applied-to list, and Return to Billing", async () => {
    portalApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path.startsWith("/payments/payable-charges")) {
        return Promise.resolve({
          data: [OVERDUE, DUE, UPCOMING],
          pagination: { page: 1, limit: 50, total: 3, totalPages: 1 },
        });
      }
      if (path === "/payments/slip-upload-url" && init?.method === "POST") {
        return Promise.resolve(slipTicket());
      }
      if (path === "/payments/pay" && init?.method === "POST") {
        return Promise.resolve({ id: "pay-1", paymentNumber: "PAY-2026-0014" });
      }
      return Promise.reject(new Error(`unhandled portalApiFetch call in test: ${path}`));
    });

    renderPage();
    await screen.findByText("April rent");
    fireEvent.click(screen.getByRole("button", { name: /Continue to payment/i }));

    fireEvent.click(await screen.findByRole("radio", { name: /Bank transfer/i }));
    const refInput = screen.getByPlaceholderText("e.g. TXN-20260618-001");
    fireEvent.change(refInput, { target: { value: "TXN-999" } });
    attachSlip();
    agreeToTerms();

    fireEvent.click(submitButton());

    // NOT "Payment Successful" — nothing is settled until an admin verifies the
    // slip, and telling the tenant otherwise invites them to ignore the next
    // reminder or to pay a second time when the charge still shows outstanding.
    expect(await screen.findByText("Payment submitted for verification")).toBeTruthy();
    expect(screen.getByText(/PAY-2026-0014/)).toBeTruthy();
    expect(screen.getByText(/April rent/)).toBeTruthy();
    expect(screen.getByText(/July cleaning/)).toBeTruthy();
    expect(screen.getByText(/Not confirmed yet/)).toBeTruthy();
    expect(screen.getByText(/please don't pay them again/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Return to Billing/i }));
    expect(navigate).toHaveBeenCalledWith("/portal/billing");

    const call = portalApiFetch.mock.calls.find(
      ([p, init]) => p === "/payments/pay" && init?.method === "POST",
    );
    expect(call).toBeTruthy();
    const body = JSON.parse((call![1] as RequestInit).body as string);
    expect(body.paymentMethod).toBe("bank_transfer");
    expect(body.referenceNumber).toBe("TXN-999");
    expect(body.allocations).toEqual([
      { chargeId: "c-overdue", allocatedAmount: "1200.50" },
      { chargeId: "c-due", allocatedAmount: "99.55" },
    ]);
    expect(typeof body.idempotencyKey).toBe("string");
    expect(body.idempotencyKey.length).toBeGreaterThan(0);
    // The slip key the upload returned must reach the payment — without it the
    // admin has a claim with no proof to verify against.
    expect(body.attachmentKeys).toEqual([SLIP_KEY]);
  });

  it("uploads the slip BEFORE creating the payment, so a failed upload creates nothing", async () => {
    portalApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path.startsWith("/payments/payable-charges")) {
        return Promise.resolve({
          data: [OVERDUE, DUE, UPCOMING],
          pagination: { page: 1, limit: 50, total: 3, totalPages: 1 },
        });
      }
      if (path === "/payments/slip-upload-url" && init?.method === "POST") {
        return Promise.resolve(slipTicket());
      }
      if (path === "/payments/pay" && init?.method === "POST") {
        return Promise.resolve({ id: "pay-1", paymentNumber: "PAY-2026-0014" });
      }
      return Promise.reject(new Error(`unhandled portalApiFetch call in test: ${path}`));
    });
    // Storage rejects the PUT.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    renderPage();
    await screen.findByText("April rent");
    fireEvent.click(screen.getByRole("button", { name: /Continue to payment/i }));
    fireEvent.click(await screen.findByRole("radio", { name: /Bank transfer/i }));
    fireEvent.change(screen.getByPlaceholderText("e.g. TXN-20260618-001"), { target: { value: "TXN-999" } });
    attachSlip();
    agreeToTerms();
    fireEvent.click(submitButton());

    expect(await screen.findByText(/couldn't upload your slip/i)).toBeTruthy();
    // No payment row: a slipless payment is one nobody can verify.
    expect(
      portalApiFetch.mock.calls.find(([p, i]) => p === "/payments/pay" && (i as RequestInit)?.method === "POST"),
    ).toBeUndefined();
    // Still on the review step, so the tenant can retry.
    expect(screen.queryByText("Payment submitted for verification")).toBeNull();
  });

  it("blocks submission until a slip is attached", async () => {
    renderPage();
    await screen.findByText("April rent");
    fireEvent.click(screen.getByRole("button", { name: /Continue to payment/i }));
    fireEvent.click(await screen.findByRole("radio", { name: /Bank transfer/i }));
    fireEvent.change(screen.getByPlaceholderText("e.g. TXN-20260618-001"), { target: { value: "TXN-999" } });
    // Consent given up-front so this test isolates the SLIP rule; without it
    // the button stays disabled for the agreement's sake and proves nothing.
    agreeToTerms();

    expect(submitButton().disabled).toBe(true);
    attachSlip();
    expect(submitButton().disabled).toBe(false);
  });
});

describe("PortalPayPage — fpx redirect", () => {
  it("FPX (default method) posts to fpx/initiate and redirects, never reaching an in-page result step", async () => {
    portalApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path.startsWith("/payments/payable-charges")) {
        return Promise.resolve({
          data: [OVERDUE, DUE, UPCOMING],
          pagination: { page: 1, limit: 50, total: 3, totalPages: 1 },
        });
      }
      if (path === "/payments/fpx/initiate" && init?.method === "POST") {
        return Promise.resolve({
          redirectUrl: "/portal/fpx/mock?txn=txn-1&amount=1300.05",
          providerTxnId: "txn-1",
          paymentId: "pay-1",
        });
      }
      return Promise.reject(new Error(`unhandled portalApiFetch call in test: ${path}`));
    });

    renderPage();
    await screen.findByText("April rent");
    fireEvent.click(screen.getByRole("button", { name: /Continue to payment/i }));

    // FPX is the default method on the review step — no reference field, and
    // no slip either: the gateway callback reconciles it, so there is nothing
    // for a human to verify.
    expect(screen.queryByPlaceholderText("e.g. TXN-20260618-001")).toBeNull();
    expect(screen.queryByLabelText(/transfer slip/i)).toBeNull();

    // Still "Pay RM…" on this path — FPX really does take the money now, unlike
    // the manual path's "Submit … for verification".
    agreeToTerms();
    fireEvent.click(screen.getByRole("button", { name: /^Pay RM/i }));

    await waitFor(() => {
      const call = portalApiFetch.mock.calls.find(
        ([p, init]) => p === "/payments/fpx/initiate" && init?.method === "POST",
      );
      expect(call).toBeTruthy();
      const body = JSON.parse((call![1] as RequestInit).body as string);
      expect(body.allocations).toEqual([
        { chargeId: "c-overdue", allocatedAmount: "1200.50" },
        { chargeId: "c-due", allocatedAmount: "99.55" },
      ]);
      expect(typeof body.idempotencyKey).toBe("string");
    });

    expect(portalApiFetch.mock.calls.some(([p]) => p === "/payments/pay")).toBe(false);
    await waitFor(() =>
      expect(assignMock).toHaveBeenCalledWith("/portal/fpx/mock?txn=txn-1&amount=1300.05"),
    );
    // No in-page success screen for the FPX path — the browser has left the SPA.
    expect(screen.queryByText("Payment Successful")).toBeNull();
  });
});

describe("PortalPayPage — terms consent gate", () => {
  it("holds the FPX pay button until the tenant ticks agreement, and releases it again on untick", async () => {
    renderPage();
    await screen.findByText("April rent");
    fireEvent.click(screen.getByRole("button", { name: /Continue to payment/i }));

    const consent = (await screen.findByRole("checkbox", {
      name: /I agree to the Terms/i,
    })) as HTMLInputElement;
    // Starts UNticked. The old screen had no box at all — agreement was implied
    // by pressing Pay — so a pre-ticked box would reproduce the same defect
    // while merely looking like consent.
    expect(consent.checked).toBe(false);
    expect((screen.getByRole("button", { name: /^Pay RM/i }) as HTMLButtonElement).disabled).toBe(true);

    // The consequence that actually matters: nothing left the page.
    fireEvent.click(screen.getByRole("button", { name: /^Pay RM/i }));
    expect(portalApiFetch.mock.calls.some(([p]) => p === "/payments/fpx/initiate")).toBe(false);

    agreeToTerms();
    expect((screen.getByRole("button", { name: /^Pay RM/i }) as HTMLButtonElement).disabled).toBe(false);

    // Withdrawing consent re-arms the gate.
    agreeToTerms();
    expect((screen.getByRole("button", { name: /^Pay RM/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("gates the manual path on consent as well, without replacing the reference/slip rules", async () => {
    renderPage();
    await screen.findByText("April rent");
    fireEvent.click(screen.getByRole("button", { name: /Continue to payment/i }));
    fireEvent.click(await screen.findByRole("radio", { name: /Bank transfer/i }));

    fireEvent.change(screen.getByPlaceholderText("e.g. TXN-20260618-001"), {
      target: { value: "TXN-1" },
    });
    attachSlip();
    // Reference + slip satisfied; consent alone is still missing.
    expect(submitButton().disabled).toBe(true);

    agreeToTerms();
    expect(submitButton().disabled).toBe(false);
  });

  it("opens both policies in a new tab, so reading them can't discard the payment in progress", async () => {
    renderPage();
    await screen.findByText("April rent");
    fireEvent.click(screen.getByRole("button", { name: /Continue to payment/i }));
    await screen.findByRole("checkbox", { name: /I agree to the Terms/i });

    // Scoped to the consent label — LegalFooterLinks at the foot of this same
    // step renders its own Terms link, which is a plain in-page nav.
    const label = document.getElementById("pay-terms-agree-label") as HTMLElement;
    const links = within(label).getAllByRole("link") as HTMLAnchorElement[];
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["/terms", "/refund-policy"]);
    for (const a of links) {
      // In-place navigation would unmount the page and silently drop the
      // selected charges, the reference number and the picked slip.
      expect(a.target).toBe("_blank");
      expect(a.rel).toContain("noopener");
    }
  });
});

describe("PortalPayPage — money invariant: no editable amount", () => {
  it("renders no numeric/editable amount input in pay-all mode, select mode, or the review step", async () => {
    renderPage();
    await screen.findByText("April rent");
    expect(screen.queryByRole("spinbutton")).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: /Select charges/i }));
    await screen.findByRole("checkbox", { name: /April rent/i });
    expect(screen.queryByRole("spinbutton")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Continue to payment/i }));
    await screen.findByText(/^TOTAL/);
    expect(screen.queryByRole("spinbutton")).toBeNull();
    // The only text inputs on the review step are Reference Number (once
    // Bank transfer is selected); neither is type="number".
    fireEvent.click(screen.getByRole("radio", { name: /Bank transfer/i }));
    const textInputs = screen.getAllByRole("textbox");
    for (const el of textInputs) {
      expect((el as HTMLInputElement).type).not.toBe("number");
    }
  });
});

describe("PortalPayPage — double-submit prevented", () => {
  it("disables Pay synchronously once clicked, before the mutation resolves, so a second click can't fire", async () => {
    let resolvePay: (value: unknown) => void = () => {};
    const payPromise = new Promise((resolve) => {
      resolvePay = resolve;
    });
    portalApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path.startsWith("/payments/payable-charges")) {
        return Promise.resolve({
          data: [OVERDUE, DUE, UPCOMING],
          pagination: { page: 1, limit: 50, total: 3, totalPages: 1 },
        });
      }
      if (path === "/payments/slip-upload-url" && init?.method === "POST") {
        return Promise.resolve(slipTicket());
      }
      if (path === "/payments/pay" && init?.method === "POST") return payPromise;
      return Promise.reject(new Error(`unhandled portalApiFetch call in test: ${path}`));
    });

    renderPage();
    await screen.findByText("April rent");
    fireEvent.click(screen.getByRole("button", { name: /Continue to payment/i }));
    fireEvent.click(await screen.findByRole("radio", { name: /Bank transfer/i }));
    fireEvent.change(screen.getByPlaceholderText("e.g. TXN-20260618-001"), {
      target: { value: "TXN-1" },
    });
    attachSlip();
    agreeToTerms();

    const payButton = submitButton() as HTMLButtonElement;
    fireEvent.click(payButton);

    // Disabled synchronously — before the mocked promise ever resolves. The
    // manual path now uploads the slip first, so the very first label is
    // "Uploading slip…"; it becomes "Submitting…" once the PUT resolves.
    expect(payButton.disabled).toBe(true);
    expect(payButton.textContent).toMatch(/Uploading slip|Submitting/);

    // A native disabled <button> cannot dispatch a click at all, so a second
    // fireEvent.click here is a no-op; confirm only one call was actually made
    // (waitFor because the mutationFn's invocation is microtask-deferred from
    // the synchronous disabled-state update above).
    fireEvent.click(payButton);
    await waitFor(() => {
      const payCalls = portalApiFetch.mock.calls.filter(
        ([p, init]) => p === "/payments/pay" && init?.method === "POST",
      );
      expect(payCalls.length).toBe(1);
    });

    resolvePay({ id: "pay-1", paymentNumber: "PAY-1" });
    expect(await screen.findByText("Payment submitted for verification")).toBeTruthy();
  });
});

describe("PortalPayPage — retry after error", () => {
  it("shows the error, re-enables the form, and mints a fresh idempotencyKey on retry", async () => {
    let uuidCount = 0;
    vi.stubGlobal("crypto", { randomUUID: () => `uuid-${++uuidCount}` });

    let payCallCount = 0;
    portalApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path.startsWith("/payments/payable-charges")) {
        return Promise.resolve({
          data: [OVERDUE, DUE, UPCOMING],
          pagination: { page: 1, limit: 50, total: 3, totalPages: 1 },
        });
      }
      if (path === "/payments/slip-upload-url" && init?.method === "POST") {
        return Promise.resolve(slipTicket());
      }
      if (path === "/payments/pay" && init?.method === "POST") {
        payCallCount += 1;
        if (payCallCount === 1) return Promise.reject(new Error("Server error. Try again."));
        return Promise.resolve({ id: "pay-1", paymentNumber: "PAY-1" });
      }
      return Promise.reject(new Error(`unhandled portalApiFetch call in test: ${path}`));
    });

    renderPage();
    await screen.findByText("April rent");
    fireEvent.click(screen.getByRole("button", { name: /Continue to payment/i }));
    fireEvent.click(await screen.findByRole("radio", { name: /Bank transfer/i }));
    fireEvent.change(screen.getByPlaceholderText("e.g. TXN-20260618-001"), {
      target: { value: "TXN-1" },
    });
    attachSlip();
    agreeToTerms();

    fireEvent.click(submitButton());
    expect(await screen.findByText("Server error. Try again.")).toBeTruthy();

    // Form is genuinely resubmittable, not stuck — and the slip survives the
    // failure, so the tenant doesn't have to re-pick the file to retry.
    const retryButton = submitButton() as HTMLButtonElement;
    expect(retryButton.disabled).toBe(false);
    fireEvent.click(retryButton);
    expect(await screen.findByText("Payment submitted for verification")).toBeTruthy();

    const payCalls = portalApiFetch.mock.calls.filter(
      ([p, init]) => p === "/payments/pay" && init?.method === "POST",
    );
    expect(payCalls.length).toBe(2);
    const body1 = JSON.parse((payCalls[0][1] as RequestInit).body as string);
    const body2 = JSON.parse((payCalls[1][1] as RequestInit).body as string);
    expect(body1.idempotencyKey).not.toBe(body2.idempotencyKey);
  });
});

describe("PortalPayPage — Back preserves selection", () => {
  it("returns to the select step with the same mode/selection intact, and hides a stale error", async () => {
    portalApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path.startsWith("/payments/payable-charges")) {
        return Promise.resolve({
          data: [OVERDUE, DUE, UPCOMING],
          pagination: { page: 1, limit: 50, total: 3, totalPages: 1 },
        });
      }
      if (path === "/payments/slip-upload-url" && init?.method === "POST") {
        return Promise.resolve(slipTicket());
      }
      if (path === "/payments/pay" && init?.method === "POST") {
        return Promise.reject(new Error("Server error. Try again."));
      }
      return Promise.reject(new Error(`unhandled portalApiFetch call in test: ${path}`));
    });

    renderPage();
    await screen.findByText("April rent");

    fireEvent.click(screen.getByRole("radio", { name: /Select charges/i }));
    const overdueCheckbox = await screen.findByRole("checkbox", { name: /April rent/i });
    fireEvent.click(overdueCheckbox); // uncheck it — subset selection

    fireEvent.click(screen.getByRole("button", { name: /Continue to payment/i }));
    fireEvent.click(await screen.findByRole("radio", { name: /Bank transfer/i }));
    fireEvent.change(screen.getByPlaceholderText("e.g. TXN-20260618-001"), {
      target: { value: "TXN-1" },
    });
    attachSlip();
    agreeToTerms();

    // Produce a stale error, then back out of the review step.
    fireEvent.click(submitButton());
    expect(await screen.findByText("Server error. Try again.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Back/i }));

    // Mode-select UI is back; the previously-unchecked charge is STILL
    // unchecked (selection preserved, not reset), and no stray error text.
    expect(screen.getByRole("radio", { name: /Select charges/i })).toBeTruthy();
    const overdueCheckboxAgain = screen.getByRole("checkbox", { name: /April rent/i }) as HTMLInputElement;
    expect(overdueCheckboxAgain.checked).toBe(false);
    expect(screen.getByText("Payment amount RM 99.55")).toBeTruthy();
    expect(screen.queryByText("Server error. Try again.")).toBeNull();

    // Continue again — the reference number typed earlier survived too
    // (state, not remounted), confirmed by re-entering Bank transfer review
    // without retyping and the field already carrying the prior value.
    fireEvent.click(screen.getByRole("button", { name: /Continue to payment/i }));
    fireEvent.click(await screen.findByRole("radio", { name: /Bank transfer/i }));
    const refInput = screen.getByPlaceholderText("e.g. TXN-20260618-001") as HTMLInputElement;
    expect(refInput.value).toBe("TXN-1");

    // The consent tick survives Back too — it agrees to two policies, which
    // don't change when the basket does. Re-ticking after every edit would be
    // busywork that trains the tenant to click it without reading.
    expect(
      (screen.getByRole("checkbox", { name: /I agree to the Terms/i }) as HTMLInputElement).checked,
    ).toBe(true);
  });
});

describe("PortalPayPage — reference number survives a method toggle", () => {
  it("keeps the typed reference number after toggling to FPX and back to Bank transfer", async () => {
    renderPage();
    await screen.findByText("April rent");
    fireEvent.click(screen.getByRole("button", { name: /Continue to payment/i }));

    fireEvent.click(await screen.findByRole("radio", { name: /Bank transfer/i }));
    fireEvent.change(screen.getByPlaceholderText("e.g. TXN-20260618-001"), {
      target: { value: "TXN-KEEP-ME" },
    });

    fireEvent.click(screen.getByRole("radio", { name: /FPX/i }));
    expect(screen.queryByPlaceholderText("e.g. TXN-20260618-001")).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: /Bank transfer/i }));
    const refInput = screen.getByPlaceholderText("e.g. TXN-20260618-001") as HTMLInputElement;
    expect(refInput.value).toBe("TXN-KEEP-ME");
  });
});

describe("PortalPayPage — whitespace-only reference rejected", () => {
  it("disables Pay when the reference number is only whitespace, and trims a valid one before sending", async () => {
    portalApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path.startsWith("/payments/payable-charges")) {
        return Promise.resolve({
          data: [OVERDUE, DUE, UPCOMING],
          pagination: { page: 1, limit: 50, total: 3, totalPages: 1 },
        });
      }
      if (path === "/payments/slip-upload-url" && init?.method === "POST") {
        return Promise.resolve(slipTicket());
      }
      if (path === "/payments/pay" && init?.method === "POST") {
        return Promise.resolve({ id: "pay-1", paymentNumber: "PAY-1" });
      }
      return Promise.reject(new Error(`unhandled portalApiFetch call in test: ${path}`));
    });

    renderPage();
    await screen.findByText("April rent");
    fireEvent.click(screen.getByRole("button", { name: /Continue to payment/i }));
    fireEvent.click(await screen.findByRole("radio", { name: /Bank transfer/i }));
    // Slip attached and consent given up-front so this test isolates the
    // REFERENCE rule; without them the button would stay disabled for another
    // gate's sake and prove nothing.
    attachSlip();
    agreeToTerms();

    const refInput = screen.getByPlaceholderText("e.g. TXN-20260618-001");
    const payButton = submitButton() as HTMLButtonElement;

    fireEvent.change(refInput, { target: { value: "   " } });
    expect(payButton.disabled).toBe(true);

    fireEvent.change(refInput, { target: { value: "  TXN-1  " } });
    expect(payButton.disabled).toBe(false);
    fireEvent.click(payButton);

    await waitFor(() => {
      const call = portalApiFetch.mock.calls.find(
        ([p, init]) => p === "/payments/pay" && init?.method === "POST",
      );
      expect(call).toBeTruthy();
      const body = JSON.parse((call![1] as RequestInit).body as string);
      expect(body.referenceNumber).toBe("TXN-1"); // trimmed, not "  TXN-1  "
    });
  });
});

describe("PortalPayPage — mode transition preserves manual edits", () => {
  it("switching select -> all -> select keeps the previously-unchecked charge unchecked", async () => {
    renderPage();
    await screen.findByText("April rent");

    fireEvent.click(screen.getByRole("radio", { name: /Select charges/i }));
    const overdueCheckbox = await screen.findByRole("checkbox", { name: /April rent/i });
    fireEvent.click(overdueCheckbox); // uncheck — manual edit
    expect((overdueCheckbox as HTMLInputElement).checked).toBe(false);

    // "Pay all outstanding" is non-editable and always reflects the full
    // eligible set, regardless of any manual edits made in Select mode.
    fireEvent.click(screen.getByRole("radio", { name: /Pay all outstanding/i }));
    expect(screen.getByText("Payment amount RM 1,300.05")).toBeTruthy();

    // Switching back to Select charges must NOT silently discard the user's
    // earlier manual edit and re-seed from eligible again.
    fireEvent.click(screen.getByRole("radio", { name: /Select charges/i }));
    const overdueCheckboxAgain = await screen.findByRole("checkbox", { name: /April rent/i });
    expect((overdueCheckboxAgain as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText("Payment amount RM 99.55")).toBeTruthy();
  });
});

describe("PortalPayPage — Select all outstanding", () => {
  it("toggles only the eligible (overdue+due) charges, without touching a manually-checked upcoming row", async () => {
    renderPage();
    await screen.findByText("April rent");
    fireEvent.click(screen.getByRole("radio", { name: /Select charges/i }));

    const overdueCheckbox = (await screen.findByRole("checkbox", {
      name: /April rent/i,
    })) as HTMLInputElement;
    const upcomingCheckbox = screen.getByRole("checkbox", { name: /August rent/i }) as HTMLInputElement;

    // Manually opt in to the upcoming charge (deliberate prepay), then
    // uncheck one eligible charge.
    fireEvent.click(upcomingCheckbox);
    fireEvent.click(overdueCheckbox);
    expect(upcomingCheckbox.checked).toBe(true);
    expect(overdueCheckbox.checked).toBe(false);

    const selectAll = screen.getByRole("checkbox", { name: /Select all outstanding/i }) as HTMLInputElement;
    expect(selectAll.checked).toBe(false); // not all eligible are checked right now

    fireEvent.click(selectAll);
    expect(overdueCheckbox.checked).toBe(true); // re-included
    expect(upcomingCheckbox.checked).toBe(true); // untouched, still deliberately checked
    expect(screen.getByText("Payment amount RM 2,500.05")).toBeTruthy(); // 1300.05 + 1200

    // Clicking again while all-eligible are checked clears just the eligible set.
    fireEvent.click(selectAll);
    expect(overdueCheckbox.checked).toBe(false);
    const dueCheckbox = screen.getByRole("checkbox", { name: /July cleaning/i }) as HTMLInputElement;
    expect(dueCheckbox.checked).toBe(false);
    expect(upcomingCheckbox.checked).toBe(true); // still untouched
  });
});

describe("PortalPayPage — fetch error and empty states", () => {
  it("shows a Callout (not a crash) when the payable-charges fetch fails", async () => {
    portalApiFetch.mockImplementation((path: string) => {
      if (path.startsWith("/payments/payable-charges")) {
        return Promise.reject(new Error("network down"));
      }
      return Promise.reject(new Error(`unhandled portalApiFetch call in test: ${path}`));
    });
    renderPage();
    expect(await screen.findByText(/No payable charges available/i)).toBeTruthy();
    // Restyled with the design-system Callout, not a hand-rolled div.
    expect(document.querySelector('[class*="border-rose"]')).toBeTruthy();
  });

  it("shows the existing zero-charges empty state with no mode-select UI", async () => {
    mockCharges([]);
    renderPage();
    expect(await screen.findByText("You have no outstanding charges to pay.")).toBeTruthy();
    expect(screen.queryByRole("radio", { name: /Pay all outstanding/i })).toBeNull();
  });

  it("requests up to the server's page-size cap so pay-all/select-all cover a full arrears list", async () => {
    renderPage();
    await screen.findByText("April rent");
    const call = portalApiFetch.mock.calls.find(([p]) => p.startsWith("/payments/payable-charges"));
    expect(call![0]).toContain("limit=50");
  });
});

describe("PortalPayPage — optional notes", () => {
  it("sends a typed note on the manual/bank-transfer path, and omits it when left blank", async () => {
    portalApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path.startsWith("/payments/payable-charges")) {
        return Promise.resolve({
          data: [OVERDUE, DUE, UPCOMING],
          pagination: { page: 1, limit: 50, total: 3, totalPages: 1 },
        });
      }
      if (path === "/payments/slip-upload-url" && init?.method === "POST") {
        return Promise.resolve(slipTicket());
      }
      if (path === "/payments/pay" && init?.method === "POST") {
        return Promise.resolve({ id: "pay-1", paymentNumber: "PAY-1" });
      }
      return Promise.reject(new Error(`unhandled portalApiFetch call in test: ${path}`));
    });

    renderPage();
    await screen.findByText("April rent");
    fireEvent.click(screen.getByRole("button", { name: /Continue to payment/i }));
    fireEvent.click(await screen.findByRole("radio", { name: /Bank transfer/i }));
    fireEvent.change(screen.getByPlaceholderText("e.g. TXN-20260618-001"), {
      target: { value: "TXN-1" },
    });
    fireEvent.change(screen.getByLabelText(/Notes/i), { target: { value: "Paid via maybank2u" } });
    attachSlip();
    agreeToTerms();

    fireEvent.click(submitButton());

    await waitFor(() => {
      const call = portalApiFetch.mock.calls.find(
        ([p, init]) => p === "/payments/pay" && init?.method === "POST",
      );
      const body = JSON.parse((call![1] as RequestInit).body as string);
      expect(body.notes).toBe("Paid via maybank2u");
    });
  });
});

// ── folded SST sibling ─────────────────────────────────────────────────────
//
// An SST-bearing expense is TWO Charges (base + a sibling whose amount IS the
// tax), and the server now folds them into ONE payable row via
// `foldPayableTaxSiblings`, carrying both charge ids in `components`. Reported
// from UAT IVTEN-0002, where the pay screen listed "test ten exp sst RM 0.50" and
// "test ten exp sst — SST 8% RM 0.04" as two separate overdue bills while the
// tenant's invoice showed one line of RM 0.54.

/** The folded row the server returns for an SST-bearing expense. */
const FOLDED_SST: PayableCharge & {
  components: { chargeId: string; outstandingAmount: number }[];
} = {
  id: "c-exp-base",
  chargeNumber: "GRIDEXP-202608-sst",
  chargeType: "expense",
  description: "test ten exp sst",
  dueDate: isoAtMyOffsetDays(-16),
  amount: 0.54,
  outstandingAmount: 0.54,
  currency: "MYR",
  invoiceId: null,
  invoiceNumber: null,
  components: [
    { chargeId: "c-exp-base", outstandingAmount: 0.5 },
    { chargeId: "c-exp-sst", outstandingAmount: 0.04 },
  ],
};

/** Mock that serves `data` for the list and succeeds an FPX initiate. */
function mockChargesWithFpx(data: PayableCharge[], txnId: string) {
  portalApiFetch.mockImplementation((path: string, init?: RequestInit) => {
    if (path.startsWith("/payments/payable-charges")) {
      return Promise.resolve({
        data,
        pagination: { page: 1, limit: 50, total: data.length, totalPages: 1 },
      });
    }
    if (path === "/payments/fpx/initiate" && init?.method === "POST") {
      return Promise.resolve({
        redirectUrl: "https://pay.example/fpx/abc",
        providerTxnId: txnId,
        paymentId: `pay-${txnId}`,
      });
    }
    return Promise.reject(new Error(`unhandled portalApiFetch call in test: ${path}`));
  });
}

/** Drive the FPX path to submission and return the posted allocations. */
async function payByFpxAndReadAllocations(firstRowLabel: string) {
  renderPage();
  await screen.findByText(firstRowLabel);
  fireEvent.click(screen.getByRole("button", { name: /Continue to payment/i }));
  agreeToTerms();
  fireEvent.click(await screen.findByRole("button", { name: /^Pay RM/i }));

  let allocations: { chargeId: string; allocatedAmount: string }[] = [];
  await waitFor(() => {
    const call = portalApiFetch.mock.calls.find(
      ([p, init]) => p === "/payments/fpx/initiate" && init?.method === "POST",
    );
    expect(call).toBeTruthy();
    allocations = JSON.parse((call![1] as RequestInit).body as string).allocations;
  });
  return allocations;
}

describe("PortalPayPage — folded SST sibling", () => {
  it("shows ONE row of RM 0.54 and never a bare '— SST 8%' line", async () => {
    mockCharges([FOLDED_SST]);
    renderPage();

    expect(await screen.findByText("test ten exp sst")).toBeTruthy();
    // THE DEFECT: this row used to sit underneath as its own overdue bill.
    expect(screen.queryByText(/SST 8%/)).toBeNull();
    expect(screen.getByText("RM 0.54")).toBeTruthy();
  });

  it("submits TWO allocations for the one row the tenant ticked", async () => {
    mockChargesWithFpx([FOLDED_SST], "TXN-A");

    const allocations = await payByFpxAndReadAllocations("test ten exp sst");

    // ⚠️ MONEY. validatePaymentAllocationsTx locks each charge and demands the
    // allocation equal THAT charge's own outstanding to the cent, so the merged
    // 0.54 must NEVER be sent against the base id alone.
    expect(allocations).toEqual([
      { chargeId: "c-exp-base", allocatedAmount: "0.50" },
      { chargeId: "c-exp-sst", allocatedAmount: "0.04" },
    ]);
    const cents = allocations.reduce((c, a) => c + Math.round(Number(a.allocatedAmount) * 100), 0);
    expect(cents).toBe(54);
  });

  it("prints the BILL number, never the internal chargeNumber with its UUIDs", async () => {
    mockCharges([{ ...FOLDED_SST, documentNumber: "IVTEN-0002" }]);
    renderPage();

    await screen.findByText("test ten exp sst");
    expect(screen.getByText(/IVTEN-0002 · Due/)).toBeTruthy();
    // THE LEAK: this is what the tenant used to be shown.
    expect(screen.queryByText(/GRIDEXP-202608/)).toBeNull();
  });

  it("shows the due date alone when a charge is on no bill yet", async () => {
    // Never a UUID: a charge with no document renders the date and nothing else.
    mockCharges([{ ...FOLDED_SST, documentNumber: null }]);
    renderPage();

    await screen.findByText("test ten exp sst");
    expect(screen.queryByText(/GRIDEXP-202608/)).toBeNull();
    expect(screen.getByText(/^Due /)).toBeTruthy();
  });

  it("falls back to a self-allocation when the server sent no components", async () => {
    // An older API that did no folding also sends no merged outstanding, so
    // allocating the row against its own id is exactly right for that response.
    mockChargesWithFpx([OVERDUE], "TXN-B");

    const allocations = await payByFpxAndReadAllocations("April rent");

    expect(allocations).toEqual([{ chargeId: "c-overdue", allocatedAmount: "1200.50" }]);
  });
});
