import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

// Tenant Documents page.
//
// SPEC R13 IS SUPERSEDED (2026-08-17, user directive). R13 said "Invoices, receipts,
// debit/credit notes must NOT appear on Documents — they live under Billing", and this
// file used to LOCK that: it asserted a billing-document number could never render here.
// The proforma work reverses it — the document proving a tenant paid is now minted at
// the moment of payment, and a tenant looking for "my invoice" goes to Documents.
//
// The test below that pinned the old rule now pins the new one. The Billing > Invoices
// tab is untouched and still works; this page is additive.
//
// This file locks:
//   1. the tenancy-document list still shows label + formatDateMY date + View/Download;
//   2. billing documents (proforma / invoice / receipt) DO render, with a customer-facing
//      kind label — a proforma must read as provisional, never as "Invoice";
//   3. client-side search + type filter chips, now including Invoices & receipts;
//   4. the zero-docs EmptyState;
//   5. a billing-document fetch failure does not blank the tenancy documents.
//
// Mocking follows __tests__/portal-nav.test.ts (feature-flags) and
// __tests__/payments.test.tsx (portal-api, native matchers — no jest-dom
// assumed beyond what's already used elsewhere in this suite).

const portalApiFetch = vi.fn();
vi.mock("@/lib/portal-api", () => ({
  portalApiFetch: (...args: unknown[]) => portalApiFetch(...args),
  portalApiUrl: (path: string) => `/portal-api${path}`,
}));

vi.mock("@/lib/feature-flags", () => ({
  isPhase2FlagEnabled: vi.fn(),
}));

import { isPhase2FlagEnabled } from "@/lib/feature-flags";
import PortalDocumentsPage from "../documents";

const mockIsPhase2FlagEnabled = vi.mocked(isPhase2FlagEnabled);

const ONE_DOC = [
  {
    id: "doc-1",
    fileName: "tenancy-agreement.pdf",
    fileType: "application/pdf",
    fileSize: 204800,
    storageKey: "tenancies/doc-1.pdf",
    label: "Tenancy Agreement",
    createdAt: "2026-07-01T04:00:00.000Z", // MY time (UTC+8) → still 1 Jul 2026
  },
];

const FOUR_DOCS = [
  { id: "1", fileName: "agreement.pdf", fileType: "application/pdf", fileSize: 1024, storageKey: "k1", label: "Tenancy Agreement", createdAt: "2025-12-01T04:00:00.000Z" },
  { id: "2", fileName: "house-rules.pdf", fileType: "application/pdf", fileSize: 1024, storageKey: "k2", label: "House Rules", createdAt: "2025-12-01T04:00:00.000Z" },
  { id: "3", fileName: "handover.pdf", fileType: "application/pdf", fileSize: 1024, storageKey: "k3", label: "Handover Checklist", createdAt: "2025-12-01T04:00:00.000Z" },
  { id: "4", fileName: "notice.pdf", fileType: "application/pdf", fileSize: 1024, storageKey: "k4", label: "Termination Notice", createdAt: "2025-12-01T04:00:00.000Z" },
];

const BILLING_DOCS_IF_FETCHED = {
  data: {
    documents: [
      { id: "b-1", docType: "invoice", documentNumber: "IVTEN-0007", status: "posted", issuedAt: "2026-07-01T00:00:00.000Z", billingMonth: "2026-07-01", total: "1060.00", reason: null, originalDocumentNumber: null },
      { id: "b-2", docType: "receipt", documentNumber: "RCPT-0002", status: "posted", issuedAt: "2026-07-05T00:00:00.000Z", billingMonth: null, total: "1200.00", reason: null, originalDocumentNumber: null },
    ],
  },
};

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <PortalDocumentsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  portalApiFetch.mockReset();
  mockIsPhase2FlagEnabled.mockReset();
  mockIsPhase2FlagEnabled.mockReturnValue(false);
  portalApiFetch.mockImplementation((path: string) => {
    if (path === "/documents/billing") return Promise.resolve(BILLING_DOCS_IF_FETCHED);
    return Promise.resolve({ data: ONE_DOC });
  });
});

describe("PortalDocumentsPage", () => {
  it("list: renders label, formatDateMY date, and View/Download actions", async () => {
    renderPage();
    expect(await screen.findByText("Tenancy Agreement")).toBeTruthy();
    expect(screen.getByText("1 Jul 2026")).toBeTruthy();
    expect(screen.getByText("Download")).toBeTruthy();
    // getAllByText: billing-document rows carry their own View control now, so this
    // page legitimately renders more than one.
    expect(screen.getAllByText("View").length).toBeGreaterThan(0);
  });

  it("billing documents render alongside the tenancy files (supersedes R13)", async () => {
    renderPage();
    expect(await screen.findByText("Tenancy Agreement")).toBeTruthy();
    expect(await screen.findByText(/IVTEN-0007/)).toBeTruthy();
    expect(screen.getByText(/RCPT-0002/)).toBeTruthy();
  });

  it("a PROFORMA reads as provisional, never as 'Invoice'", async () => {
    // The whole point of the split: a tenant must be able to tell the request for
    // payment from the tax invoice minted when their money arrives.
    portalApiFetch.mockImplementation((path: string) => {
      if (path === "/documents/billing") {
        return Promise.resolve({
          data: { documents: [{ id: "p-1", docType: "proforma", documentNumber: "PI-0001", status: "issued", issuedAt: "2026-08-01T00:00:00.000Z", billingMonth: "2026-08-01", total: "160.00", reason: null, originalDocumentNumber: null }] },
        });
      }
      return Promise.resolve({ data: ONE_DOC });
    });
    renderPage();
    expect(await screen.findByText(/Proforma invoice/)).toBeTruthy();
    expect(await screen.findByText(/PI-0001/)).toBeTruthy();
  });

  it("a billing-document failure never blanks the tenancy documents", async () => {
    // The agreement is what a tenant most often comes here for; it must not disappear
    // because the billing register errored.
    portalApiFetch.mockImplementation((path: string) => {
      if (path === "/documents/billing") return Promise.reject(new Error("boom"));
      return Promise.resolve({ data: ONE_DOC });
    });
    renderPage();
    expect(await screen.findByText("Tenancy Agreement")).toBeTruthy();
  });

  it("empty: no docs → EmptyState renders, no crash", async () => {
    portalApiFetch.mockImplementation(() => Promise.resolve({ data: [] }));
    renderPage();
    expect(await screen.findByText("No documents yet")).toBeTruthy();
    expect(screen.getByText("Your invoices, receipts and tenancy documents will appear here.")).toBeTruthy();
  });

  it("filter chips: All/Agreements/Notices/Handover/Other render and filter client-side by label", async () => {
    portalApiFetch.mockImplementation(() => Promise.resolve({ data: FOUR_DOCS }));
    renderPage();
    expect(await screen.findByText("Tenancy Agreement")).toBeTruthy();
    expect(screen.getByText("House Rules")).toBeTruthy();
    expect(screen.getByText("Handover Checklist")).toBeTruthy();
    expect(screen.getByText("Termination Notice")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Agreements" }));
    expect(screen.getByText("Tenancy Agreement")).toBeTruthy();
    expect(screen.queryByText("House Rules")).toBeNull();
    expect(screen.queryByText("Handover Checklist")).toBeNull();
    expect(screen.queryByText("Termination Notice")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(screen.getByText("House Rules")).toBeTruthy();
    expect(screen.getByText("Handover Checklist")).toBeTruthy();
    expect(screen.getByText("Termination Notice")).toBeTruthy();
  });

  it("search: typing a query filters the list client-side by label/fileName", async () => {
    portalApiFetch.mockImplementation(() => Promise.resolve({ data: FOUR_DOCS }));
    renderPage();
    expect(await screen.findByText("Tenancy Agreement")).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText(/search documents/i), { target: { value: "house" } });
    expect(screen.getByText("House Rules")).toBeTruthy();
    expect(screen.queryByText("Tenancy Agreement")).toBeNull();
    expect(screen.queryByText("Handover Checklist")).toBeNull();
    expect(screen.queryByText("Termination Notice")).toBeNull();
  });
});

// ── Billing "View": the popup-blocker contract ──────────────────────────────
//
// GET /documents/billing/:id/pdf RENDERS the PDF on demand the first time anyone
// asks for it. Measured on UAT: 53.8s cold, 0.08s warm. Chrome's transient
// user-activation window is 5s, and Safari does not carry activation across an
// await at all — so `window.open(url)` called AFTER the await is treated as
// non-user-initiated and blocked. The tenant sees nothing at all: no tab, no
// error, no spinner, while the server quietly renders and caches the PDF.
//
// The contract these tests lock is the one owner-statement.tsx:239 already
// documents ("the 'download shows nothing' bug"): open the tab SYNCHRONOUSLY
// inside the click gesture, then point it at the signed URL when it arrives.
describe("PortalDocumentsPage — billing document View", () => {
  const BILLING_ONLY = {
    data: {
      documents: [
        { id: "b-1", docType: "invoice", documentNumber: "IVTEN-0007", status: "posted", issuedAt: "2026-07-01T00:00:00.000Z", billingMonth: "2026-07-01", total: "1060.00", reason: null, originalDocumentNumber: null },
      ],
    },
  };

  /** A pdf fetch we hold open, to model the slow cold render. */
  function deferredPdfFetch() {
    let resolve!: (v: unknown) => void;
    let reject!: (e: unknown) => void;
    const pending = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    portalApiFetch.mockImplementation((path: string) => {
      if (path === "/documents/billing") return Promise.resolve(BILLING_ONLY);
      if (path === "/documents/billing/b-1/pdf") return pending;
      return Promise.resolve({ data: [] });
    });
    return { resolve, reject };
  }

  /** The tenancy list is empty in these cases, so the billing row owns the only View. */
  async function clickView() {
    await screen.findByText(/IVTEN-0007/);
    fireEvent.click(screen.getByRole("button", { name: "View" }));
  }

  it("opens the tab synchronously in the click gesture, before the URL resolves", async () => {
    // THE REGRESSION. A 53s cold render means an open deferred until after the
    // await has lost user activation and is blocked. The open must already have
    // happened while the click is still on the stack.
    const openSpy = vi.fn((url?: string | URL) => ({ url, location: { href: "" }, opener: null, close: vi.fn() }));
    vi.stubGlobal("open", openSpy);
    deferredPdfFetch();
    renderPage();

    await clickView();

    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy.mock.calls[0][0]).toBe("about:blank");
  });

  it("points the pre-opened tab at the signed URL once it resolves", async () => {
    const tab = { location: { href: "" }, opener: {} as unknown, close: vi.fn() };
    vi.stubGlobal("open", vi.fn(() => tab));
    const { resolve } = deferredPdfFetch();
    renderPage();

    await clickView();
    resolve({ data: { downloadUrl: "https://storage.example/signed.pdf" } });
    await screen.findByText(/IVTEN-0007/);
    await vi.waitFor(() => expect(tab.location.href).toBe("https://storage.example/signed.pdf"));
    // Severing the opener is what `noopener` bought us on the old one-shot call.
    expect(tab.opener).toBeNull();
  });

  it("closes the tab and surfaces the failure instead of leaving a blank tab", async () => {
    const tab = { location: { href: "" }, opener: {} as unknown, close: vi.fn() };
    vi.stubGlobal("open", vi.fn(() => tab));
    const { reject } = deferredPdfFetch();
    renderPage();

    await clickView();
    reject(new Error("Document not found"));

    await vi.waitFor(() => expect(tab.close).toHaveBeenCalled());
    expect(await screen.findByText(/couldn't open that document/i)).toBeTruthy();
  });

  it("falls back to same-tab navigation when the browser blocks the popup anyway", async () => {
    // window.open can still return null (blocker set to 'block all'). Navigating
    // the current tab beats swallowing the click.
    vi.stubGlobal("open", vi.fn(() => null));
    const { resolve } = deferredPdfFetch();
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign, set href(v: string) { assign(v); } });
    renderPage();

    await clickView();
    resolve({ data: { downloadUrl: "https://storage.example/signed.pdf" } });

    await vi.waitFor(() => expect(assign).toHaveBeenCalledWith("https://storage.example/signed.pdf"));
  });
});
