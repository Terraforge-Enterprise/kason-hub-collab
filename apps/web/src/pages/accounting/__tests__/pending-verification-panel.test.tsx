// Contract guard for the verification panel (frontend standards §16): the panel
// only does its job if the slip actually RENDERS. A fallback that quietly
// swallows a missing/renamed `slips` field would leave the admin approving
// money against a reference number, with nothing broken enough to notice.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PendingVerificationPayment } from "@/api/payments";

const fetchPending = vi.fn();
vi.mock("@/api/payments", () => ({
  fetchPendingPayments: (documentId: string) => fetchPending(documentId),
  postPayment: vi.fn(),
  rejectPayment: vi.fn(),
}));

const PENDING: PendingVerificationPayment = {
  id: "pay-1",
  paymentNumber: "PAY-MSWS7KZT-LX4C",
  payerName: "BERNICE",
  amount: "3.57",
  allocatedToThisDocument: "2.42",
  spansOtherDocuments: true,
  paymentMethod: "bank_transfer",
  bankReference: "test. number",
  note: null,
  submittedAt: "2026-08-17T05:16:00.000Z",
  slips: [
    {
      url: "https://storage.test/sign/slip-1.jpg?download=transfer-slip-PAY-1-1.jpg",
      kind: "image",
      mimeType: "image/jpeg",
      filename: "transfer-slip-PAY-1-1.jpg",
    },
  ],
  slipUnavailable: false,
  lines: [{ chargeId: "ch-1", description: "Monthly rent", allocatedAmount: "2.42" }],
};

const originalFetch = globalThis.fetch;
const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;

beforeEach(() => {
  fetchPending.mockReset().mockResolvedValue({ data: [PENDING] });
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    blob: async () => new Blob(["bytes"], { type: "image/jpeg" }),
  }) as unknown as typeof fetch;
  URL.createObjectURL = vi.fn(() => "blob:slip-1");
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
});

async function mount() {
  const { PendingVerificationPanel } = await import("../pending-verification-panel");
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PendingVerificationPanel documentId="doc-1" />
    </QueryClientProvider>,
  );
}

describe("PendingVerificationPanel — the slip is on screen", () => {
  it("renders the transfer slip itself, next to the amount it claims", async () => {
    await mount();

    expect(await screen.findByAltText("Transfer slip")).toHaveAttribute("src", "blob:slip-1");
    expect(screen.getByText("BERNICE")).toBeInTheDocument();
    expect(screen.getAllByText(/2\.42/).length).toBeGreaterThan(0);
  });

  it("says so plainly when a payment carries no proof at all", async () => {
    fetchPending.mockResolvedValue({ data: [{ ...PENDING, slips: [] }] });
    await mount();

    expect(await screen.findByText(/no slip attached/i)).toBeInTheDocument();
    expect(screen.queryByAltText("Transfer slip")).toBeNull();
  });

  it("tells the admin to retry rather than approve when signing failed", async () => {
    fetchPending.mockResolvedValue({ data: [{ ...PENDING, slips: [], slipUnavailable: true }] });
    await mount();

    expect(await screen.findByText(/slip unavailable/i)).toBeInTheDocument();
    expect(screen.getByText(/don't approve on the reference number alone/i)).toBeInTheDocument();
  });

  it("renders nothing at all when nothing is pending", async () => {
    fetchPending.mockResolvedValue({ data: [] });
    const { container } = await mount();

    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
