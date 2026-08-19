import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

const apiFetch = vi.fn();
vi.mock("@/lib/api-client", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

import BillingDocumentsPage from "../documents-page";
import { useBillingDocuments } from "@/api/billing-documents";

const ROW = {
  id: "doc-1",
  docType: "debit_note",
  documentNumber: "DEP-0007",
  seriesCode: "DEP",
  status: "issued",
  issuedAt: "2026-07-02T03:00:00.000Z",
  billingMonth: "2026-07-01",
  counterpartyType: "tenant",
  partyName: "Alice Tenant",
  unitCode: "A-19-02",
  total: "980.00",
  originalDocumentNumber: null,
};

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <BillingDocumentsPage />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockImplementation((path: string) => {
    if (path.startsWith("/billing-documents")) return Promise.resolve({ data: { items: [ROW], total: 1 } });
    return Promise.resolve({ data: {} });
  });
});

describe("BillingDocumentsPage", () => {
  it("renders the register with number, party, unit, total and status pill", async () => {
    renderPage();
    expect(await screen.findByText("DEP-0007")).toBeTruthy();
    expect(screen.getByText("Alice Tenant")).toBeTruthy();
    expect(screen.getByText("A-19-02")).toBeTruthy();
    expect(screen.getByText("issued")).toBeTruthy();
  });

  it("docType filter re-queries with the filter applied", async () => {
    renderPage();
    await screen.findByText("DEP-0007");
    fireEvent.change(screen.getByLabelText("Type"), { target: { value: "credit_note" } });
    await waitFor(() => {
      const calls = apiFetch.mock.calls.map((c) => c[0] as string);
      expect(calls.some((p) => p.includes("docType=credit_note"))).toBe(true);
    });
  });

  it("PDF button fetches the signed url and opens it", async () => {
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    apiFetch.mockImplementation((path: string) => {
      if (path === "/billing-documents/doc-1/pdf") return Promise.resolve({ data: { url: "https://signed/x.pdf" } });
      if (path.startsWith("/billing-documents")) return Promise.resolve({ data: { items: [ROW], total: 1 } });
      return Promise.resolve({ data: {} });
    });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "PDF" }));
    await waitFor(() => expect(openSpy).toHaveBeenCalledWith("https://signed/x.pdf", "_blank", "noopener"));
    openSpy.mockRestore();
  });

  it("useBillingDocuments(undefined) keeps the query disabled — no fetch (Plan 4 unit-workspace seam)", () => {
    function Probe() {
      const q = useBillingDocuments(undefined);
      return <span data-testid="fetch-status">{q.fetchStatus}</span>;
    }
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <Probe />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId("fetch-status").textContent).toBe("idle");
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
