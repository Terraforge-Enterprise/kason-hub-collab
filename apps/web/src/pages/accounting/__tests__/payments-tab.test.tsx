// Invoice-adjustments rework (Change 2) — the Payments tab now embeds a real
// "Record payment" section (reusing the same Pay-now allocation logic +
// useRecordInvoicePayment hook the standalone TransferFromInvoiceDrawer uses —
// see record-invoice-payment-form.tsx), instead of the old aggregate-only stub.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BillingDocumentDetail } from "@kason/shared";

const recordMutate = vi.fn();
const uploadSlip = vi.fn(async (_file: File) => "orgs/o/refund-proofs/slip.jpg");
const deleteSlip = vi.fn(async (_key: string) => {});
vi.mock("../../../api/accounting", () => ({
  useRecordInvoicePayment: () => ({ mutateAsync: recordMutate, isPending: false }),
  uploadSlipProof: (file: File) => uploadSlip(file),
  deleteSlipProof: (key: string) => deleteSlip(key),
}));

beforeEach(() => {
  recordMutate.mockReset();
  uploadSlip.mockClear();
  deleteSlip.mockClear();
});

const DETAIL: BillingDocumentDetail = {
  id: "d1",
  partyId: "party-1",
  partyName: "Tenant Nine",
  documentNumber: "IVTEN-0009",
  amountPaid: "0.00",
  balance: "250.00",
  lines: [
    { id: "l1", chargeId: "ch1", description: "Cleaning", amount: "100.00", sstRate: "0", sstAmount: "0.00", categoryName: "Cleaning", paid: "0.00", outstanding: "100.00" },
    { id: "l2", chargeId: "ch2", description: "WiFi", amount: "150.00", sstRate: "0", sstAmount: "0.00", categoryName: "WiFi", paid: "0.00", outstanding: "150.00" },
  ],
} as unknown as BillingDocumentDetail;

const PAID_DETAIL: BillingDocumentDetail = { ...DETAIL, amountPaid: "250.00", balance: "0.00" };

async function mount(props: { detail?: BillingDocumentDetail; isPayable?: boolean } = {}) {
  const { PaymentsTab } = await import("../payments-tab");
  const qc = new QueryClient();
  render(
    <QueryClientProvider client={qc}>
      <PaymentsTab detail={props.detail ?? DETAIL} isPayable={props.isPayable ?? true} />
    </QueryClientProvider>,
  );
}

const submitBtn = () => screen.getByRole("button", { name: /^record payment$/i }) as HTMLButtonElement;
const slipInput = () => screen.getByLabelText(/transfer slip/i);
const payCleaning = () => screen.getByLabelText(/pay now for cleaning/i) as HTMLInputElement;

function attachSlip() {
  const file = new File(["x"], "slip.jpg", { type: "image/jpeg" });
  fireEvent.change(slipInput(), { target: { files: [file] } });
}

describe("PaymentsTab — embedded record-payment form (invoice-adjustments rework)", () => {
  it("shows the Amount paid / Balance due summary", async () => {
    await mount();
    expect(screen.getByText("Amount paid")).toBeInTheDocument();
    expect(screen.getByText("Balance due")).toBeInTheDocument();
    expect(screen.getAllByText(/RM\s?250\.00/).length).toBeGreaterThan(0);
  });

  it("renders the record-payment form scoped to this invoice's lines", async () => {
    await mount();
    expect(screen.getByRole("heading", { name: /record payment/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/pay now for cleaning/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/pay now for wifi/i)).toBeInTheDocument();
    expect(slipInput()).toBeInTheDocument();
  });

  it("the attachment is required — submit stays disabled until a file is uploaded", async () => {
    await mount();
    fireEvent.change(payCleaning(), { target: { value: "40" } });
    expect(submitBtn().disabled).toBe(true);
    attachSlip();
    expect(submitBtn().disabled).toBe(false);
  });

  it("shows an inline error once the slip field is touched and still empty", async () => {
    await mount();
    fireEvent.blur(slipInput());
    expect(screen.getByText(/attach the transfer slip/i)).toBeInTheDocument();
  });

  it("calls useRecordInvoicePayment with a non-empty attachmentKeys and the chosen allocations", async () => {
    recordMutate.mockResolvedValueOnce({});
    await mount();
    fireEvent.change(payCleaning(), { target: { value: "40" } });
    attachSlip();
    fireEvent.click(submitBtn());

    await waitFor(() => expect(recordMutate).toHaveBeenCalledTimes(1));
    const body = recordMutate.mock.calls[0][0];
    expect(body.documentId).toBe("d1");
    expect(body.attachmentKeys).toEqual(["orgs/o/refund-proofs/slip.jpg"]);
    expect(body.attachmentKeys.length).toBeGreaterThan(0);
    expect(body.allocations).toEqual([{ chargeId: "ch1", allocatedAmount: "40.00" }]);
  });

  it("no isPayable ⇒ no record-payment form, just the info callout", async () => {
    await mount({ isPayable: false });
    expect(screen.queryByLabelText(/transfer slip/i)).toBeNull();
    expect(screen.getByText(/no balance on this document/i)).toBeInTheDocument();
  });

  it("a fully-paid document (balance 0) shows no record-payment form", async () => {
    await mount({ detail: PAID_DETAIL });
    expect(screen.queryByLabelText(/transfer slip/i)).toBeNull();
    expect(screen.getByText(/fully paid/i)).toBeInTheDocument();
  });
});
