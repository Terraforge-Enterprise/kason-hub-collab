// apps/api/src/modules/billing-documents/__tests__/pdf-attachments.test.ts
//
// buildBillingDocumentPdfModel — per-line expense attachment FILENAMES
// (bill-expenses R7, Task 9). Mocked getDb(), mirroring
// pdf.service.race.test.ts's mock-db convention (this module has no
// bills-grid-service integration test precedent the way repository.ts's
// Task 6 detail-attachments.integration.test.ts does — the model builder
// here takes raw charge/gridAttachment rows directly, so a plain mock
// suffices and keeps Chromium fully out of the loop).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = {
  billingDocument: {
    findFirst: vi.fn(),
    // CN/DN-aware model (2026-08-06): the builder also lists active notes
    // against the doc. Default empty — these attachment tests are unadjusted.
    findMany: vi.fn().mockResolvedValue([]),
  },
  party: {
    findFirst: vi.fn(),
  },
  apartment: {
    findFirst: vi.fn(),
  },
  charge: {
    findMany: vi.fn(),
  },
  // Per-charge CN/DN sums (2026-08-16): the builder resolves these so foldTaxLines can
  // refuse to fold an ADJUSTED tax line — without them that guard is inert on the PDF
  // path and the printed document silently diverges from the drawer. Default empty:
  // these attachment tests carry no notes.
  billingDocumentLine: {
    findMany: vi.fn().mockResolvedValue([]),
  },
  gridAttachment: {
    findMany: vi.fn(),
  },
};
vi.mock("@kason/db", () => ({ getDb: () => dbMock }));

import { buildBillingDocumentPdfModel } from "../pdf.service";

const ORG = "o1";
const DOC_ID = "doc-1";

function docRow(lines: { id: string; chargeId: string | null }[]) {
  return {
    id: DOC_ID,
    docType: "invoice",
    documentNumber: "INV-0001",
    issuedAt: new Date("2026-07-02T00:00:00.000Z"),
    billingMonth: null,
    partyId: "party-1",
    apartmentId: null,
    originalDocumentId: null,
    reason: null,
    subtotal: { toString: () => "250.00" },
    sstAmount: { toString: () => "0.00" },
    total: { toString: () => "250.00" },
    lines: lines.map((l) => ({
      id: l.id,
      chargeId: l.chargeId,
      description: "Aircon repair",
      amount: { toString: () => "250.00" },
      sstRate: { toString: () => "0" },
      sstAmount: { toString: () => "0.00" },
    })),
  };
}

describe("buildBillingDocumentPdfModel — attachment filenames (Task 9)", () => {
  const prevFlag = process.env.ENABLE_BILL_EXPENSES_AS_CHARGES;

  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.party.findFirst.mockResolvedValue({ displayName: "Tenant A" });
    // Default for the per-line unit-identity charge lookup, which runs AFTER
    // the attachment lookup and so falls through the per-test `…Once` queue.
    dbMock.charge.findMany.mockResolvedValue([]);
  });

  /** The attachment lookup's distinctive shape — used to assert that IT
   * specifically did not run, now that a second (unit-identity) charge query
   * shares the same mock. */
  const ATTACHMENT_QUERY = { select: { id: true, sourceGridExpenseId: true } };

  afterEach(() => {
    if (prevFlag === undefined) delete process.env.ENABLE_BILL_EXPENSES_AS_CHARGES;
    else process.env.ENABLE_BILL_EXPENSES_AS_CHARGES = prevFlag;
  });

  it("model lists filenames: flag on + a line whose charge has an attachment", async () => {
    process.env.ENABLE_BILL_EXPENSES_AS_CHARGES = "1";
    dbMock.billingDocument.findFirst.mockResolvedValueOnce(docRow([{ id: "line-1", chargeId: "ch1" }]));
    dbMock.charge.findMany.mockResolvedValueOnce([{ id: "ch1", sourceGridExpenseId: "e1" }]);
    dbMock.gridAttachment.findMany.mockResolvedValueOnce([{ filename: "slip.pdf", expenseId: "e1" }]);

    const model = await buildBillingDocumentPdfModel(ORG, DOC_ID);

    expect(model!.lines[0].attachmentFilenames).toEqual(["slip.pdf"]);
    expect(dbMock.charge.findMany).toHaveBeenCalledWith({
      where: { organizationId: ORG, id: { in: ["ch1"] }, sourceGridExpenseId: { not: null } },
      select: { id: true, sourceGridExpenseId: true },
    });
    // The select also carries id + storageKey now: the same rows feed
    // `model.attachments`, whose pages the PDF appends (see
    // pdf-attachment-pages.test.ts). Only the WHERE and ordering are pinned here —
    // this test is about which attachments a line names, not about the column list.
    expect(dbMock.gridAttachment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: ORG, expenseId: { in: ["e1"] } },
        orderBy: { createdAt: "asc" },
      }),
    );
  });

  it("flag off no filenames: every line's attachmentFilenames is [] and no attachment lookups run", async () => {
    process.env.ENABLE_BILL_EXPENSES_AS_CHARGES = "0";
    dbMock.billingDocument.findFirst.mockResolvedValueOnce(docRow([{ id: "line-1", chargeId: "ch1" }]));

    const model = await buildBillingDocumentPdfModel(ORG, DOC_ID);

    expect(model!.lines[0].attachmentFilenames).toEqual([]);
    // The ATTACHMENT charge query must not run with the flag off. (A second,
    // always-on charge query resolves per-line unit identity — not an
    // attachment lookup, so it is excluded here rather than blanket-asserted.)
    expect(dbMock.charge.findMany).not.toHaveBeenCalledWith(expect.objectContaining(ATTACHMENT_QUERY));
    expect(dbMock.gridAttachment.findMany).not.toHaveBeenCalled();
  });

  it("non-expense line: flag on but the charge has no sourceGridExpenseId reports []", async () => {
    process.env.ENABLE_BILL_EXPENSES_AS_CHARGES = "1";
    dbMock.billingDocument.findFirst.mockResolvedValueOnce(docRow([{ id: "line-1", chargeId: "ch1" }]));
    dbMock.charge.findMany.mockResolvedValueOnce([]); // no matching sourceGridExpenseId charge

    const model = await buildBillingDocumentPdfModel(ORG, DOC_ID);

    expect(model!.lines[0].attachmentFilenames).toEqual([]);
    expect(dbMock.gridAttachment.findMany).not.toHaveBeenCalled();
  });

  it("charge-less line (chargeId null) reports [] without querying charges", async () => {
    process.env.ENABLE_BILL_EXPENSES_AS_CHARGES = "1";
    dbMock.billingDocument.findFirst.mockResolvedValueOnce(docRow([{ id: "line-1", chargeId: null }]));

    const model = await buildBillingDocumentPdfModel(ORG, DOC_ID);

    expect(model!.lines[0].attachmentFilenames).toEqual([]);
    expect(dbMock.charge.findMany).not.toHaveBeenCalled();
  });
});
