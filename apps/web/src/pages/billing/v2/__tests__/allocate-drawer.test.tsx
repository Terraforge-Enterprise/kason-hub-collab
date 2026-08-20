import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const apiFetchMock = vi.hoisted(() => vi.fn());
const allocateBatchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-client", () => ({ apiFetch: apiFetchMock }));
vi.mock("@/api/payments", async (orig) => ({
  ...(await orig()),
  allocateBatch: allocateBatchMock,
}));

import { AllocateDrawer } from "../allocate-drawer";
import type { PaymentMenuRow } from "../payment-row-menu";

const wrap = (ui: React.ReactElement) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
};

// Payment being allocated against — amount minus allocatedTotal is the hard cap
// the drawer clamps to. Nothing previously allocated here, so the cap is the
// full 100.
const PAYMENT: PaymentMenuRow = {
  id: "pay-1",
  paymentNumber: "PAY-202607-001",
  partyId: "p1",
  status: "posted",
  amount: 100,
  currency: "MYR",
  hasBatchKey: false,
  allocatedTotal: 0,
};

// Same payment, but 60 already allocated (Finding 3, final-review fix wave) —
// remaining headroom is 100 - 60 = 40, not the full 100.
const PAYMENT_PARTIALLY_ALLOCATED: PaymentMenuRow = {
  ...PAYMENT,
  id: "pay-2",
  paymentNumber: "PAY-202607-002",
  allocatedTotal: 60,
};

// Payer's outstanding pool: c1 (outstanding 80) + c2 (outstanding 50) — Σ outstanding
// (130) exceeds payment.amount (100), which is exactly the scenario the headroom cap
// guards against.
const CHARGES = {
  data: [
    { id: "c1", chargeNumber: "RENT-202607", outstandingAmount: 80, amount: 80, currency: "MYR",
      partyName: "Ahmad", unitCode: "A-19-02", chargeType: "rent", status: "posted", displayStatus: "posted",
      tenancyCode: "T-1", dueDate: "2026-07-01", invoiceNumber: null, documentId: null, documentNumber: null, events: [] },
    { id: "c2", chargeNumber: "AC-202607", outstandingAmount: 50, amount: 50, currency: "MYR",
      partyName: "Ahmad", unitCode: "A-19-02", chargeType: "aircond", status: "posted", displayStatus: "posted",
      tenancyCode: "T-1", dueDate: "2026-07-31", invoiceNumber: null, documentId: null, documentNumber: null, events: [] },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  apiFetchMock.mockImplementation((url: string) => {
    if (url.includes("partyId=p1") && url.includes("outstandingOnly=true")) return Promise.resolve(CHARGES);
    return Promise.resolve({ data: [] });
  });
  allocateBatchMock.mockResolvedValue({ id: "alloc-1" });
});

describe("AllocateDrawer", () => {
  it("headroom cap on tick: c2's prefill caps at remaining headroom, Σ stays ≤ payment.amount", async () => {
    wrap(<AllocateDrawer payment={PAYMENT} onOpenChange={() => {}} />);

    await userEvent.click(await screen.findByRole("checkbox", { name: /RENT-202607/i }));
    expect(screen.getByLabelText(/amount for RENT-202607/i)).toHaveProperty("value", "80.00");

    await userEvent.click(screen.getByRole("checkbox", { name: /AC-202607/i }));
    // Remaining headroom is 100 - 80 = 20, not c2's full 50 outstanding.
    expect(screen.getByLabelText(/amount for AC-202607/i)).toHaveProperty("value", "20.00");

    const totalRow = screen.getByText(/selected total/i).parentElement!;
    expect(within(totalRow).getByText(/RM 100/)).toBeTruthy();
  });

  it("existing allocations: cap is remaining headroom, not the full payment.amount", async () => {
    wrap(<AllocateDrawer payment={PAYMENT_PARTIALLY_ALLOCATED} onOpenChange={() => {}} />);

    // Remaining headroom is 100 - 60 = 40; c1's outstanding (80) exceeds it, so
    // the tick prefills the headroom, not the charge's outstanding.
    await userEvent.click(await screen.findByRole("checkbox", { name: /RENT-202607/i }));
    expect(screen.getByLabelText(/amount for RENT-202607/i)).toHaveProperty("value", "40.00");

    const totalRow = screen.getByText(/selected total/i).parentElement!;
    expect(within(totalRow).getByText(/RM 40/)).toBeTruthy();
  });

  it("headroom cap on edit: editing c1 above outstanding clamps to outstanding (the binding cap)", async () => {
    wrap(<AllocateDrawer payment={PAYMENT} onOpenChange={() => {}} />);

    await userEvent.click(await screen.findByRole("checkbox", { name: /RENT-202607/i }));
    const amt = screen.getByLabelText(/amount for RENT-202607/i);
    await userEvent.clear(amt);
    await userEvent.type(amt, "999");
    (amt as HTMLInputElement).blur();

    // outstanding (80) is smaller than payment.amount (100) here, so outstanding —
    // not the payment cap — is what binds.
    await waitFor(() => expect((amt as HTMLInputElement).value).toBe("80.00"));
  });

  it("retry reuses idempotencyKey: rejected once then succeeds — both calls carry the same key", async () => {
    allocateBatchMock.mockRejectedValueOnce(new Error("network error"));
    wrap(<AllocateDrawer payment={PAYMENT} onOpenChange={() => {}} />);

    await userEvent.click(await screen.findByRole("checkbox", { name: /RENT-202607/i }));
    await userEvent.click(screen.getByRole("button", { name: /^allocate$/i }));
    await waitFor(() => expect(allocateBatchMock).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByRole("button", { name: /^allocate$/i }));
    await waitFor(() => expect(allocateBatchMock).toHaveBeenCalledTimes(2));

    expect(allocateBatchMock.mock.calls[0][1]).toBe(allocateBatchMock.mock.calls[1][1]);
  });

  it("disabled: nothing ticked → submit disabled", async () => {
    wrap(<AllocateDrawer payment={PAYMENT} onOpenChange={() => {}} />);
    await screen.findByRole("checkbox", { name: /RENT-202607/i });
    expect(screen.getByRole("button", { name: /^allocate$/i })).toHaveProperty("disabled", true);
  });
});
