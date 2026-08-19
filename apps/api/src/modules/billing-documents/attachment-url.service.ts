// apps/api/src/modules/billing-documents/attachment-url.service.ts
import { getDb } from "@kason/db";
import { createSignedDownloadUrl } from "../../lib/storage"; // the exact signer bills-grid getAttachmentUrlService uses

/** Sign a grid attachment's URL ONLY when it is genuinely linked to this document:
 * attachment.expenseId → a Charge with that sourceGridExpenseId whose BillingDocumentLine
 * sits on `documentId`, all within `orgId`. Returns null (→ 404) otherwise.
 * Uses two plain queries — Charge has no `lines` relation and BillingDocumentLine has no
 * `charge` relation, so a nested-relation filter would not compile. */
export async function resolveAttachmentUrlService(
  orgId: string, documentId: string, attachmentId: string,
): Promise<{ url: string } | null> {
  const db = getDb();
  const att = await db.gridAttachment.findFirst({
    where: { id: attachmentId, organizationId: orgId },
    select: { storageKey: true, expenseId: true },
  });
  if (!att || !att.expenseId) return null;
  // Charges (in this org) minted from that expense.
  const charges = await db.charge.findMany({
    where: { organizationId: orgId, sourceGridExpenseId: att.expenseId },
    select: { id: true },
  });
  if (charges.length === 0) return null;
  // Is any of those charges a line on THIS document?
  const line = await db.billingDocumentLine.findFirst({
    where: { documentId, chargeId: { in: charges.map((c) => c.id) } },
    select: { id: true },
  });
  if (!line) return null;
  const url = await createSignedDownloadUrl(att.storageKey);
  return { url };
}
