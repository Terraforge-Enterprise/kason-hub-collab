import { getDb } from "@kason/db";
import { AWAITING_VERIFICATION_WHERE } from "@kason/shared";
import { createSignedDownloadUrl } from "../../lib/storage";

export type PendingPaymentLine = {
  chargeId: string;
  /** The document line's own wording, so the admin verifies against what was billed. */
  description: string;
  allocatedAmount: string;
};

export type PendingPaymentSlip = {
  /** Short-lived signed URL. Carries a download disposition — see signSlips(). */
  url: string;
  /** Which viewer the admin gets. "other" → no preview, download only. */
  kind: "image" | "pdf" | "other";
  /**
   * The MIME type the CLIENT re-stamps the fetched bytes with before rendering
   * them. Null for "other". This is the safety property of the inline preview:
   * see signSlips() for why the served content type can't be trusted for it.
   */
  mimeType: string | null;
  /** Filename the admin gets if they save a copy. */
  filename: string;
};

/** Extensions a slip may carry → the MIME the client stamps its bytes with. */
const SLIP_MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
  pdf: "application/pdf",
};

/**
 * What a slip is, read off the STORAGE KEY's extension.
 *
 * Deliberately not the stored content type. The upload route validates only the
 * type the tenant DECLARES, and the signed-upload PUT carries whatever header
 * their browser sends, so what Supabase serves is theirs to choose. The key's
 * extension is theirs too — the difference is that it never decides how the
 * bytes are interpreted, only which viewer we offer: the client stamps
 * `mimeType` onto the bytes itself, so a .jpg full of markup renders as a
 * broken image and never as a page.
 */
export function classifySlipKey(key: string): {
  kind: PendingPaymentSlip["kind"];
  mimeType: string | null;
  ext: string | null;
} {
  const name = key.slice(key.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : null;
  const mimeType = ext ? SLIP_MIME_BY_EXT[ext] ?? null : null;
  if (!mimeType) return { kind: "other", mimeType: null, ext };
  return { kind: mimeType === "application/pdf" ? "pdf" : "image", mimeType, ext };
}

export type PendingPaymentForDocument = {
  id: string;
  paymentNumber: string;
  payerName: string;
  /**
   * What the tenant claims to have transferred IN TOTAL — this is the figure on
   * the slip, so it is what the admin reconciles against the bank statement.
   * May exceed `allocatedToThisDocument` when one transfer covers several
   * invoices.
   */
  amount: string;
  /** The share of that transfer landing on THIS document's charges. */
  allocatedToThisDocument: string;
  /** True when the payment also settles charges outside this document. */
  spansOtherDocuments: boolean;
  paymentMethod: string;
  /** The tenant's typed bank/transaction reference. */
  bankReference: string | null;
  /** The tenant's free-text note, if any. */
  note: string | null;
  submittedAt: string;
  /** The uploaded transfer slip(s), each signed and classified for the viewer. */
  slips: PendingPaymentSlip[];
  /** True when the slip exists but signing failed — the admin sees a retry hint, not a blank. */
  slipUnavailable: boolean;
  lines: PendingPaymentLine[];
};

function money(v: { toString(): string }): string {
  return Number(v.toString()).toFixed(2);
}

/**
 * Signs one payment's slips for the verification panel.
 *
 * The URL keeps a download disposition. The admin now reads the slip INLINE, but
 * they read it out of a blob the client stamps itself (see slip-viewer.tsx) —
 * the URL is fetched, never navigated to. Keeping the disposition means the one
 * thing we hand out can still only ever save to disk: the tenant supplies both
 * the bytes and the content type Supabase serves them with, so a URL that
 * rendered inline would put tenant-authored markup on the storage origin behind
 * a link admins are trained to trust as proof of payment.
 */
async function signSlips(
  keys: string[],
  paymentNumber: string,
): Promise<PendingPaymentSlip[]> {
  return Promise.all(
    keys.map(async (key, i) => {
      const { kind, mimeType, ext } = classifySlipKey(key);
      // Extension included so a saved copy opens in something. The old name had
      // none, which left the admin with a file their OS couldn't place.
      const filename = `transfer-slip-${paymentNumber}-${i + 1}${ext ? `.${ext}` : ""}`;
      return { url: await createSignedDownloadUrl(key, { filename }), kind, mimeType, filename };
    }),
  );
}

/**
 * The tenant-submitted payments awaiting verification against ONE document.
 *
 * Resolved document → lines' charges → allocations → parent payment, because a
 * Payment carries no documentId (a tenant pays charges, and one transfer can
 * span documents). Only `pending_approval` rows are returned: a posted payment
 * belongs on the Payments tab's paid total, and rejected/expired/failed ones
 * are closed.
 *
 * `lines` is narrowed to the allocations that touch THIS document's charges, so
 * a transfer spanning two invoices shows each invoice only its own share —
 * showing the full basket here would misrepresent what this invoice is owed.
 *
 * Returns null when the document doesn't exist in this org (routes → 404),
 * distinct from an existing document with nothing pending (empty array).
 */
export async function getPendingPaymentsForDocument(
  orgId: string,
  documentId: string,
): Promise<PendingPaymentForDocument[] | null> {
  const db = getDb();

  const doc = await db.billingDocument.findFirst({
    where: { id: documentId, organizationId: orgId },
    select: { id: true, lines: { select: { chargeId: true, description: true } } },
  });
  if (!doc) return null;

  const descriptionByCharge = new Map<string, string>();
  for (const l of doc.lines) {
    if (l.chargeId && !descriptionByCharge.has(l.chargeId)) descriptionByCharge.set(l.chargeId, l.description);
  }
  const chargeIds = [...descriptionByCharge.keys()];
  if (chargeIds.length === 0) return [];

  const allocations = await db.paymentAllocation.findMany({
    where: {
      organizationId: orgId,
      chargeId: { in: chargeIds },
      // Manual slips only. An in-flight FPX attempt is also `pending_approval`
      // but is NOT reviewable: both Approve and Reject 409 on the routes'
      // isInFlightFpx guard, so listing one here puts a card in the queue that
      // no button can clear — and it carries no slip, so it renders under a
      // "submitted without proof" warning that misdescribes it entirely.
      ...AWAITING_VERIFICATION_WHERE,
    },
    select: {
      chargeId: true,
      allocatedAmount: true,
      payment: {
        select: {
          id: true,
          paymentNumber: true,
          amount: true,
          paymentMethod: true,
          externalReference: true,
          referenceNote: true,
          createdAt: true,
          attachmentKeys: true,
          party: { select: { displayName: true } },
        },
      },
    },
  });
  if (allocations.length === 0) return [];

  // Group by payment — one submitted transfer usually covers several of this
  // document's charges and must render as ONE reviewable item, not one per line.
  const byPayment = new Map<string, { payment: (typeof allocations)[number]["payment"]; lines: PendingPaymentLine[] }>();
  for (const a of allocations) {
    if (!a.chargeId) continue;
    const entry = byPayment.get(a.payment.id) ?? { payment: a.payment, lines: [] };
    entry.lines.push({
      chargeId: a.chargeId,
      description: descriptionByCharge.get(a.chargeId) ?? "—",
      allocatedAmount: money(a.allocatedAmount),
    });
    byPayment.set(a.payment.id, entry);
  }

  return Promise.all(
    [...byPayment.values()].map(async ({ payment, lines }) => {
      // Sign each slip. A signing failure must not take down the whole review
      // panel — the admin can still see the amount, reference and lines, and
      // decide to retry rather than being blocked by a storage hiccup.
      let slips: PendingPaymentSlip[] = [];
      let slipUnavailable = false;
      const keys = payment.attachmentKeys ?? [];
      if (keys.length > 0) {
        try {
          slips = await signSlips(keys, payment.paymentNumber);
        } catch {
          slipUnavailable = true;
        }
      }
      // Sum this document's share in cents, so a multi-invoice transfer shows a
      // figure that actually foots to the lines listed beside it. Showing the
      // whole transfer next to one invoice's lines asked the admin to reconcile
      // a slip against a number that didn't add up — on the one screen whose
      // entire job is amount-checking.
      const allocatedCents = lines.reduce((s, l) => s + Math.round(Number(l.allocatedAmount) * 100), 0);
      const paymentCents = Math.round(Number(payment.amount.toString()) * 100);
      return {
        id: payment.id,
        paymentNumber: payment.paymentNumber,
        payerName: payment.party?.displayName ?? "—",
        amount: money(payment.amount),
        allocatedToThisDocument: (allocatedCents / 100).toFixed(2),
        spansOtherDocuments: paymentCents > allocatedCents,
        paymentMethod: payment.paymentMethod,
        bankReference: payment.externalReference,
        note: payment.referenceNote,
        submittedAt: payment.createdAt.toISOString(),
        slips,
        slipUnavailable,
        lines,
      };
    }),
  );
}
