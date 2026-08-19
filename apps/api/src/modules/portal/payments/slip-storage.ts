import crypto from "node:crypto";

/**
 * Storage-key rules for tenant-uploaded transfer slips.
 *
 * The tenant's browser uploads straight to Supabase against a signed URL and
 * then hands the resulting key back on POST /payments/pay. That key is
 * CLIENT-SUPPLIED data on a money path, so the prefix is the authorization
 * boundary and this module is its single definition — the route mints keys with
 * it, the submit service re-checks them against the session with it.
 *
 * Without the re-check a tenant could post any string: another org's slip key
 * (reading it back through GET /payments/:id/proof-urls, which signs whatever
 * `attachmentKeys` holds), or an unrelated storage path, attaching someone
 * else's document to their own payment as "proof".
 *
 * Both segments are in the path on purpose. `orgId` keeps orgs apart;
 * `partyId` keeps tenants WITHIN an org apart, which org-scoping alone would
 * not do.
 */
export function paymentSlipPrefix(orgId: string, partyId: string): string {
  return `orgs/${orgId}/payment-slips/${partyId}/`;
}

/** Content types a slip may be. Cheques and bank apps produce photos or PDFs. */
export const SLIP_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/webp",
  "application/pdf",
] as const;

export type SlipContentType = (typeof SLIP_CONTENT_TYPES)[number];

/**
 * Server-minted key for a new slip. The filename is sanitised and length-capped
 * rather than trusted: it reaches us from a file picker and ends up in a storage
 * path. The UUID — not the name — is what makes the key unique, so two slips
 * called "IMG_0001.jpg" never collide.
 *
 * INVARIANT: the minted key never contains "..". That is load-bearing, not
 * cosmetic — isOwnedPaymentSlipKey rejects any key containing "..", so a key
 * that kept one would pass through minting and then fail our OWN ownership
 * check at submit, giving the tenant an unexplainable 403.
 *
 * Keeping it requires the `\.{2,}` collapse below: `.` must stay in the allowed
 * character class to preserve the extension, so a plain character-class filter
 * alone leaves ".." intact ("../../etc/x.png" → ".._.._etc_x.png"). Do not
 * remove that collapse, and do not relax isOwnedPaymentSlipKey's "..' check on
 * the assumption that minting already guarantees it — the check also guards
 * keys that arrive from the client, which minting never touched.
 */
export function mintPaymentSlipKey(orgId: string, partyId: string, filename: string): string {
  const cleaned = filename
    .replace(/[^\w.\-]+/g, "_") // anything not word/dot/dash → underscore
    .replace(/\.{2,}/g, ".") // collapse dot-runs, so ".." can never survive
    .replace(/^[._-]+/, "") // no leading separator
    .slice(0, 80);
  // Require at least one alphanumeric — "///" sanitises to "_", which is a
  // truthy string but a meaningless name.
  const safeName = /[a-zA-Z0-9]/.test(cleaned) ? cleaned : "slip";
  return `${paymentSlipPrefix(orgId, partyId)}${crypto.randomUUID()}-${safeName}`;
}

/**
 * Does this key belong to this tenant? Rejects traversal (`..`) outright — a
 * prefix match alone would admit
 * `orgs/<org>/payment-slips/<party>/../../../other-org/secret`.
 */
export function isOwnedPaymentSlipKey(key: string, orgId: string, partyId: string): boolean {
  if (key.includes("..")) return false;
  return key.startsWith(paymentSlipPrefix(orgId, partyId));
}
