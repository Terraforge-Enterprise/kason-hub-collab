import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

const apiFetchMock = vi.hoisted(() => vi.fn());
const postPaymentMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-client", () => ({ apiFetch: apiFetchMock }));
vi.mock("@/api/payments", async (orig) => ({
  ...(await orig()),
  postPayment: postPaymentMock,
  ENABLE_FPX: true,
  listInFlightFpx: vi.fn().mockResolvedValue({ data: [] }),
}));
vi.mock("@/lib/feature-flags", () => ({ isPhase2FlagEnabled: () => true }));

import PaymentsPageV2 from "../payments-page-v2";

function pay(id: string, over: Record<string, unknown> = {}) {
  return {
    id, paymentNumber: `PAY-${id}`, partyId: "p1", partyName: "Ahmad",
    paymentType: "rental_payment", paymentMethod: "fpx", status: "posted",
    amount: 1500, currency: "MYR", receivedAt: "2026-06-30T05:53:00.000Z",
    // Fully allocated + no batch key by default — realistic for a settled FPX/
    // record-and-allocate payment (Finding 2, final-review fix wave).
    hasBatchKey: false,
    historySummary: [], allocations: [{ id: "al1", chargeNumber: "RENT-1", allocatedAmount: 1500, allocatedAt: "2026-06-30T05:53:00.000Z" }],
    ...over,
  };
}

const SUMMARY = { receivedTotal: 7830, unallocatedCount: 1, pendingApprovalCount: 1, inFlightFpxCount: 0 };

function mockPages() {
  apiFetchMock.mockImplementation((url: string) => {
    if (url.startsWith("/payments/summary")) return Promise.resolve(SUMMARY);
    if (url.startsWith("/payments?") || url === "/payments") {
      if (url.includes("cursor=")) return Promise.resolve({ data: [pay("3")], nextCursor: null });
      return Promise.resolve({ data: [pay("1"), pay("2", { status: "pending_approval" })], nextCursor: "2026-06-29T00:00:00.000Z|2" });
    }
    return Promise.resolve({ data: [] });
  });
}

const wrap = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}><MemoryRouter><PaymentsPageV2 /></MemoryRouter></QueryClientProvider>,
  );
};

beforeEach(() => { apiFetchMock.mockReset(); postPaymentMock.mockReset().mockResolvedValue({}); mockPages(); });

describe("PaymentsPageV2", () => {
  it("cursor: Load more fetches with cursor= and appends", async () => {
    wrap();
    await waitFor(() => expect(screen.getByText("PAY-1")).toBeTruthy());
    await userEvent.click(screen.getByRole("button", { name: /load more/i }));
    await waitFor(() => expect(screen.getByText("PAY-3")).toBeTruthy());
    const cursorCall = apiFetchMock.mock.calls.find(([u]) => String(u).includes("cursor="));
    expect(cursorCall).toBeTruthy();
    expect(screen.getByText("PAY-1")).toBeTruthy(); // still there — appended, not replaced
  });

  it("approve: only pending_approval rows offer Approve; confirm calls postPayment", async () => {
    wrap();
    await waitFor(() => expect(screen.getByText("PAY-2")).toBeTruthy());
    await userEvent.click(screen.getByRole("button", { name: /payment actions for PAY-2/i }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /approve/i }));
    await userEvent.click(screen.getByRole("button", { name: /approve payment/i }));
    await waitFor(() => expect(postPaymentMock).toHaveBeenCalledWith("2"));
    await userEvent.click(screen.getByRole("button", { name: /payment actions for PAY-1/i }));
    expect(screen.queryByRole("menuitem", { name: /approve/i })).toBeNull();
  });

  it("void: reason captured and sent as note", async () => {
    wrap();
    await waitFor(() => expect(screen.getByText("PAY-1")).toBeTruthy());
    await userEvent.click(screen.getByRole("button", { name: /payment actions for PAY-1/i }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /void/i }));
    await userEvent.type(screen.getByLabelText(/reason/i), "duplicate entry");
    await userEvent.click(screen.getByRole("button", { name: /void payment/i }));
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith(
        "/payments/1/status",
        expect.objectContaining({ method: "PUT", body: JSON.stringify({ status: "void", note: "duplicate entry" }) }),
      ),
    );
  });

  it("fpx hidden: zero in-flight rows renders no FPX card", async () => {
    wrap();
    await waitFor(() => expect(screen.getByText("PAY-1")).toBeTruthy());
    expect(screen.queryByText(/in-flight fpx/i)).toBeNull();
  });

  it("allocate scoping: absent when hasBatchKey, present for a legacy unallocated posted row", async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url.startsWith("/payments/summary")) return Promise.resolve(SUMMARY);
      if (url.startsWith("/payments?") || url === "/payments") {
        return Promise.resolve({
          data: [
            // Legacy posted row: no batch key claimed yet, nothing allocated —
            // Allocate… must be offered.
            pay("4", { hasBatchKey: false, allocations: [] }),
            // Already claimed a batch key (record-and-allocate / settled FPX) —
            // a further allocate-batch attempt 409s, so Allocate… must be hidden
            // even though this row isn't fully allocated either.
            pay("5", { hasBatchKey: true, allocations: [] }),
          ],
          nextCursor: null,
        });
      }
      return Promise.resolve({ data: [] });
    });

    wrap();
    await waitFor(() => expect(screen.getByText("PAY-4")).toBeTruthy());

    await userEvent.click(screen.getByRole("button", { name: /payment actions for PAY-4/i }));
    expect(await screen.findByRole("menuitem", { name: /allocate/i })).toBeTruthy();
    await userEvent.keyboard("{Escape}");

    await userEvent.click(screen.getByRole("button", { name: /payment actions for PAY-5/i }));
    await screen.findByRole("menuitem", { name: /void/i }); // menu is open
    expect(screen.queryByRole("menuitem", { name: /allocate/i })).toBeNull();
  });

  it("allocation row: shows documentNumber when present, falls back to chargeNumber when null", async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url.startsWith("/payments/summary")) return Promise.resolve(SUMMARY);
      if (url.startsWith("/payments?") || url === "/payments") {
        return Promise.resolve({
          data: [
            pay("1", {
              allocations: [
                // Minted document (DEP-0011) — must show INSTEAD of the raw charge number.
                { id: "al1", chargeNumber: "RENT-1", documentNumber: "DEP-0011", allocatedAmount: 1300, allocatedAt: "2026-06-30T05:53:00.000Z" },
                // No minted document yet — must fall back to the raw charge number, never blank.
                { id: "al2", chargeNumber: "RENT-2", documentNumber: null, allocatedAmount: 200, allocatedAt: "2026-06-30T05:53:00.000Z" },
              ],
            }),
          ],
          nextCursor: null,
        });
      }
      return Promise.resolve({ data: [] });
    });

    wrap();
    await waitFor(() => expect(screen.getByText("PAY-1")).toBeTruthy());
    await userEvent.click(screen.getByText("PAY-1")); // expand <details> to reveal allocations

    expect(await screen.findByText(/DEP-0011/)).toBeTruthy();
    expect(screen.queryByText(/RENT-1/)).toBeNull(); // documentNumber wins over the raw charge number
    expect(await screen.findByText(/RENT-2/)).toBeTruthy(); // no doc → falls back to chargeNumber
  });
});
