import { getDb } from "@kason/db";
import { createSignedDownloadUrl } from "../../lib/storage";

/**
 * Signed download URLs for a Payment's transfer-slip attachments (R10). Org-scoped
 * by id (404 on miss / cross-org). Empty attachmentKeys → { ok, urls: [] }. Any
 * signing failure → 502 (never a 500 leak of the SDK error).
 */
export async function getPaymentProofUrlsService(
  orgId: string,
  paymentId: string,
): Promise<{ ok: true; urls: string[] } | { ok: false; status: 404 | 502 }> {
  const row = await getDb().payment.findFirst({
    where: { organizationId: orgId, id: paymentId },
    select: { id: true, attachmentKeys: true },
  });
  if (!row) return { ok: false, status: 404 };
  const keys = row.attachmentKeys ?? [];
  if (keys.length === 0) return { ok: true, urls: [] };
  try {
    const urls = await Promise.all(keys.map((k) => createSignedDownloadUrl(k)));
    return { ok: true, urls };
  } catch {
    return { ok: false, status: 502 };
  }
}
