// apps/api/src/modules/billing-documents/__tests__/pdf-attachment-degradation.test.ts
//
// getBillingDocumentPdfUrl now appends the document's supporting bills. That path
// touches object storage and pdf-lib, so it can fail in ways the document itself
// cannot — and the document is what the reader came for. Losing the appended
// evidence is a degradation; losing the invoice is an outage.
//
// Pins that: a throwing bundler, a throwing merge, and an all-unreadable bill set
// each still produce a downloadable document. Mocked getDb(), mirroring
// pdf.service.race.test.ts's convention.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = {
  billingDocument: { findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn() },
  party: { findFirst: vi.fn() },
  apartment: { findFirst: vi.fn() },
  charge: { findMany: vi.fn().mockResolvedValue([]) },
  gridAttachment: { findMany: vi.fn().mockResolvedValue([]) },
};
vi.mock("@kason/db", () => ({ getDb: () => dbMock }));

vi.mock("../../../lib/storage", () => ({
  createSignedDownloadUrl: vi.fn(async (key: string) => `https://signed.example/${key}`),
  putObject: vi.fn(),
}));
vi.mock("../../../lib/document-templates/pdf", () => ({ htmlToPdf: vi.fn() }));
vi.mock("../../../lib/document-templates/service", () => ({ getTemplateForOrgDocType: vi.fn() }));
vi.mock("../../../lib/bill-bundle", () => ({ buildBillBundlePdf: vi.fn() }));
vi.mock("../../../lib/document-templates/merge-pdfs", () => ({ mergePdfs: vi.fn() }));

import { getBillingDocumentPdfUrl } from "../pdf.service";
import { putObject } from "../../../lib/storage";
import { htmlToPdf } from "../../../lib/document-templates/pdf";
import { getTemplateForOrgDocType } from "../../../lib/document-templates/service";
import { buildBillBundlePdf } from "../../../lib/bill-bundle";
import { mergePdfs } from "../../../lib/document-templates/merge-pdfs";

const ORG = "o1";
const DOC_ID = "44444444-4444-4444-8444-444444444444";
const OWN_KEY = `billing-documents/${ORG}/${DOC_ID}.pdf`;
const APT = "apt-1";
const JULY = new Date(Date.UTC(2026, 6, 1));
const DOC_BYTES = Buffer.from("the-invoice-itself");

/** An OWNER document with one unit-level attachment, so the append path is exercised. */
function primeOwnerDocWithOneAttachment() {
  dbMock.billingDocument.findFirst
    .mockResolvedValueOnce({ id: DOC_ID, pdfKey: null, docType: "invoice" })
    .mockResolvedValueOnce({
      id: DOC_ID,
      docType: "invoice",
      documentNumber: "IVOWN-0001",
      issuedAt: new Date("2026-08-01T00:00:00.000Z"),
      billingMonth: JULY,
      counterpartyType: "owner",
      partyId: "party-1",
      apartmentId: APT,
      originalDocumentId: null,
      reason: null,
      subtotal: { toString: () => "980.00" },
      sstAmount: { toString: () => "0.00" },
      total: { toString: () => "980.00" },
      lines: [],
    });
  dbMock.party.findFirst.mockResolvedValue({ displayName: "Owner A" });
  dbMock.apartment.findFirst.mockResolvedValue({ unitCode: "A-11-22" });
  dbMock.gridAttachment.findMany.mockResolvedValueOnce([
    { id: "u1", filename: "tnb.pdf", storageKey: "grid/tnb.pdf" },
  ]);
  dbMock.billingDocument.updateMany.mockResolvedValue({ count: 1 });
  vi.mocked(getTemplateForOrgDocType).mockRejectedValue(new Error("no template configured"));
  vi.mocked(htmlToPdf).mockResolvedValue(DOC_BYTES);
  vi.mocked(putObject).mockResolvedValue(undefined as never);
}

/** What actually got written to storage. */
function storedBytes(): Buffer {
  return vi.mocked(putObject).mock.calls[0]![1] as Buffer;
}

describe("getBillingDocumentPdfUrl — bill append degrades, never 500s", () => {
  const prevGrid = process.env.ENABLE_GRID_BILLS_ON_OWNER_STATEMENT;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ENABLE_GRID_BILLS_ON_OWNER_STATEMENT = "1";
    dbMock.billingDocument.findMany.mockResolvedValue([]);
    dbMock.charge.findMany.mockResolvedValue([]);
    dbMock.gridAttachment.findMany.mockResolvedValue([]);
  });

  afterEach(() => {
    if (prevGrid === undefined) delete process.env.ENABLE_GRID_BILLS_ON_OWNER_STATEMENT;
    else process.env.ENABLE_GRID_BILLS_ON_OWNER_STATEMENT = prevGrid;
  });

  it("bundler THROWS → the document is still stored and signed, and NOT cached", async () => {
    primeOwnerDocWithOneAttachment();
    vi.mocked(buildBillBundlePdf).mockRejectedValue(new Error("storage exploded"));

    const result = await getBillingDocumentPdfUrl(ORG, DOC_ID);

    expect(result).toEqual({ url: `https://signed.example/${OWN_KEY}` });
    expect(storedBytes().toString()).toBe(DOC_BYTES.toString());
    expect(dbMock.billingDocument.updateMany).not.toHaveBeenCalled();
  });

  it("merge THROWS → the document is still stored and signed, and NOT cached", async () => {
    primeOwnerDocWithOneAttachment();
    vi.mocked(buildBillBundlePdf).mockResolvedValue(new Uint8Array([1, 2, 3]));
    vi.mocked(mergePdfs).mockRejectedValue(new Error("pdf-lib exploded"));

    const result = await getBillingDocumentPdfUrl(ORG, DOC_ID);

    expect(result).toEqual({ url: `https://signed.example/${OWN_KEY}` });
    expect(storedBytes().toString()).toBe(DOC_BYTES.toString());
    expect(dbMock.billingDocument.updateMany).not.toHaveBeenCalled();
  });

  it("every bill unreadable (bundler returns null) → document alone, no merge, NOT cached", async () => {
    primeOwnerDocWithOneAttachment();
    vi.mocked(buildBillBundlePdf).mockResolvedValue(null);

    const result = await getBillingDocumentPdfUrl(ORG, DOC_ID);

    expect(result).toEqual({ url: `https://signed.example/${OWN_KEY}` });
    expect(storedBytes().toString()).toBe(DOC_BYTES.toString());
    expect(mergePdfs).not.toHaveBeenCalled();
    // A storage outage reaches us as "every bill skipped" → null, never as a throw.
    // Caching it would freeze a transient outage into a permanently incomplete invoice.
    expect(dbMock.billingDocument.updateMany).not.toHaveBeenCalled();
  });

  it("a degraded render is RETRIED on the next download, not served from cache", async () => {
    // First download: the bundler is down, so the append degrades.
    primeOwnerDocWithOneAttachment();
    vi.mocked(buildBillBundlePdf).mockRejectedValue(new Error("storage exploded"));
    await getBillingDocumentPdfUrl(ORG, DOC_ID);
    expect(dbMock.billingDocument.updateMany).not.toHaveBeenCalled();

    // Second download: pdfKey is STILL null (nothing cached it), so the whole render
    // runs again — and now that storage is back, the bills make it in and stick.
    vi.clearAllMocks();
    primeOwnerDocWithOneAttachment();
    vi.mocked(buildBillBundlePdf).mockResolvedValue(new Uint8Array([1, 2, 3]));
    vi.mocked(mergePdfs).mockResolvedValue(Buffer.from("invoice+bills"));

    const result = await getBillingDocumentPdfUrl(ORG, DOC_ID);

    expect(result).toEqual({ url: `https://signed.example/${OWN_KEY}` });
    expect(storedBytes().toString()).toBe("invoice+bills");
    expect(dbMock.billingDocument.updateMany).toHaveBeenCalled();
  });

  it("happy path — the merged bytes are what gets stored, and cached", async () => {
    primeOwnerDocWithOneAttachment();
    vi.mocked(buildBillBundlePdf).mockResolvedValue(new Uint8Array([1, 2, 3]));
    vi.mocked(mergePdfs).mockResolvedValue(Buffer.from("invoice+bills"));

    const result = await getBillingDocumentPdfUrl(ORG, DOC_ID);

    expect(result).toEqual({ url: `https://signed.example/${OWN_KEY}` });
    expect(storedBytes().toString()).toBe("invoice+bills");
    expect(dbMock.billingDocument.updateMany).toHaveBeenCalled();
  });

  it("no attachments at all → the bundler is never called (bytes unchanged)", async () => {
    dbMock.billingDocument.findFirst
      .mockResolvedValueOnce({ id: DOC_ID, pdfKey: null, docType: "invoice" })
      .mockResolvedValueOnce({
        id: DOC_ID, docType: "invoice", documentNumber: "IVTEN-0001",
        issuedAt: new Date("2026-08-01T00:00:00.000Z"), billingMonth: JULY,
        counterpartyType: "tenant", partyId: "party-1", apartmentId: APT,
        originalDocumentId: null, reason: null,
        subtotal: { toString: () => "980.00" }, sstAmount: { toString: () => "0.00" },
        total: { toString: () => "980.00" }, lines: [],
      });
    dbMock.party.findFirst.mockResolvedValue({ displayName: "Tenant A" });
    dbMock.apartment.findFirst.mockResolvedValue({ unitCode: "A-11-22" });
    dbMock.billingDocument.updateMany.mockResolvedValue({ count: 1 });
    vi.mocked(getTemplateForOrgDocType).mockRejectedValue(new Error("no template configured"));
    vi.mocked(htmlToPdf).mockResolvedValue(DOC_BYTES);
    vi.mocked(putObject).mockResolvedValue(undefined as never);

    const result = await getBillingDocumentPdfUrl(ORG, DOC_ID);

    expect(result).toEqual({ url: `https://signed.example/${OWN_KEY}` });
    expect(buildBillBundlePdf).not.toHaveBeenCalled();
    expect(storedBytes().toString()).toBe(DOC_BYTES.toString());
    // No attachments means nothing was LOST — this render is complete and caches
    // normally. "Degraded" must not be confused with "has no bills".
    expect(dbMock.billingDocument.updateMany).toHaveBeenCalled();
  });
});
