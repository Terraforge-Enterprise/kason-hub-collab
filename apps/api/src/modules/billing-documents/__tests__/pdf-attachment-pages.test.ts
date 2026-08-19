// apps/api/src/modules/billing-documents/__tests__/pdf-attachment-pages.test.ts
//
// buildBillingDocumentPdfModel — the ATTACHMENT BILLS a document's PDF appends.
//
// Until now the PDF listed attachment FILENAMES as text under each line and nothing
// more (spec R7), and it only ever considered attachments reachable through a
// Charge.sourceGridExpenseId. Two consequences the user hit: an owner printing an
// invoice got the name of a bill but never the bill, and a UNIT-level bills-grid
// attachment (`GridAttachment.expenseId = null`, what the grid's Attachments panel
// writes) could not appear at all.
//
// `model.attachments` is the list whose pages get appended. Mocked getDb(), mirroring
// pdf-attachments.test.ts's convention.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = {
  billingDocument: {
    findFirst: vi.fn(),
    findMany: vi.fn().mockResolvedValue([]),
  },
  party: { findFirst: vi.fn() },
  apartment: { findFirst: vi.fn() },
  charge: { findMany: vi.fn() },
  // Per-charge CN/DN sums (2026-08-16): the builder resolves these so foldTaxLines can
  // refuse to fold an ADJUSTED tax line. Default empty — these attachment tests carry
  // no notes. Mirrors pdf-attachments.test.ts.
  billingDocumentLine: { findMany: vi.fn().mockResolvedValue([]) },
  gridAttachment: { findMany: vi.fn() },
};
vi.mock("@kason/db", () => ({ getDb: () => dbMock }));

import { buildBillingDocumentPdfModel } from "../pdf.service";

const ORG = "o1";
const DOC_ID = "doc-1";
const APT = "apt-1";
const JULY = new Date(Date.UTC(2026, 6, 1));

function docRow(opts: {
  lines: { id: string; chargeId: string | null }[];
  counterpartyType: string;
  apartmentId?: string | null;
  billingMonth?: Date | null;
}) {
  return {
    id: DOC_ID,
    docType: "invoice",
    documentNumber: "INV-0001",
    issuedAt: new Date("2026-07-02T00:00:00.000Z"),
    billingMonth: opts.billingMonth === undefined ? JULY : opts.billingMonth,
    counterpartyType: opts.counterpartyType,
    partyId: "party-1",
    apartmentId: opts.apartmentId === undefined ? APT : opts.apartmentId,
    originalDocumentId: null,
    reason: null,
    subtotal: { toString: () => "250.00" },
    sstAmount: { toString: () => "0.00" },
    total: { toString: () => "250.00" },
    lines: opts.lines.map((l) => ({
      id: l.id,
      chargeId: l.chargeId,
      description: "Aircon repair",
      amount: { toString: () => "250.00" },
      sstRate: { toString: () => "0" },
      sstAmount: { toString: () => "0.00" },
    })),
  };
}

/** The unit-level lookup's distinctive shape — asserts that IT specifically ran/didn't. */
const UNIT_LEVEL_QUERY = expect.objectContaining({
  where: expect.objectContaining({ expenseId: null }),
});

describe("buildBillingDocumentPdfModel — attachment bills appended to the PDF", () => {
  const prevExpense = process.env.ENABLE_BILL_EXPENSES_AS_CHARGES;
  const prevGrid = process.env.ENABLE_GRID_BILLS_ON_OWNER_STATEMENT;

  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.party.findFirst.mockResolvedValue({ displayName: "Owner A" });
    dbMock.apartment.findFirst.mockResolvedValue({ unitCode: "A-11-22" });
    dbMock.charge.findMany.mockResolvedValue([]);
    dbMock.gridAttachment.findMany.mockResolvedValue([]);
    // clearAllMocks wipes the constructor-time default, so restore it each test.
    dbMock.billingDocumentLine.findMany.mockResolvedValue([]);
  });

  afterEach(() => {
    if (prevExpense === undefined) delete process.env.ENABLE_BILL_EXPENSES_AS_CHARGES;
    else process.env.ENABLE_BILL_EXPENSES_AS_CHARGES = prevExpense;
    if (prevGrid === undefined) delete process.env.ENABLE_GRID_BILLS_ON_OWNER_STATEMENT;
    else process.env.ENABLE_GRID_BILLS_ON_OWNER_STATEMENT = prevGrid;
  });

  it("ROW-level: a line's expense attachment is carried with its storage key", async () => {
    process.env.ENABLE_BILL_EXPENSES_AS_CHARGES = "1";
    dbMock.billingDocument.findFirst.mockResolvedValueOnce(
      docRow({ lines: [{ id: "line-1", chargeId: "ch1" }], counterpartyType: "tenant" }),
    );
    dbMock.charge.findMany.mockResolvedValueOnce([{ id: "ch1", sourceGridExpenseId: "e1" }]);
    dbMock.gridAttachment.findMany.mockResolvedValueOnce([
      { id: "a1", filename: "slip.pdf", storageKey: "grid/slip.pdf", expenseId: "e1" },
    ]);

    const model = await buildBillingDocumentPdfModel(ORG, DOC_ID);

    expect(model!.attachments).toEqual([{ storageKey: "grid/slip.pdf", filename: "slip.pdf" }]);
    // The filename list under the line is unchanged behaviour.
    expect(model!.lines[0].attachmentFilenames).toEqual(["slip.pdf"]);
  });

  it("UNIT-level on an OWNER document: included when the grid flag is on", async () => {
    process.env.ENABLE_GRID_BILLS_ON_OWNER_STATEMENT = "1";
    dbMock.billingDocument.findFirst.mockResolvedValueOnce(
      docRow({ lines: [{ id: "line-1", chargeId: null }], counterpartyType: "owner" }),
    );
    dbMock.gridAttachment.findMany.mockResolvedValueOnce([
      { id: "u1", filename: "tnb.pdf", storageKey: "grid/tnb.pdf", expenseId: null },
    ]);

    const model = await buildBillingDocumentPdfModel(ORG, DOC_ID);

    expect(model!.attachments).toEqual([{ storageKey: "grid/tnb.pdf", filename: "tnb.pdf" }]);
    expect(dbMock.gridAttachment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: ORG, apartmentId: APT, periodMonth: JULY, expenseId: null },
      }),
    );
  });

  it("LEAK GUARD — a TENANT document never receives unit-level attachments", async () => {
    // Unit-level grid attachments are the OWNER's supplier bills; the grid's own
    // Attachments panel says they "belong to the OWNER and attach to NO expense line".
    // Appending them to a tenant's invoice would disclose the owner's paperwork.
    process.env.ENABLE_GRID_BILLS_ON_OWNER_STATEMENT = "1";
    process.env.ENABLE_BILL_EXPENSES_AS_CHARGES = "1";
    dbMock.billingDocument.findFirst.mockResolvedValueOnce(
      docRow({ lines: [{ id: "line-1", chargeId: null }], counterpartyType: "tenant" }),
    );

    const model = await buildBillingDocumentPdfModel(ORG, DOC_ID);

    expect(model!.attachments).toEqual([]);
    expect(dbMock.gridAttachment.findMany).not.toHaveBeenCalledWith(UNIT_LEVEL_QUERY);
  });

  it("UNIT-level stays out when the grid flag is off, even on an owner document", async () => {
    delete process.env.ENABLE_GRID_BILLS_ON_OWNER_STATEMENT;
    dbMock.billingDocument.findFirst.mockResolvedValueOnce(
      docRow({ lines: [{ id: "line-1", chargeId: null }], counterpartyType: "owner" }),
    );

    const model = await buildBillingDocumentPdfModel(ORG, DOC_ID);

    expect(model!.attachments).toEqual([]);
    expect(dbMock.gridAttachment.findMany).not.toHaveBeenCalledWith(UNIT_LEVEL_QUERY);
  });

  it("an owner document with no apartment cannot be scoped — no unit-level lookup", async () => {
    process.env.ENABLE_GRID_BILLS_ON_OWNER_STATEMENT = "1";
    dbMock.billingDocument.findFirst.mockResolvedValueOnce(
      docRow({ lines: [{ id: "line-1", chargeId: null }], counterpartyType: "owner", apartmentId: null }),
    );

    const model = await buildBillingDocumentPdfModel(ORG, DOC_ID);

    expect(model!.attachments).toEqual([]);
    expect(dbMock.gridAttachment.findMany).not.toHaveBeenCalledWith(UNIT_LEVEL_QUERY);
  });

  it("an owner document with no billingMonth cannot be scoped — no unit-level lookup", async () => {
    process.env.ENABLE_GRID_BILLS_ON_OWNER_STATEMENT = "1";
    dbMock.billingDocument.findFirst.mockResolvedValueOnce(
      docRow({ lines: [{ id: "line-1", chargeId: null }], counterpartyType: "owner", billingMonth: null }),
    );

    const model = await buildBillingDocumentPdfModel(ORG, DOC_ID);

    expect(model!.attachments).toEqual([]);
    expect(dbMock.gridAttachment.findMany).not.toHaveBeenCalledWith(UNIT_LEVEL_QUERY);
  });

  it("DEDUPE — one attachment shared by two lines of the same expense is appended once", async () => {
    process.env.ENABLE_BILL_EXPENSES_AS_CHARGES = "1";
    dbMock.billingDocument.findFirst.mockResolvedValueOnce(
      docRow({
        lines: [{ id: "line-1", chargeId: "ch1" }, { id: "line-2", chargeId: "ch2" }],
        counterpartyType: "tenant",
      }),
    );
    dbMock.charge.findMany.mockResolvedValueOnce([
      { id: "ch1", sourceGridExpenseId: "e1" },
      { id: "ch2", sourceGridExpenseId: "e1" },
    ]);
    dbMock.gridAttachment.findMany.mockResolvedValueOnce([
      { id: "a1", filename: "slip.pdf", storageKey: "grid/slip.pdf", expenseId: "e1" },
    ]);

    const model = await buildBillingDocumentPdfModel(ORG, DOC_ID);

    expect(model!.attachments).toEqual([{ storageKey: "grid/slip.pdf", filename: "slip.pdf" }]);
    // Both lines still name it.
    expect(model!.lines[0].attachmentFilenames).toEqual(["slip.pdf"]);
    expect(model!.lines[1].attachmentFilenames).toEqual(["slip.pdf"]);
  });

  it("an OWNER document collects BOTH its row-level and its unit-level bills", async () => {
    process.env.ENABLE_BILL_EXPENSES_AS_CHARGES = "1";
    process.env.ENABLE_GRID_BILLS_ON_OWNER_STATEMENT = "1";
    dbMock.billingDocument.findFirst.mockResolvedValueOnce(
      docRow({ lines: [{ id: "line-1", chargeId: "ch1" }], counterpartyType: "owner" }),
    );
    dbMock.charge.findMany.mockResolvedValueOnce([{ id: "ch1", sourceGridExpenseId: "e1" }]);
    dbMock.gridAttachment.findMany
      .mockResolvedValueOnce([{ id: "a1", filename: "row.pdf", storageKey: "grid/row.pdf", expenseId: "e1" }])
      .mockResolvedValueOnce([{ id: "u1", filename: "unit.pdf", storageKey: "grid/unit.pdf", expenseId: null }]);

    const model = await buildBillingDocumentPdfModel(ORG, DOC_ID);

    expect(model!.attachments).toEqual([
      { storageKey: "grid/row.pdf", filename: "row.pdf" },
      { storageKey: "grid/unit.pdf", filename: "unit.pdf" },
    ]);
  });
});
