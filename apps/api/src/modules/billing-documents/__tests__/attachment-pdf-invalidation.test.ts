// apps/api/src/modules/billing-documents/__tests__/attachment-pdf-invalidation.test.ts
//
// A BillingDocument PDF renders once and caches its object key on `pdfKey`. Now that
// the render also APPENDS the document's supporting bills, attaching a bill after the
// first download would otherwise leave the reader on the old render forever — the bill
// is attached, the screen shows it, the printed invoice never does. That is exactly
// the shape of the bug this work started from, so it gets pinned.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { invalidateDocumentPdfsForAttachment } from "../attachment-pdf-invalidation";

const ORG = "org-1";
const APT = "apt-1";
const JULY = new Date(Date.UTC(2026, 6, 1));

function txMock() {
  return {
    charge: { findMany: vi.fn().mockResolvedValue([]) },
    billingDocumentLine: { findMany: vi.fn().mockResolvedValue([]) },
    billingDocument: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
  };
}

let tx: ReturnType<typeof txMock>;
beforeEach(() => {
  tx = txMock();
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asTx = () => tx as any;

describe("invalidateDocumentPdfsForAttachment", () => {
  it("ROW-level: clears pdfKey on the documents carrying that expense's charge", async () => {
    tx.charge.findMany.mockResolvedValue([{ id: "ch1" }, { id: "ch2" }]);
    tx.billingDocumentLine.findMany.mockResolvedValue([
      { documentId: "doc-a" },
      { documentId: "doc-a" }, // same doc twice — must dedupe
      { documentId: "doc-b" },
    ]);

    await invalidateDocumentPdfsForAttachment(asTx(), {
      orgId: ORG, apartmentId: APT, periodMonth: JULY, expenseId: "e1",
    });

    expect(tx.charge.findMany).toHaveBeenCalledWith({
      where: { organizationId: ORG, sourceGridExpenseId: "e1" },
      select: { id: true },
    });
    expect(tx.billingDocument.updateMany).toHaveBeenCalledWith({
      where: { organizationId: ORG, id: { in: ["doc-a", "doc-b"] }, pdfKey: { not: null } },
      data: { pdfKey: null },
    });
  });

  it("ROW-level: an expense that never became a charge invalidates nothing", async () => {
    tx.charge.findMany.mockResolvedValue([]);

    await invalidateDocumentPdfsForAttachment(asTx(), {
      orgId: ORG, apartmentId: APT, periodMonth: JULY, expenseId: "e1",
    });

    expect(tx.billingDocumentLine.findMany).not.toHaveBeenCalled();
    expect(tx.billingDocument.updateMany).not.toHaveBeenCalled();
  });

  it("ROW-level: a charge that is on no document yet invalidates nothing", async () => {
    tx.charge.findMany.mockResolvedValue([{ id: "ch1" }]);
    tx.billingDocumentLine.findMany.mockResolvedValue([]);

    await invalidateDocumentPdfsForAttachment(asTx(), {
      orgId: ORG, apartmentId: APT, periodMonth: JULY, expenseId: "e1",
    });

    expect(tx.billingDocument.updateMany).not.toHaveBeenCalled();
  });

  it("UNIT-level: clears pdfKey on OWNER documents for that apartment+month only", async () => {
    await invalidateDocumentPdfsForAttachment(asTx(), {
      orgId: ORG, apartmentId: APT, periodMonth: JULY, expenseId: null,
    });

    // counterpartyType "owner" is the safety-relevant clause: pdf.service refuses to
    // append unit-level bills to a tenant document, so invalidating one would force a
    // pointless re-render and imply those bills belong on it.
    expect(tx.billingDocument.updateMany).toHaveBeenCalledWith({
      where: {
        organizationId: ORG,
        counterpartyType: "owner",
        apartmentId: APT,
        billingMonth: JULY,
        pdfKey: { not: null },
      },
      data: { pdfKey: null },
    });
    // No charge/line resolution on the unit-level path — it is apartment+month scoped.
    expect(tx.charge.findMany).not.toHaveBeenCalled();
  });

  it("only ever writes pdfKey — no money, line or total column is touched", async () => {
    tx.charge.findMany.mockResolvedValue([{ id: "ch1" }]);
    tx.billingDocumentLine.findMany.mockResolvedValue([{ documentId: "doc-a" }]);

    await invalidateDocumentPdfsForAttachment(asTx(), {
      orgId: ORG, apartmentId: APT, periodMonth: JULY, expenseId: "e1",
    });
    await invalidateDocumentPdfsForAttachment(asTx(), {
      orgId: ORG, apartmentId: APT, periodMonth: JULY, expenseId: null,
    });

    for (const call of tx.billingDocument.updateMany.mock.calls) {
      expect(Object.keys(call[0].data)).toEqual(["pdfKey"]);
      expect(call[0].data.pdfKey).toBeNull();
    }
  });
});
