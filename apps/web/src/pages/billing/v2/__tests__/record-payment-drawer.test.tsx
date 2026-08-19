import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const apiFetchMock = vi.hoisted(() => vi.fn());
const recordAndAllocateMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-client", () => ({ apiFetch: apiFetchMock }));
vi.mock("@/api/payments", async (orig) => ({
  ...(await orig()),
  recordAndAllocate: recordAndAllocateMock,
}));

import { RecordPaymentDrawer } from "../record-payment-drawer";

const wrap = (ui: React.ReactElement) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
};

const CHARGES = {
  data: [
    { id: "c1", chargeNumber: "RENT-202607", outstandingAmount: 1500, amount: 1500, currency: "MYR",
      partyName: "Ahmad", unitCode: "A-19-02", chargeType: "rent", status: "posted", displayStatus: "posted",
      tenancyCode: "T-1", dueDate: "2026-07-01", invoiceNumber: null, documentId: null, documentNumber: null, events: [] },
    { id: "c2", chargeNumber: "AC-202607", outstandingAmount: 90, amount: 90, currency: "MYR",
      partyName: "Ahmad", unitCode: "A-19-02", chargeType: "aircond", status: "posted", displayStatus: "posted",
      tenancyCode: "T-1", dueDate: "2026-07-31", invoiceNumber: null, documentId: null, documentNumber: null, events: [] },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  apiFetchMock.mockImplementation((url: string) => {
    if (url.startsWith("/parties/tenants")) return Promise.resolve({ data: [{ id: "p1", displayName: "Ahmad" }] });
    if (url.includes("outstandingOnly=true")) return Promise.resolve(CHARGES);
    return Promise.resolve({ data: [] });
  });
  recordAndAllocateMock.mockResolvedValue({ id: "pay-1" });
});

async function pickPayerAndCharges() {
  await userEvent.selectOptions(await screen.findByLabelText(/payer/i), "p1");
  await userEvent.click(await screen.findByRole("checkbox", { name: /RENT-202607/i }));
  await userEvent.click(screen.getByRole("checkbox", { name: /AC-202607/i }));
}

describe("RecordPaymentDrawer", () => {
  it("happy path: total = Σ prefilled, submits 2 lines + idempotencyKey", async () => {
    wrap(<RecordPaymentDrawer open onOpenChange={() => {}} />);
    await pickPayerAndCharges();
    expect(screen.getByText(/1,590/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /record & allocate/i }));
    await waitFor(() => expect(recordAndAllocateMock).toHaveBeenCalledTimes(1));
    const body = recordAndAllocateMock.mock.calls[0][0];
    expect(body.partyId).toBe("p1");
    expect(body.allocations).toEqual([
      { chargeId: "c1", allocatedAmount: "1500.00" },
      { chargeId: "c2", allocatedAmount: "90.00" },
    ]);
    expect(body.idempotencyKey).toMatch(/[0-9a-f-]{36}/);
  });

  it("disabled: no charges ticked → submit disabled", async () => {
    wrap(<RecordPaymentDrawer open onOpenChange={() => {}} />);
    await userEvent.selectOptions(await screen.findByLabelText(/payer/i), "p1");
    await screen.findByRole("checkbox", { name: /RENT-202607/i });
    expect(screen.getByRole("button", { name: /record & allocate/i })).toHaveProperty("disabled", true);
  });

  it("clamp: editing above outstanding clamps to outstanding", async () => {
    wrap(<RecordPaymentDrawer open onOpenChange={() => {}} />);
    await pickPayerAndCharges();
    const amt = screen.getByLabelText(/amount for RENT-202607/i);
    await userEvent.clear(amt);
    await userEvent.type(amt, "9999");
    (amt as HTMLInputElement).blur();
    await waitFor(() => expect((amt as HTMLInputElement).value).toBe("1500.00"));
  });

  it("retry reuses key: first 409 then success — same idempotencyKey both times", async () => {
    recordAndAllocateMock.mockRejectedValueOnce(new Error("conflict"));
    wrap(<RecordPaymentDrawer open onOpenChange={() => {}} />);
    await pickPayerAndCharges();
    await userEvent.click(screen.getByRole("button", { name: /record & allocate/i }));
    await waitFor(() => expect(recordAndAllocateMock).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole("button", { name: /record & allocate/i }));
    await waitFor(() => expect(recordAndAllocateMock).toHaveBeenCalledTimes(2));
    expect(recordAndAllocateMock.mock.calls[0][0].idempotencyKey)
      .toBe(recordAndAllocateMock.mock.calls[1][0].idempotencyKey);
  });

  describe("receivedAt (final-review fix wave — local-time prefill + invalid-date guard)", () => {
    const ORIGINAL_TZ = process.env.TZ;

    afterEach(() => {
      process.env.TZ = ORIGINAL_TZ;
      vi.useRealTimers();
    });

    it("prefill: shows LOCAL wall-time, not UTC (8pm UTC on Jul 1 in MYT is 4am Jul 2)", async () => {
      process.env.TZ = "Asia/Kuala_Lumpur"; // UTC+8, no DST
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-01T20:00:00.000Z"));

      wrap(<RecordPaymentDrawer open onOpenChange={() => {}} />);
      const receivedAt = screen.getByLabelText(/received at/i) as HTMLInputElement;
      // Old `new Date().toISOString().slice(0,16)` would show "2026-07-01T20:00"
      // (UTC wall-time, 8h early and the wrong DAY). Local wall-time is Jul 2, 04:00.
      expect(receivedAt.value).toBe("2026-07-02T04:00");
    });

    it("guard: empty receivedAt disables submit (avoids the Invalid time value crash-toast)", async () => {
      wrap(<RecordPaymentDrawer open onOpenChange={() => {}} />);
      await pickPayerAndCharges();
      const receivedAt = screen.getByLabelText(/received at/i);
      fireEvent.change(receivedAt, { target: { value: "" } });
      expect(screen.getByRole("button", { name: /record & allocate/i })).toHaveProperty("disabled", true);
    });
  });
});
