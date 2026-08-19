import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// The two R9 receipt-action hooks are mocked so no network fires; `mutate` is
// asserted on. `useCorrectInvoice` is mocked too because the page mounts the
// CorrectInvoiceDrawer (the REFUND correction target) — Void ≠ Refund.
const reverseMutate = vi.fn();
const voidMutate = vi.fn();
vi.mock("../../../api/accounting", () => ({
  useReverseAllocation: () => ({ mutate: reverseMutate, isPending: false }),
  useVoidPayment: () => ({ mutate: voidMutate, isPending: false }),
  useCorrectInvoice: () => ({ mutate: vi.fn(), isPending: false }),
}));

// The receipts list (one receipt linked to a payment) + the correct-invoice
// drawer's document-detail fetch. Both routed through the same mocked module.
const RECEIPT = {
  id: "doc-1",
  docType: "receipt" as const,
  documentNumber: "RC-0001",
  partyName: "Tenant One",
  total: "100.00",
  paymentId: "pay-1",
};
vi.mock("../../../api/billing-documents", () => ({
  useBillingDocuments: (arg?: { docType?: string }) => ({
    data: arg?.docType === "receipt" ? { data: { items: [RECEIPT] } } : { data: { items: [] } },
    isLoading: false,
  }),
  useBillingDocument: (id: string | null) => ({
    data: id ? { data: { id, lines: [{ id: "l1", chargeId: "charge-1", description: "Rent", amount: "100.00" }] } } : undefined,
    isLoading: false,
  }),
  // The receipts page's filter controls query property options for the dropdown.
  usePropertyOptions: () => ({ data: [], isLoading: false }),
}));

// toast is mocked so the "409 renders inline, NOT a silent toast" assertion can
// prove no toast fired for the error path.
const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { error: toastError, success: vi.fn() } }));

// crypto.randomUUID must be deterministic so we can assert the generated key.
vi.stubGlobal("crypto", { randomUUID: () => "11111111-1111-4111-8111-111111111111" });

// api-client is mocked because ApiError is imported by the page for the 409 path.
vi.mock("@/lib/api-client", () => ({
  apiFetch: vi.fn(async () => ({ data: {} })),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
}));

async function mount() {
  const { default: AccountingReceiptsPage } = await import("../receipts-page");
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <AccountingReceiptsPage />
    </QueryClientProvider>,
  );
}

describe("Receipt row-actions (R9)", () => {
  beforeEach(() => {
    reverseMutate.mockReset();
    voidMutate.mockReset();
    toastError.mockReset();
  });

  it("reverse posts: confirming Reverse posts with a generated idempotencyKey + reason + allocationId", async () => {
    await mount();
    // Open the Reverse confirm dialog for the receipt row.
    fireEvent.click(screen.getByRole("button", { name: /reverse/i }));
    // The accountant supplies the allocation to reverse (not auto-resolvable from
    // the receipt DTO today) + a reason.
    fireEvent.change(screen.getByLabelText(/allocation id/i), {
      target: { value: "22222222-2222-4222-8222-222222222222" },
    });
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: "duplicate transfer" } });
    fireEvent.click(screen.getByRole("button", { name: /confirm reverse/i }));

    expect(reverseMutate).toHaveBeenCalledTimes(1);
    const body = reverseMutate.mock.calls[0][0];
    expect(body).toMatchObject({
      paymentId: "pay-1",
      allocationId: "22222222-2222-4222-8222-222222222222",
      reason: "duplicate transfer",
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("void puts status: confirming Void payment calls useVoidPayment.mutate with the paymentId (status void — never refunded)", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: /void payment/i }));
    fireEvent.click(screen.getByRole("button", { name: /confirm void/i }));

    expect(voidMutate).toHaveBeenCalledTimes(1);
    const body = voidMutate.mock.calls[0][0];
    expect(body).toMatchObject({ paymentId: "pay-1" });
    // Void ≠ Refund: the hook is the VOID hook; the mutate payload never carries
    // a "refunded" status (that path is the REFUND correction strategy).
    expect(JSON.stringify(body)).not.toContain("refunded");
    // The Reverse hook is untouched by a Void.
    expect(reverseMutate).not.toHaveBeenCalled();
  });

  it("409 inline: a 409 (in-flight FPX / stale) renders inline in the dialog, not a silent toast", async () => {
    const { ApiError } = await import("@/lib/api-client");
    // The void mutation rejects with a 409 by invoking the caller's onError.
    voidMutate.mockImplementation((_vars: unknown, opts?: { onError?: (e: Error) => void }) => {
      opts?.onError?.(new ApiError("This payment has an in-flight FPX attempt.", 409));
    });
    await mount();
    fireEvent.click(screen.getByRole("button", { name: /void payment/i }));
    fireEvent.click(screen.getByRole("button", { name: /confirm void/i }));

    // The 409 message is rendered INLINE (an alert region), and the dialog stays
    // open (the confirm button is still present) — never dismissed to a toast.
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/in-flight fpx/i);
    expect(screen.getByRole("button", { name: /confirm void/i })).toBeInTheDocument();
    await waitFor(() => expect(toastError).not.toHaveBeenCalled());
  });

  it("refund opens the REFUND correction flow (Void ≠ Refund): it does NOT call the void/reverse hooks", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: /^refund$/i }));
    // Refund routes to the REFUND correction strategy (CorrectInvoiceDrawer) —
    // it is never a raw payment-status change, so neither status/reverse hook fires.
    expect(voidMutate).not.toHaveBeenCalled();
    expect(reverseMutate).not.toHaveBeenCalled();
    // The correction drawer opened for THIS receipt, defaulting to REFUND — its
    // Refund sub-form fields (from CorrectInvoiceDrawer) are on screen.
    expect(await screen.findByLabelText(/refund amount/i)).toBeInTheDocument();
  });

  it("void disabled without paymentId: a receipt with no linked payment cannot confirm a void", async () => {
    // Re-render the ReceiptRowActions directly with a paymentId-less receipt.
    const { ReceiptRowActions } = await import("../receipt-row-actions");
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ReceiptRowActions doc={{ ...RECEIPT, paymentId: null } as never} onRefund={() => {}} />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /void payment/i }));
    // The confirm-void button is disabled (nothing to void) and firing it is a no-op.
    const confirm = screen.getByRole("button", { name: /confirm void/i });
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(voidMutate).not.toHaveBeenCalled();
  });
});
