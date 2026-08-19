import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// Mock the data hook so the page renders deterministic rows. fetchBillingDocumentPdfUrl
// is also exported from this module and imported by the page — stub it too.
// Row shape mirrors BillingDocumentListItem (packages/shared/src/schemas/billing-documents.ts:30
// — the page reads partyName/unitCode/billingMonth/issuedAt/total/status/documentNumber/docType).
// `as never[]` on items sidesteps the BillingDocType union so the unknown-docType row ("xyz")
// compiles — it exists purely to prove the `?? d.docType` fallback branch.
vi.mock("@/api/billing-documents", () => ({
  useBillingDocuments: () => ({
    data: {
      data: {
        items: [
          { id: "r1", docType: "receipt", documentNumber: "RCPT-0001", seriesCode: "RCPT", counterpartyType: "tenant", partyName: "Tenant A", unitCode: null, billingMonth: null, issuedAt: "2026-07-14T00:00:00.000Z", total: "100.00", status: "issued", originalDocumentNumber: null },
          { id: "x1", docType: "xyz", documentNumber: "XYZ-1", seriesCode: "XYZ", counterpartyType: "tenant", partyName: "Tenant B", unitCode: null, billingMonth: null, issuedAt: "2026-07-14T00:00:00.000Z", total: "50.00", status: "issued", originalDocumentNumber: null },
        ] as never[],
        total: 2,
      },
    },
    isLoading: false,
    isError: false,
  }),
  fetchBillingDocumentPdfUrl: vi.fn(),
  // P4 (T7): documents-page.tsx now renders NewCreditNoteDrawer unconditionally,
  // which calls useCreateCreditNote() on every render — stub it so this
  // pre-existing full-module mock stays complete.
  useCreateCreditNote: () => ({ mutate: vi.fn(), isPending: false }),
}));

import BillingDocumentsPage from "../documents-page";

describe("documents register receipt label (R6)", () => {
  it("renders the Receipt Type label + filter option and falls back for unknown docTypes", () => {
    render(<BillingDocumentsPage />);
    // The receipt row's Type cell reads "Receipt" (production DOC_TYPE_LABEL).
    expect(screen.getAllByText("Receipt").length).toBeGreaterThan(0); // row cell + <option>
    // The unknown docType row falls back to the raw string.
    expect(screen.getByText("xyz")).toBeTruthy();
    // The Type filter <select> carries a Receipt option.
    const typeSelect = screen.getByLabelText("Type") as HTMLSelectElement;
    expect([...typeSelect.options].some((o) => o.value === "receipt")).toBe(true);
  });
});
