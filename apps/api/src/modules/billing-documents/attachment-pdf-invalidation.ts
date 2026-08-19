// apps/api/src/modules/billing-documents/attachment-pdf-invalidation.ts
//
// Lives in billing-documents, NOT bills-grid, deliberately. It resolves Charge and
// BillingDocument rows, and the bills-grid module's standing architectural guard
// (bills-grid/__tests__/forbidden-writes.integration.test.ts) forbids that module
// from touching the `charge` delegate outside its two named grid→money seam files.
// The grid calls in through service.ts — one of those two permitted seams — exactly
// as it already does for issueGroupedGridInvoiceTx.
//
// BillingDocument PDFs render ONCE and cache the object key on `pdfKey`; every later
// download just signs the stored object. That is correct for the document's numbers,
// which are immutable — but a document's PDF now also APPENDS its supporting bills
// (pdf.service `model.attachments`). Attach a bill after the invoice was first
// downloaded and, without this, the reader keeps getting the old render forever: the
// bill is attached, the screen shows it, the printed invoice never does.
//
// So a grid attachment appearing or disappearing invalidates the cached render of any
// document that would now render differently. Same move charge-adjustment.service
// already makes when a CN/DN lands on an invoice, and safe for the same reason:
// pdfKey is a cache, not a money field. NO money, line, or total is touched here —
// only which evidence pages the next render appends.
import type { Prisma } from "@kason/db";

/** Which documents a given attachment can appear on. Mirrors pdf.service's two sources. */
export interface AttachmentScope {
  orgId: string;
  apartmentId: string;
  periodMonth: Date;
  /** Set for a per-line attachment; null for a unit-level one. */
  expenseId: string | null;
}

/**
 * Clear `pdfKey` on every BillingDocument whose appended bills just changed.
 *
 * Row-level (expenseId set): the documents carrying a line whose Charge was minted
 * from that GridExpense — either counterparty, because that party is being billed for
 * the expense.
 *
 * Unit-level (expenseId null): OWNER documents for the same apartment + month only.
 * pdf.service refuses to append unit-level bills to a tenant document (they are the
 * owner's supplier paperwork), so invalidating a tenant document here would force a
 * pointless re-render — and, worse, imply those bills belong on it.
 *
 * Best-effort by design: it runs inside the caller's transaction and touches only a
 * cache column, so a document that somehow escapes invalidation is stale, never wrong.
 */
export async function invalidateDocumentPdfsForAttachment(
  tx: Prisma.TransactionClient,
  scope: AttachmentScope,
): Promise<void> {
  if (scope.expenseId) {
    const charges = await tx.charge.findMany({
      where: { organizationId: scope.orgId, sourceGridExpenseId: scope.expenseId },
      select: { id: true },
    });
    if (charges.length === 0) return;
    const lines = await tx.billingDocumentLine.findMany({
      where: { chargeId: { in: charges.map((c) => c.id) } },
      select: { documentId: true },
    });
    const documentIds = [...new Set(lines.map((l) => l.documentId))];
    if (documentIds.length === 0) return;
    await tx.billingDocument.updateMany({
      where: { organizationId: scope.orgId, id: { in: documentIds }, pdfKey: { not: null } },
      data: { pdfKey: null },
    });
    return;
  }

  await tx.billingDocument.updateMany({
    where: {
      organizationId: scope.orgId,
      counterpartyType: "owner",
      apartmentId: scope.apartmentId,
      billingMonth: scope.periodMonth,
      pdfKey: { not: null },
    },
    data: { pdfKey: null },
  });
}
