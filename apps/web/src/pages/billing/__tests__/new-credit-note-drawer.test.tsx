import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NewCreditNoteDrawer } from "../new-credit-note-drawer";

const apiFetch = vi.fn();
vi.mock("@/lib/api-client", () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));

function renderDrawer() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invoice = { id: "11111111-1111-4111-8111-111111111111", partyId: "22222222-2222-4222-8222-222222222222", counterpartyType: "tenant" as const, documentNumber: "DEP-0001" };
  return render(
    <QueryClientProvider client={qc}>
      <NewCreditNoteDrawer open invoice={invoice} onClose={() => {}} />
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.clearAllMocks());

describe("NewCreditNoteDrawer", () => {
  it("posts to /billing-documents/credit-notes with amount + reason + idempotencyKey", async () => {
    apiFetch.mockResolvedValue({ data: { id: "cn1", documentNumber: "CN-0001", creditAmount: "50.00" } });
    renderDrawer();
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: "50.00" } });
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: "tenant overpaid" } });
    fireEvent.click(screen.getByRole("button", { name: /create credit note/i }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    const [path, opts] = apiFetch.mock.calls[0];
    expect(path).toBe("/billing-documents/credit-notes");
    expect(opts.method).toBe("POST");
    const sent = JSON.parse(opts.body);
    expect(sent.reason).toBe("tenant overpaid");
    expect(sent.lines[0].amount).toBe("50.00");
    expect(typeof sent.idempotencyKey).toBe("string");
    expect(sent.originalDocumentId).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("does not submit with an empty amount", async () => {
    renderDrawer();
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: /create credit note/i }));
    expect(await screen.findByText(/amount is required/i)).toBeInTheDocument();
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
