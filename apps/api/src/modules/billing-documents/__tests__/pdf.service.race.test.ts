// apps/api/src/modules/billing-documents/__tests__/pdf.service.race.test.ts
//
// Reviewer hardening (T10 review, folded into T11): two GETs can race on an
// un-rendered doc and both render + try to persist pdfKey. This asserts the
// LOSER of the conditional updateMany discards its own render and returns
// the WINNER's signed url instead of last-write-wins overwriting the row.

import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = {
  billingDocument: {
    findFirst: vi.fn(),
    updateMany: vi.fn(),
  },
  party: {
    findFirst: vi.fn(),
  },
};
vi.mock("@kason/db", () => ({ getDb: () => dbMock }));

vi.mock("../../../lib/storage", () => ({
  createSignedDownloadUrl: vi.fn(),
  putObject: vi.fn(),
}));

vi.mock("../../../lib/document-templates/pdf", () => ({
  htmlToPdf: vi.fn(),
}));

vi.mock("../../../lib/document-templates/service", () => ({
  getTemplateForOrgDocType: vi.fn(),
}));

import { getBillingDocumentPdfUrl } from "../pdf.service";
import { createSignedDownloadUrl, putObject } from "../../../lib/storage";
import { htmlToPdf } from "../../../lib/document-templates/pdf";
import { getTemplateForOrgDocType } from "../../../lib/document-templates/service";

const ORG = "o1";
const DOC_ID = "33333333-3333-4333-8333-333333333333";
const OWN_KEY = `billing-documents/${ORG}/${DOC_ID}.pdf`;
const WINNER_KEY = `billing-documents/${ORG}/${DOC_ID}-winner.pdf`;

describe("getBillingDocumentPdfUrl — concurrent-render race", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("when a concurrent renderer wins the conditional update, returns the WINNER's signed url without a second update", async () => {
    dbMock.billingDocument.findFirst
      // 1) initial lookup inside getBillingDocumentPdfUrl — un-rendered.
      .mockResolvedValueOnce({ id: DOC_ID, pdfKey: null, docType: "debit_note" })
      // 2) buildBillingDocumentPdfModel's own doc+lines lookup.
      .mockResolvedValueOnce({
        id: DOC_ID,
        docType: "debit_note",
        documentNumber: "DEP-0007",
        issuedAt: new Date("2026-07-02T00:00:00.000Z"),
        billingMonth: null,
        partyId: "party-1",
        apartmentId: null,
        originalDocumentId: null,
        reason: null,
        subtotal: { toString: () => "980.00" },
        sstAmount: { toString: () => "0.00" },
        total: { toString: () => "980.00" },
        lines: [],
      })
      // 3) re-read after losing the conditional update — winner's key.
      .mockResolvedValueOnce({ pdfKey: WINNER_KEY });

    dbMock.party.findFirst.mockResolvedValueOnce({ displayName: "Tenant A" });

    // getTemplateForOrgDocType never resolves null (it auto-creates a row);
    // mimic the "no template" case via the service's own non-fatal catch.
    vi.mocked(getTemplateForOrgDocType).mockRejectedValue(new Error("no template configured"));
    vi.mocked(htmlToPdf).mockResolvedValue(Buffer.from("pdf-bytes"));
    vi.mocked(putObject).mockResolvedValue(undefined as never);
    // Loses the race: a concurrent renderer already set pdfKey.
    dbMock.billingDocument.updateMany.mockResolvedValue({ count: 0 });
    vi.mocked(createSignedDownloadUrl).mockImplementation(async (key: string) => `https://signed.example/${key}`);

    const result = await getBillingDocumentPdfUrl(ORG, DOC_ID);

    expect(result).toEqual({ url: `https://signed.example/${WINNER_KEY}` });
    // The loser's render is discarded — no second write to the row.
    expect(dbMock.billingDocument.updateMany).toHaveBeenCalledTimes(1);
    expect(dbMock.billingDocument.updateMany).toHaveBeenCalledWith({
      where: { id: DOC_ID, pdfKey: null },
      data: { pdfKey: OWN_KEY },
    });
    // Never signs its own (losing) key.
    expect(createSignedDownloadUrl).not.toHaveBeenCalledWith(OWN_KEY);
  });

  it("when the conditional update wins (count 1), signs its own key and never re-reads", async () => {
    dbMock.billingDocument.findFirst
      .mockResolvedValueOnce({ id: DOC_ID, pdfKey: null, docType: "debit_note" })
      .mockResolvedValueOnce({
        id: DOC_ID,
        docType: "debit_note",
        documentNumber: "DEP-0007",
        issuedAt: new Date("2026-07-02T00:00:00.000Z"),
        billingMonth: null,
        partyId: "party-1",
        apartmentId: null,
        originalDocumentId: null,
        reason: null,
        subtotal: { toString: () => "980.00" },
        sstAmount: { toString: () => "0.00" },
        total: { toString: () => "980.00" },
        lines: [],
      });

    dbMock.party.findFirst.mockResolvedValueOnce({ displayName: "Tenant A" });

    vi.mocked(getTemplateForOrgDocType).mockRejectedValue(new Error("no template configured"));
    vi.mocked(htmlToPdf).mockResolvedValue(Buffer.from("pdf-bytes"));
    vi.mocked(putObject).mockResolvedValue(undefined as never);
    dbMock.billingDocument.updateMany.mockResolvedValue({ count: 1 });
    vi.mocked(createSignedDownloadUrl).mockImplementation(async (key: string) => `https://signed.example/${key}`);

    const result = await getBillingDocumentPdfUrl(ORG, DOC_ID);

    expect(result).toEqual({ url: `https://signed.example/${OWN_KEY}` });
    // No re-read — findFirst called exactly twice (initial + model build).
    expect(dbMock.billingDocument.findFirst).toHaveBeenCalledTimes(2);
  });
});
