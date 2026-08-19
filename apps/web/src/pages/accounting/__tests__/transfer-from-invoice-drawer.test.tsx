import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const recordMutate = vi.fn();
const uploadSlip = vi.fn(async (_file: File) => "orgs/o/refund-proofs/slip.jpg");
const deleteSlip = vi.fn(async (_key: string) => {});
vi.mock("../../../api/accounting", () => ({
  useRecordInvoicePayment: () => ({ mutateAsync: recordMutate, isPending: false }),
  uploadSlipProof: (file: File) => uploadSlip(file),
  deleteSlipProof: (key: string) => deleteSlip(key),
}));

// IVOWN-0008: Cleaning RM100 + WiFi RM150 (two 1:1 charges), RM250 outstanding.
vi.mock("../../../api/billing-documents", () => ({
  useBillingDocument: () => ({
    data: { data: {
      id: "d8", partyId: "party-8", partyName: "Puan Tan Mei Ling",
      documentNumber: "IVOWN-0008", counterpartyType: "owner",
      amountPaid: "0.00", balance: "250.00",
      lines: [
        { id: "l1", chargeId: "ch1", description: "Cleaning 202607", amount: "100.00", sstRate: "0", sstAmount: "0.00", categoryName: "Cleaning", paid: "0.00", outstanding: "100.00" },
        { id: "l2", chargeId: "ch2", description: "WiFi 202607", amount: "150.00", sstRate: "0", sstAmount: "0.00", categoryName: "WiFi", paid: "0.00", outstanding: "150.00" },
      ],
    } },
  }),
}));

beforeEach(() => { recordMutate.mockReset(); uploadSlip.mockClear(); deleteSlip.mockClear(); });

async function mount() {
  const { TransferFromInvoiceDrawer } = await import("../transfer-from-invoice-drawer");
  const qc = new QueryClient();
  render(
    <QueryClientProvider client={qc}>
      <TransferFromInvoiceDrawer open documentId="d8" onClose={() => {}} />
    </QueryClientProvider>,
  );
}

const payCleaning = () => screen.getByLabelText(/pay now for Cleaning/i) as HTMLInputElement;
const payWifi = () => screen.getByLabelText(/pay now for WiFi/i) as HTMLInputElement;
const submitBtn = () => screen.getByRole("button", { name: /^record payment$/i }) as HTMLButtonElement;
const slipInput = () => screen.getByLabelText(/transfer slip/i);
const total = () => screen.getByTestId("payment-total");
const remaining = () => screen.getByTestId("remaining-balance");

function attachSlip() {
  const file = new File(["x"], "slip.jpg", { type: "image/jpeg" });
  fireEvent.change(slipInput(), { target: { files: [file] } });
}

async function submitViaConfirm() {
  fireEvent.click(submitBtn());
  await waitFor(() => screen.getByRole("button", { name: /record receipt/i }));
  fireEvent.click(screen.getByRole("button", { name: /record receipt/i }));
}

describe("Record payment (Pay-now model)", () => {
  it("uses a compact header and has NO separate Amount received field", async () => {
    await mount();
    expect(screen.getByText(/Record payment — IVOWN-0008/i)).toBeInTheDocument();
    // Compact header subtitle: payer + outstanding in one line (not three big sections).
    expect(screen.getByText(/Puan Tan Mei Ling/i).textContent).toMatch(/Outstanding.*RM\s?250\.00/);
    // The Amount received anchor field is gone.
    expect(screen.queryByLabelText(/amount received/i)).toBeNull();
  });

  it("payment total is the sum of line allocations; remaining updates live", async () => {
    await mount();
    expect(total()).toHaveTextContent(/RM\s?0\.00/);
    expect(remaining()).toHaveTextContent(/RM\s?250\.00/);
    fireEvent.change(payCleaning(), { target: { value: "40" } });
    fireEvent.change(payWifi(), { target: { value: "150" } });
    expect(total()).toHaveTextContent(/RM\s?190\.00/);
    expect(remaining()).toHaveTextContent(/RM\s?60\.00/);
  });

  it("one line can be paid partially", async () => {
    await mount();
    fireEvent.change(payCleaning(), { target: { value: "40" } });
    expect(total()).toHaveTextContent(/RM\s?40\.00/);
    attachSlip();
    expect(submitBtn().disabled).toBe(false);
  });

  it("one line can be paid in full", async () => {
    await mount();
    fireEvent.change(payWifi(), { target: { value: "150" } });
    expect(total()).toHaveTextContent(/RM\s?150\.00/);
    attachSlip();
    expect(submitBtn().disabled).toBe(false);
  });

  it("Pay all fills every line with its outstanding (total = invoice balance)", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: /pay all/i }));
    expect(payCleaning().value).toBe("100.00");
    expect(payWifi().value).toBe("150.00");
    expect(total()).toHaveTextContent(/RM\s?250\.00/);
    expect(remaining()).toHaveTextContent(/RM\s?0\.00/);
  });

  it("Clear resets every Pay now", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: /pay all/i }));
    fireEvent.click(screen.getByRole("button", { name: /clear/i }));
    expect(payCleaning().value).toBe("");
    expect(payWifi().value).toBe("");
    expect(total()).toHaveTextContent(/RM\s?0\.00/);
  });

  it("blocks a Pay now that exceeds the line's outstanding", async () => {
    await mount();
    fireEvent.change(payCleaning(), { target: { value: "200" } });
    attachSlip();
    const cell = payCleaning().closest("td")!;
    expect(within(cell).getByText(/cannot exceed outstanding/i)).toBeInTheDocument();
    expect(submitBtn().disabled).toBe(true);
  });

  it("a zero-allocation form cannot be submitted", async () => {
    await mount();
    attachSlip(); // even with a slip, nothing to pay → disabled
    expect(submitBtn().disabled).toBe(true);
    expect(screen.getByText(/enter an amount to pay/i)).toBeInTheDocument();
  });

  it("the transfer slip is mandatory", async () => {
    await mount();
    fireEvent.change(payCleaning(), { target: { value: "40" } });
    // Valid allocation but no slip → submit disabled.
    expect(submitBtn().disabled).toBe(true);
    attachSlip();
    expect(submitBtn().disabled).toBe(false);
  });

  it("sends documentId, positive allocations and the slip key to the invoice endpoint", async () => {
    recordMutate.mockResolvedValueOnce({});
    await mount();
    fireEvent.change(payCleaning(), { target: { value: "40" } });
    fireEvent.change(payWifi(), { target: { value: "150" } });
    fireEvent.change(screen.getByLabelText(/^date received$/i), { target: { value: "2026-02-03" } });
    fireEvent.change(screen.getByLabelText(/bank reference/i), { target: { value: "FT-9911" } });
    attachSlip();

    await submitViaConfirm();

    await waitFor(() => expect(recordMutate).toHaveBeenCalledTimes(1));
    expect(recordMutate.mock.calls[0][0]).toMatchObject({
      documentId: "d8",
      receivedAt: "2026-02-03",
      externalReference: "FT-9911",
      attachmentKeys: ["orgs/o/refund-proofs/slip.jpg"],
      allocations: [
        { chargeId: "ch1", allocatedAmount: "40.00" },
        { chargeId: "ch2", allocatedAmount: "150.00" },
      ],
    });
    // No client-supplied amount / partyId / paymentMethod — derived server-side.
    expect(recordMutate.mock.calls[0][0]).not.toHaveProperty("amount");
    expect(recordMutate.mock.calls[0][0]).not.toHaveProperty("partyId");
  });

  it("deletes the uploaded slip when the record call rejects", async () => {
    recordMutate.mockRejectedValueOnce(new Error("boom"));
    await mount();
    fireEvent.change(payCleaning(), { target: { value: "100" } });
    attachSlip();
    await submitViaConfirm();
    await waitFor(() => expect(deleteSlip).toHaveBeenCalledWith("orgs/o/refund-proofs/slip.jpg"));
  });
});
