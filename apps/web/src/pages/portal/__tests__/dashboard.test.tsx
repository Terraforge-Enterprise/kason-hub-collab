import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

const portalApiFetch = vi.fn();
vi.mock("@/lib/portal-api", () => ({
  portalApiFetch: (...a: unknown[]) => portalApiFetch(...a),
  PortalApiError: class extends Error {},
}));
import PortalDashboardPage from "../dashboard";

const base = {
  tenant: { displayName: "Rajesh", partyType: "individual" },
  lease: { tenancyCode: "TEN-2025-003", unitCode: "A-08-02", propertyName: "Seri Kembangan Heights", startDate: "2025-12-01", endDate: "2026-12-01", monthlyRentAmount: 1200, status: "active" },
  upcomingCharges: [{ id: "c1", chargeNumber: "IVTEN-0007", chargeType: "utility", amount: 100, debitNoteTotal: 0, creditNoteTotal: 0, adjustedAmount: 100, outstandingAmount: 100, dueDate: "2026-07-01", status: "posted" }],
  recentPayments: [],
  announcements: [],
  attention: { pendingVerificationPayments: [], rejectedPayments: [], hasMoreUnresolvedPayments: false },
  balance: { totalCharges: 2260, totalPayments: 1200, totalCredits: 960, netBalance: 100, unpaidCount: 1, overdueAmount: 0, overdueCount: 0, creditAvailable: 0, currency: "MYR" },
};
function renderHome(data: unknown) {
  portalApiFetch.mockResolvedValue({ data });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter><PortalDashboardPage /></MemoryRouter></QueryClientProvider>);
}
beforeEach(() => portalApiFetch.mockReset());

describe("Home redesign", () => {
  it("balance + pay cta", async () => {
    renderHome(base);
    expect(await screen.findByText("RM 100.00")).toBeTruthy();
    expect(screen.getByText(/1 unpaid item/i)).toBeTruthy();
    expect(screen.getByRole("link", { name: /Pay RM 100\.00/i })).toBeTruthy();
  });
  // The API caps `upcomingCharges` at 5 rows, so counting that array capped the
  // headline at "5 unpaid item(s)" no matter how many the tenant really had.
  // The count is now server-side and must be rendered verbatim.
  it("unpaid count comes from the server, not the capped upcomingCharges array", async () => {
    renderHome({
      ...base,
      upcomingCharges: Array.from({ length: 5 }, (_, i) => ({
        id: `c${i}`, chargeNumber: `IVTEN-000${i}`, chargeType: "utility",
        amount: 100, debitNoteTotal: 0, creditNoteTotal: 0, adjustedAmount: 100,
        outstandingAmount: 100, dueDate: "2026-07-01", status: "posted",
      })),
      balance: { ...base.balance, unpaidCount: 9 },
    });
    expect(await screen.findByText(/9 unpaid item/i)).toBeTruthy();
    expect(screen.queryByText(/5 unpaid item/i)).toBeNull();
  });

  it("no cta when clear", async () => {
    renderHome({ ...base, upcomingCharges: [], balance: { ...base.balance, netBalance: 0 } });
    expect(await screen.findByText(/Welcome back/i)).toBeTruthy();
    expect(screen.queryByRole("link", { name: /^Pay RM/i })).toBeNull();
  });
  it("quick actions removed", async () => {
    renderHome(base);
    await screen.findByText("RM 100.00");
    expect(screen.queryByText("Quick Actions")).toBeNull();
    expect(screen.queryByText("View Lease")).toBeNull();
  });
  it("next due + lease dates render", async () => {
    renderHome(base);
    expect(await screen.findByText("RM 100.00")).toBeTruthy();
    expect(screen.getByText(/1 Jul 2026/)).toBeTruthy();         // Next Due, formatDateMY (R5)
    expect(screen.getByText(/Ends 1 Dec 2026/)).toBeTruthy();    // Lease card (R5)
  });

  // The reported bug (2026-08-16): Home merged `upcomingCharges` and
  // `recentPayments` into one feed, both capped at 5 by the API — a tenant with
  // 6 charges + 1 payment saw 6 of their 7 rows and was told nothing, while the
  // Balance headline (an un-capped aggregate) above it stayed correct. The feed
  // was also a truncated copy of the Billing tab. It is gone; Home renders
  // exceptions, Billing renders the ledger.
  describe("Billing Activity feed removed", () => {
    it("does not render charge or payment list rows, however many the API sends", async () => {
      renderHome({
        ...base,
        upcomingCharges: Array.from({ length: 5 }, (_, i) => ({
          id: `c${i}`, chargeNumber: `IVTEN-100${i}`, chargeType: "utility",
          amount: 100, debitNoteTotal: 0, creditNoteTotal: 0, adjustedAmount: 100,
          outstandingAmount: 100, dueDate: "2026-07-01", status: "posted",
        })),
        recentPayments: [{ id: "p1", paymentNumber: "PAY-0013", amount: 1200, status: "posted", receivedAt: "2026-07-20" }],
        balance: { ...base.balance, netBalance: 500, unpaidCount: 12 },
      });
      await screen.findByText(/Welcome back/i);
      expect(screen.queryByText("Billing Activity")).toBeNull();
      expect(screen.queryByText("PAY-0013")).toBeNull();
      // Only the Next Due card reads upcomingCharges, and only index 0.
      expect(screen.queryByText(/IVTEN-1001/)).toBeNull();
      expect(screen.queryByText(/IVTEN-1002/)).toBeNull();
    });

    // The specific money bug the feed carried: every payment row rendered a
    // hardcoded emerald "Paid" badge, so an unverified slip — and a REJECTED
    // one — read as money received.
    it("never labels an unverified or rejected payment as Paid", async () => {
      renderHome({
        ...base,
        recentPayments: [
          { id: "p1", paymentNumber: "PAY-0013", amount: 800, status: "pending_approval", receivedAt: "2026-07-20" },
          { id: "p2", paymentNumber: "PAY-0014", amount: 500, status: "rejected", receivedAt: "2026-07-21" },
        ],
        attention: {
          pendingVerificationPayments: [{ id: "p1", paymentNumber: "PAY-0013", amount: 800, submittedAt: "2026-07-20" }],
          rejectedPayments: [{ id: "p2", paymentNumber: "PAY-0014", amount: 500, rejectionReason: "Slip is unreadable", submittedAt: "2026-07-21" }],
          hasMoreUnresolvedPayments: false,
        },
      });
      await screen.findByText(/Welcome back/i);
      expect(screen.queryByText("Paid")).toBeNull();
      expect(screen.getByText("Verifying")).toBeTruthy();
      expect(screen.getByText("Not accepted")).toBeTruthy();
    });
  });

  describe("Needs your attention", () => {
    it("is hidden entirely when there is nothing to act on", async () => {
      renderHome(base);
      await screen.findByText(/Welcome back/i);
      expect(screen.queryByText("Needs your attention")).toBeNull();
    });

    it("surfaces overdue from the server aggregate, not from a page of charges", async () => {
      renderHome({ ...base, balance: { ...base.balance, netBalance: 2800, unpaidCount: 28, overdueAmount: 2500, overdueCount: 25 } });
      await screen.findByText("Needs your attention");
      expect(screen.getByText("RM 2,500.00 overdue")).toBeTruthy();
      expect(screen.getByText("25 unpaid charges past due")).toBeTruthy();  // attention row
      expect(screen.getByText("25 charges past due")).toBeTruthy();          // Overdue card
      expect(screen.getByText("Pay now")).toBeTruthy();
    });

    it("names the office's reason on a refused slip", async () => {
      renderHome({
        ...base,
        attention: {
          pendingVerificationPayments: [],
          rejectedPayments: [{ id: "p2", paymentNumber: "PAY-0014", amount: 500, rejectionReason: "Slip is unreadable — please re-upload", submittedAt: "2026-07-21" }],
          hasMoreUnresolvedPayments: false,
        },
      });
      await screen.findByText("Needs your attention");
      expect(screen.getByText("Payment RM 500.00 wasn't accepted")).toBeTruthy();
      expect(screen.getByText("Slip is unreadable — please re-upload")).toBeTruthy();
    });

    // A "rejected" with no cause leaves the tenant unable to fix the thing we
    // are asking them to fix.
    it("falls back to actionable guidance when no reason was recorded", async () => {
      renderHome({
        ...base,
        attention: {
          pendingVerificationPayments: [],
          rejectedPayments: [{ id: "p2", paymentNumber: "PAY-0014", amount: 500, rejectionReason: null, submittedAt: "2026-07-21" }],
          hasMoreUnresolvedPayments: false,
        },
      });
      await screen.findByText("Needs your attention");
      expect(screen.getByText(/contact the office or submit a new slip/i)).toBeTruthy();
    });

    // Real dates relative to now, NOT vi.useFakeTimers() — fake timers stall
    // react-query's promise resolution, so the render never settles and every
    // subsequent test in the file times out too.
    // The server caps the payment lists. Home must SAY rows were withheld —
    // silently dropping them is the bug this whole section replaced.
    it("announces withheld payment rows instead of dropping them silently", async () => {
      renderHome({
        ...base,
        attention: {
          pendingVerificationPayments: [{ id: "p1", paymentNumber: "PAY-1", amount: 800, submittedAt: "2026-07-20" }],
          rejectedPayments: [],
          hasMoreUnresolvedPayments: true,
        },
      });
      await screen.findByText("Needs your attention");
      expect(screen.getByText("More payments need attention")).toBeTruthy();
      expect(screen.getByText("View all")).toBeTruthy();
    });

    it("stays quiet about overflow when nothing was withheld", async () => {
      renderHome({
        ...base,
        attention: {
          pendingVerificationPayments: [{ id: "p1", paymentNumber: "PAY-1", amount: 800, submittedAt: "2026-07-20" }],
          rejectedPayments: [],
          hasMoreUnresolvedPayments: false,
        },
      });
      await screen.findByText("Needs your attention");
      expect(screen.queryByText("More payments need attention")).toBeNull();
    });

    // tone and badgeVariant used to be independent fields that had drifted
    // here: an expired lease rendered an amber icon beside a rose badge.
    it("treats an expired lease as danger, not a warning", async () => {
      const yesterday = new Date(Date.now() - 86400000).toISOString();
      renderHome({ ...base, lease: { ...base.lease, endDate: yesterday } });
      await screen.findByText("Needs your attention");
      expect(screen.getByText("Lease has ended")).toBeTruthy();
      expect(screen.getByText("Ended")).toBeTruthy();
    });

    it("flags a lease inside the 60-day window", async () => {
      const in30Days = new Date(Date.now() + 30 * 86400000).toISOString();
      renderHome({ ...base, lease: { ...base.lease, endDate: in30Days } });
      await screen.findByText("Needs your attention");
      expect(screen.getByText(/^Lease ends in \d+ days$/)).toBeTruthy();
      expect(screen.getByText("Ending soon")).toBeTruthy();
    });

    it("stays quiet for a lease outside the window", async () => {
      const in400Days = new Date(Date.now() + 400 * 86400000).toISOString();
      renderHome({ ...base, lease: { ...base.lease, endDate: in400Days } });
      await screen.findByText(/Welcome back/i);
      expect(screen.queryByText("Needs your attention")).toBeNull();
    });
  });

  describe("details Home previously hid", () => {
    it("shows unspent credit, which was computed by the API but rendered nowhere", async () => {
      renderHome({ ...base, balance: { ...base.balance, creditAvailable: 250 } });
      await screen.findByText(/Welcome back/i);
      expect(screen.getByTestId("credit-available")).toBeTruthy();
      expect(screen.getByText("RM 250.00")).toBeTruthy();
    });

    it("hides the credit strip when there is none", async () => {
      renderHome(base);
      await screen.findByText(/Welcome back/i);
      expect(screen.queryByTestId("credit-available")).toBeNull();
    });

    it("shows monthly rent and tenancy code on the Lease card", async () => {
      renderHome(base);
      await screen.findByText(/Welcome back/i);
      expect(screen.getByText(/RM 1,200\.00\/month · TEN-2025-003/)).toBeTruthy();
    });

    it("shows an overdue card reading RM 0.00 when nothing is past due", async () => {
      renderHome(base);
      await screen.findByText(/Welcome back/i);
      expect(screen.getByText("Nothing past due")).toBeTruthy();
    });
  });

  // The reported bug (2026-08-07): a CN took RM 30 off a RM 400 charge — the
  // Balance card said the adjusted total while the row beside it still read the
  // raw RM 400. The feed that carried this explanation is gone, so the Next Due
  // card inherits it: an amount that silently moved is the confusion the note
  // totals exist to prevent.
  it("credited charge shows outstanding, not the raw amount, and names the credit note", async () => {
    renderHome({
      ...base,
      upcomingCharges: [{
        id: "c1", chargeNumber: "IVTEN-0007", chargeType: "utility",
        amount: 400, debitNoteTotal: 0, creditNoteTotal: 30, adjustedAmount: 370,
        outstandingAmount: 370, dueDate: "2026-07-01", status: "posted",
      }],
      balance: { ...base.balance, netBalance: 370 },
    });
    expect(await screen.findByText(/utility · RM 370\.00/)).toBeTruthy();    // Next Due card
    expect(screen.getByText(/credit note -RM 30\.00/i)).toBeTruthy();
    expect(screen.queryByText(/RM 400\.00/)).toBeNull();                     // raw amount gone
  });

  it("debit-noted charge shows the increased outstanding and names the debit note", async () => {
    renderHome({
      ...base,
      upcomingCharges: [{
        id: "c1", chargeNumber: "IVTEN-0009", chargeType: "recurring",
        amount: 150, debitNoteTotal: 30, creditNoteTotal: 0, adjustedAmount: 180,
        outstandingAmount: 180, dueDate: "2026-07-01", status: "posted",
      }],
      balance: { ...base.balance, netBalance: 180 },
    });
    expect(await screen.findByText(/recurring · RM 180\.00/)).toBeTruthy();
    expect(screen.getByText(/debit note \+RM 30\.00/i)).toBeTruthy();
    expect(screen.queryByText(/RM 150\.00/)).toBeNull();
  });
});
