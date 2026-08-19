import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

vi.mock("@/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-client")>();
  return { ...actual, apiFetch: vi.fn() };
});
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { apiFetch } from "@/lib/api-client";
import { VoidChargeDialog } from "../void-charge-dialog";

const apiFetchMock = vi.mocked(apiFetch);

function renderDialog(status: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={qc}>
      <VoidChargeDialog charge={{ id: "charge-1", chargeNumber: "RENT-1", status }} onClose={onClose} />
    </QueryClientProvider>,
  );
  return { onClose };
}

describe("VoidChargeDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiFetchMock.mockResolvedValue({ id: "charge-1", creditNoteNumber: "CN-0001" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posted (unpaid) charge: no three-way fork, reason required, posts {reason}", async () => {
    renderDialog("posted");
    expect(screen.queryByLabelText(/hold as credit/i)).toBeNull(); // no fork for unpaid
    const confirm = screen.getByRole("button", { name: /void & issue credit note/i });
    expect(confirm).toBeDisabled(); // reason empty
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: "wrong amount" } });
    expect(confirm).not.toBeDisabled();
    fireEvent.click(confirm);
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    const [path, opts] = apiFetchMock.mock.calls[0]!;
    expect(path).toBe("/billing/charges/charge-1/void");
    expect(JSON.parse((opts as RequestInit).body as string)).toEqual({ reason: "wrong amount" });
  });

  it("partially_paid charge: shows the three-way fork; refund choice reveals refund fields and posts them", async () => {
    renderDialog("partially_paid");
    // Fork visible
    expect(screen.getByLabelText(/recorded in error/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/hold as credit/i)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/money returned/i));
    fireEvent.change(screen.getByLabelText(/refund amount/i), { target: { value: "40.00" } });
    fireEvent.change(screen.getByLabelText(/refund method/i), { target: { value: "bank_transfer" } });
    fireEvent.change(screen.getByLabelText(/refunded on/i), { target: { value: "2026-07-02" } });
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: "tenant refunded" } });
    fireEvent.click(screen.getByRole("button", { name: /void & issue credit note/i }));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    const body = JSON.parse((apiFetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.paidHandling).toBe("refund");
    expect(body.refund).toMatchObject({ amount: "40.00", method: "bank_transfer", refundedAt: "2026-07-02" });
  });

  it("recorded-in-error choice disables submit and points at the payments page", () => {
    renderDialog("paid");
    fireEvent.click(screen.getByLabelText(/recorded in error/i));
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: "mark-paid mistake" } });
    expect(screen.getByRole("button", { name: /void & issue credit note/i })).toBeDisabled();
    expect(screen.getByText(/revert the payment record first/i)).toBeInTheDocument();
  });

  // Critical review finding: the dialog is mounted ONCE by charges-forms.tsx
  // with no `key`, so it never unmounts between charges — every OTHER test
  // in this file mounts fresh via renderDialog(), which is exactly why the
  // stale-state bug slipped past review. This test mounts once and switches
  // the `charge` prop via rerender to reproduce the real mount pattern.
  it("resets ALL internal state when the target charge changes — no stale carry-over across charges", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const onClose = vi.fn();
    const chargeA = { id: "charge-1", chargeNumber: "RENT-1", status: "partially_paid" };
    const chargeB = { id: "charge-2", chargeNumber: "RENT-2", status: "partially_paid" };

    const { rerender } = render(
      <QueryClientProvider client={qc}>
        <VoidChargeDialog charge={chargeA} onClose={onClose} />
      </QueryClientProvider>,
    );

    // Fill in every field for charge A.
    fireEvent.click(screen.getByLabelText(/money returned/i));
    fireEvent.change(screen.getByLabelText(/refund amount/i), { target: { value: "40.00" } });
    fireEvent.change(screen.getByLabelText(/refund method/i), { target: { value: "cash" } });
    fireEvent.change(screen.getByLabelText(/bank reference/i), { target: { value: "REF-123" } });
    fireEvent.change(screen.getByLabelText(/refunded on/i), { target: { value: "2026-07-01" } });
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: "tenant refunded in error" } });
    expect(screen.getByLabelText(/money returned/i)).toBeChecked();
    expect(screen.getByLabelText(/reason/i)).toHaveValue("tenant refunded in error");

    // Close (parent would setVoidTarget(null))...
    rerender(
      <QueryClientProvider client={qc}>
        <VoidChargeDialog charge={null} onClose={onClose} />
      </QueryClientProvider>,
    );
    // ...then reopen with a DIFFERENT charge — same mounted component instance,
    // exactly like the real charges-forms.tsx mount (no `key`).
    rerender(
      <QueryClientProvider client={qc}>
        <VoidChargeDialog charge={chargeB} onClose={onClose} />
      </QueryClientProvider>,
    );

    // Handling fork back to its default, and the refund-only fields are gone
    // (would still be showing "cash"/"REF-123"/etc. if handling had leaked).
    expect(screen.getByLabelText(/hold as credit/i)).toBeChecked();
    expect(screen.queryByLabelText(/refund amount/i)).toBeNull();
    expect(screen.getByLabelText(/reason/i)).toHaveValue("");

    // Switch back to "money returned" for charge B and confirm every refund
    // field is back to its OWN default, not charge A's leftover values.
    fireEvent.click(screen.getByLabelText(/money returned/i));
    expect(screen.getByLabelText(/refund amount/i)).toHaveValue(null);
    expect(screen.getByLabelText(/refund method/i)).toHaveValue("bank_transfer");
    expect(screen.getByLabelText(/bank reference/i)).toHaveValue("");
    expect(screen.getByLabelText(/refunded on/i)).toHaveValue("");
  });

  // Important review finding (no-orphan-storage rule): uploadRefundProof
  // persists the file BEFORE the void request goes out. If the void request
  // then fails, the already-uploaded object would otherwise orphan in
  // storage forever.
  it("void request failure after a successful proof upload fires best-effort cleanup of the uploaded key", async () => {
    const uploadedKey = "orgs/o1/refund-proofs/abc-slip.pdf";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { key: uploadedKey } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    apiFetchMock.mockRejectedValueOnce(new Error("REVERT_PAYMENT_FIRST"));

    renderDialog("partially_paid");
    fireEvent.click(screen.getByLabelText(/money returned/i));
    fireEvent.change(screen.getByLabelText(/refund amount/i), { target: { value: "40.00" } });
    fireEvent.change(screen.getByLabelText(/refund method/i), { target: { value: "bank_transfer" } });
    fireEvent.change(screen.getByLabelText(/refunded on/i), { target: { value: "2026-07-02" } });
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: "tenant refunded" } });
    const file = new File(["slip-bytes"], "slip.pdf", { type: "application/pdf" });
    fireEvent.change(screen.getByLabelText(/transfer slip/i), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: /void & issue credit note/i }));

    // 1st apiFetch call = the (rejected) void POST; 2nd = the cleanup DELETE.
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(2));
    const [deletePath, deleteOpts] = apiFetchMock.mock.calls[1]!;
    expect(deletePath).toBe("/billing-documents/refund-proofs");
    expect((deleteOpts as RequestInit).method).toBe("DELETE");
    expect(JSON.parse((deleteOpts as RequestInit).body as string)).toEqual({ key: uploadedKey });
  });
});
