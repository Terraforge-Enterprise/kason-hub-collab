import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CorrectInvoiceDrawer } from "../correct-invoice-drawer";

// The mutation is mocked so no network fires; `mutate` is asserted on. The
// wizard now also imports uploadSlipProof/deleteSlipProof from this module for
// the REFUND proof — stub them so the module resolves.
const mutate = vi.fn();
const uploadSlipProof = vi.fn(async (_file: File) => "orgs/o/refund-proofs/slip.jpg");
const deleteSlipProof = vi.fn(async (_key: string) => {});
vi.mock("../../../api/accounting", () => ({
  useCorrectInvoice: () => ({ mutate, isPending: false }),
  uploadSlipProof: (file: File) => uploadSlipProof(file),
  deleteSlipProof: (key: string) => deleteSlipProof(key),
}));

// The drawer resolves the charge id from the document detail's lines and the
// party id for the open-charges lookup that derives COLLECTED.
vi.mock("../../../api/billing-documents", () => ({
  useBillingDocument: (id: string | null) => ({
    data: id
      ? {
          data: {
            id,
            partyId: "party-1",
            lines: [
              { id: "l1", chargeId: "charge-1", description: "Rent", amount: "400.00", categoryName: "Rent" },
            ],
          },
        }
      : undefined,
    isLoading: false,
  }),
}));

// COLLECTED = total − outstandingAmount, floored at 0. With total 400 and the
// charge outstanding 150, collected = 250, balance = 150.
vi.mock("../../../api/charges", () => ({
  usePartyOpenCharges: (partyId: string | null) => ({
    data: partyId ? [{ id: "charge-1", outstandingAmount: 150 }] : undefined,
    isLoading: false,
  }),
}));

// Replacement grid categories.
vi.mock("../../../api/charge-categories", () => ({
  useChargeCategories: () => ({ data: { items: [{ id: "cat-1", name: "Rent" }] }, isLoading: false }),
}));

vi.mock("@/lib/api-client", () => ({
  apiFetch: vi.fn(async () => ({ data: {} })),
  ApiError: class ApiError extends Error {},
}));

const doc = {
  id: "doc-1",
  documentNumber: "INV-0001",
  partyName: "Tenant One",
  total: "400.00",
} as never;

function renderDrawer(props: Record<string, unknown> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CorrectInvoiceDrawer doc={doc} onClose={() => {}} {...props} />
    </QueryClientProvider>,
  );
}

describe("CorrectInvoiceDrawer (R9 problem-first wizard)", () => {
  beforeEach(() => {
    mutate.mockClear();
    uploadSlipProof.mockClear();
    deleteSlipProof.mockClear();
  });

  it("STEP 1 lists the four plain-language problems (each maps to a strategy)", () => {
    renderDrawer();
    expect(screen.getByLabelText(/charged too much|cancel this charge/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/charged too little/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/details are wrong/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/money back/i)).toBeInTheDocument();
  });

  it("context header shows Billed / Collected / Balance and the payment warning", () => {
    renderDrawer();
    // The three money labels are present in the context header.
    expect(screen.getByText("Billed")).toBeInTheDocument();
    expect(screen.getByText("Collected")).toBeInTheDocument();
    expect(screen.getByText("Balance")).toBeInTheDocument();
    // Billed 400.00; collected 250.00 (400 − 150 outstanding); balance 150.00.
    // The Billed/Balance amounts are unique to the header; Collected (250.00) also
    // appears in the warning copy, so assert it appears at least once.
    expect(screen.getByText("RM400.00")).toBeInTheDocument();
    expect(screen.getByText("RM150.00")).toBeInTheDocument();
    expect(screen.getAllByText(/250\.00/).length).toBeGreaterThan(0);
    // A payment is recorded → warning callout up-front (step 1).
    expect(screen.getByText(/a payment is recorded/i)).toBeInTheDocument();
  });

  it("picking 'bill more' routes to DEBIT_ADJUSTMENT and posts that strategy", () => {
    renderDrawer();
    // STEP 1 → choose the too-little problem, advancing to STEP 2.
    fireEvent.click(screen.getByLabelText(/charged too little/i));
    // Effect preview appears (Debit Note), computed from collected/balance.
    expect(screen.getByText(/issues a debit note/i)).toBeInTheDocument();
    // Fill the branch fields.
    fireEvent.change(screen.getByLabelText(/adjustment amount/i), { target: { value: "50.00" } });
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: "under-billed by RM50" } });
    // Submit label is strategy-specific.
    fireEvent.click(screen.getByRole("button", { name: /issue debit note/i }));

    expect(mutate).toHaveBeenCalledTimes(1);
    const body = mutate.mock.calls[0][0];
    expect(body).toMatchObject({
      chargeId: "charge-1",
      strategy: "DEBIT_ADJUSTMENT",
      reason: "under-billed by RM50",
      adjustmentAmount: "50.00",
    });
  });

  it("picking 'charged too much' routes to CREDIT_ADJUSTMENT with the credit-note preview", () => {
    renderDrawer();
    fireEvent.click(screen.getByLabelText(/charged too much|cancel this charge/i));
    // Credit preview mentions the collected amount becoming tenant credit.
    expect(screen.getByText(/issues a credit note/i)).toBeInTheDocument();
    expect(screen.getByText(/becomes tenant credit/i)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: "over-charged the tenant" } });
    fireEvent.click(screen.getByRole("button", { name: /issue credit note/i }));

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0]).toMatchObject({
      chargeId: "charge-1",
      strategy: "CREDIT_ADJUSTMENT",
      reason: "over-charged the tenant",
    });
    // No absent-strategy path: a strategy is always sent.
    expect(mutate.mock.calls[0][0].strategy).toBeTruthy();
  });

  it("empty reason blocks: submit is disabled and no post fires with an empty reason", () => {
    renderDrawer();
    fireEvent.click(screen.getByLabelText(/charged too much|cancel this charge/i));
    const submit = screen.getByRole("button", { name: /issue credit note/i });
    expect(submit).toBeDisabled();
    fireEvent.click(submit);
    expect(mutate).not.toHaveBeenCalled();
  });

  it("defaultStrategy=REFUND opens straight on the refund step with its fields", () => {
    renderDrawer({ defaultStrategy: "REFUND" });
    // No STEP-1 click needed — Refund fields are on screen immediately.
    expect(screen.getByLabelText(/refund amount/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/refund method/i)).toBeInTheDocument();
    // Effect preview for refund.
    expect(screen.getByText(/refund note/i)).toBeInTheDocument();
  });

  it("refund over collected is blocked with a guard message and disabled submit", () => {
    renderDrawer({ defaultStrategy: "REFUND" });
    // Collected is 250; asking for 300 exceeds it.
    fireEvent.change(screen.getByLabelText(/refund amount/i), { target: { value: "300" } });
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: "tenant requested full refund" } });
    expect(screen.getByText(/exceeds the amount collected/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /issue refund/i })).toBeDisabled();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("refund submit is gated behind a confirm dialog naming amount + payer", () => {
    renderDrawer({ defaultStrategy: "REFUND" });
    fireEvent.change(screen.getByLabelText(/refund amount/i), { target: { value: "100.00" } });
    fireEvent.change(screen.getByLabelText(/refunded on/i), { target: { value: "2026-07-17" } });
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: "tenant requested partial refund" } });
    // Clicking the primary opens the confirm dialog — it does NOT post yet.
    fireEvent.click(screen.getByRole("button", { name: /issue refund/i }));
    expect(mutate).not.toHaveBeenCalled();
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText(/tenant one/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/RM100\.00/)).toBeInTheDocument();
    // Confirming issues the refund with the strategy + amount.
    fireEvent.click(within(dialog).getByRole("button", { name: /issue refund/i }));
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0]).toMatchObject({
      chargeId: "charge-1",
      strategy: "REFUND",
      refund: expect.objectContaining({ amount: "100.00", method: "bank_transfer", refundedAt: "2026-07-17" }),
    });
  });
});
