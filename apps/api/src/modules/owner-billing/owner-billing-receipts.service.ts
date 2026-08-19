// Bulk receipt upload + attach/detach for the Owner-Billing module (M6, C6).
//
// One Supabase Storage prefix:
//   owner-statements/<ownerPartyId>/receipts/<uuid>.<ext>
//
// Flow (mirrors tasks-media's media pipeline, but the multipart/putObject variant
// the checklist pins for this module — the API receives the file bytes directly
// and persists them server-side in one round-trip, rather than minting a presigned
// URL): the route parses multipart files → the service mime/size-gates each, names
// the object (server picks the key — the client never does), putObject's the bytes,
// then appends the key(s) to the target array INSIDE a transaction with an in-tx
// audit row. A receipt attaches to the statement Invoice.attachmentKeys by default,
// or to a specific line Charge.attachmentKeys when a chargeId is supplied. Detach
// filters the key out of whichever array holds it — and NEVER deletes the Charge
// row (a line receipt detach leaves its source charge intact). Removal leaves the
// bucket object in place — orphan cleanup is a storage-lifecycle concern, not a
// request-path one (same call as tasks-media).
import { randomUUID } from "node:crypto";
import type { Prisma } from "@kason/db";
import { recordAudit } from "../../lib/audit";
import { runtimeConfig } from "../../lib/runtime-config";
import { createSignedDownloadUrl, putObject } from "../../lib/storage";
import {
  appendChargeAttachmentKeys,
  appendInvoiceAttachmentKeys,
  detachChargeAttachmentKey,
  detachInvoiceAttachmentKey,
  findStatementById,
  findStatementByIdInTx,
  withTransaction,
  type DbInvoice,
} from "./owner-billing.repository";
import { mapStatement } from "./owner-billing.service";
import type { OwnerBillingActorCtx, OwnerBillingServiceResult, OwnerStatementRow } from "./owner-billing.types";

const STATEMENT_NOT_FOUND = "Statement not found";
const LINE_NOT_FOUND = "Line not found on this statement";
const RECEIPT_NOT_FOUND = "Receipt not found on this statement";
const NO_FILES = "No files to upload";
const UNSUPPORTED = "Unsupported file type";

/** Receipt files are photos or PDFs — the same evidence types tasks-media accepts, minus video. */
const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

/** One parsed multipart file the route hands the service. */
export interface ReceiptFile {
  filename: string;
  mimeType: string;
  content: Buffer;
}

/**
 * Per-file mime/size gate. Unknown mime → unsupported. Receipts (images + PDFs)
 * share the photo cap — a receipt PDF has no business being video-sized (same
 * rule tasks-media applies to non-video attachments).
 */
function fileError(file: ReceiptFile): string | null {
  const ext = EXT_BY_MIME[file.mimeType.toLowerCase()];
  if (!ext) return UNSUPPORTED;
  const cap = runtimeConfig.limits.photoMaxBytes;
  if (file.content.length > cap) {
    return `File exceeds the ${Math.round(cap / 1024 / 1024)} MB limit`;
  }
  return null;
}

/** Server-minted key under owner-statements/<ownerPartyId>/receipts/<uuid>.<ext>. */
function mintKey(ownerPartyId: string, file: ReceiptFile): string {
  // "bin" is unreachable — fileError already rejected unknown mimes.
  const ext = EXT_BY_MIME[file.mimeType.toLowerCase()] ?? "bin";
  return `owner-statements/${ownerPartyId}/receipts/${randomUUID()}.${ext}`;
}

/**
 * Upload one or more receipts and attach their keys to the statement (default) or
 * to a specific line Charge (when chargeId is given). requireRole("admin") at the
 * route. Org-scoped: an unknown / cross-org statement → 404 (no upload, no write);
 * a chargeId not on the statement → 404. Each file is mime/size-gated BEFORE any
 * bucket write, so a bad file never lands bytes. The putObject's run before the tx
 * (storage is not transactional); the array append + audit land in ONE tx.
 * Audit: owner-billing.statement.receipt.attach.
 */
export async function uploadReceiptsService(
  ctx: OwnerBillingActorCtx,
  statementId: string,
  files: ReceiptFile[],
  chargeId?: string,
): Promise<OwnerBillingServiceResult<OwnerStatementRow>> {
  if (files.length === 0) return { ok: false as const, status: 400, error: NO_FILES };

  // Org-scoped pre-read (404 cross-org / unknown / non-owner-statement).
  const inv = await findStatementById(ctx.orgId, statementId);
  if (!inv) return { ok: false as const, status: 404, error: STATEMENT_NOT_FOUND };

  // Line-level target must be a charge ON this statement.
  if (chargeId !== undefined && !inv.charges.some((ch) => ch.id === chargeId)) {
    return { ok: false as const, status: 404, error: LINE_NOT_FOUND };
  }

  // Gate every file up front — reject the whole batch on the first bad one, so a
  // partial upload never leaves orphaned bytes for a request that 400s.
  for (const file of files) {
    const err = fileError(file);
    if (err) return { ok: false as const, status: 400, error: err };
  }

  // Persist the bytes (server-named keys). Storage is not transactional, so this
  // happens before the DB tx; the keys are appended atomically with the audit row.
  const ownerPartyId = inv.ownerPartyId ?? inv.partyId;
  const newKeys: string[] = [];
  for (const file of files) {
    const key = mintKey(ownerPartyId, file);
    await putObject(key, file.content, file.mimeType.toLowerCase());
    newKeys.push(key);
  }

  const updated = await withTransaction(async (tx) => {
    if (chargeId !== undefined) {
      // Line-level: merge onto the Charge.attachmentKeys (re-read in-tx for the
      // authoritative current array), then re-read the statement for the response.
      const fresh = await findStatementByIdInTx(tx, ctx.orgId, statementId);
      const charge = fresh?.charges.find((ch) => ch.id === chargeId);
      const current = charge?.attachmentKeys ?? [];
      await appendChargeAttachmentKeys(tx, ctx.orgId, statementId, chargeId, [...current, ...newKeys]);
      await recordAudit(tx, {
        organizationId: ctx.orgId,
        actorUserId: ctx.actorUserId,
        actorRole: ctx.actorRole,
        action: "owner-billing.statement.receipt.attach",
        entityType: "Charge",
        entityId: chargeId,
        meta: { statementId, storageKeys: newKeys },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return reReadStatement(tx, ctx.orgId, statementId, fresh);
    }
    // Statement-level: merge onto Invoice.attachmentKeys (re-read in-tx first).
    const fresh = await findStatementByIdInTx(tx, ctx.orgId, statementId);
    const current = fresh?.attachmentKeys ?? inv.attachmentKeys ?? [];
    const next = await appendInvoiceAttachmentKeys(tx, ctx.orgId, statementId, [...current, ...newKeys]);
    await recordAudit(tx, {
      organizationId: ctx.orgId,
      actorUserId: ctx.actorUserId,
      actorRole: ctx.actorRole,
      action: "owner-billing.statement.receipt.attach",
      entityType: "Invoice",
      entityId: statementId,
      meta: { storageKeys: newKeys },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return next;
  });

  return { ok: true as const, status: 201, data: mapStatement(updated) };
}

/**
 * Detach a single receipt key from wherever it lives — the statement
 * Invoice.attachmentKeys, or a line Charge.attachmentKeys — and NEVER delete the
 * underlying Charge row. requireRole("admin") at the route. Org-scoped: unknown /
 * cross-org statement → 404; a key on neither the Invoice nor any Charge → 404.
 * The bucket object is intentionally left in place. Audit:
 * owner-billing.statement.receipt.detach.
 */
export async function detachReceiptService(
  ctx: OwnerBillingActorCtx,
  statementId: string,
  key: string,
): Promise<OwnerBillingServiceResult<OwnerStatementRow>> {
  const updated = await withTransaction(async (tx) => {
    const inv = await findStatementByIdInTx(tx, ctx.orgId, statementId);
    if (!inv) return { kind: "not_found" as const, error: STATEMENT_NOT_FOUND };

    // Statement-level key?
    if (inv.attachmentKeys.includes(key)) {
      const next = inv.attachmentKeys.filter((k) => k !== key);
      const fresh = await detachInvoiceAttachmentKey(tx, ctx.orgId, statementId, next);
      await recordAudit(tx, {
        organizationId: ctx.orgId,
        actorUserId: ctx.actorUserId,
        actorRole: ctx.actorRole,
        action: "owner-billing.statement.receipt.detach",
        entityType: "Invoice",
        entityId: statementId,
        meta: { storageKey: key },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return { kind: "ok" as const, data: fresh };
    }

    // Line-level key — find the owning Charge (never delete the Charge row).
    const charge = inv.charges.find((ch) => ch.attachmentKeys.includes(key));
    if (charge) {
      const next = charge.attachmentKeys.filter((k) => k !== key);
      await detachChargeAttachmentKey(tx, ctx.orgId, statementId, charge.id, next);
      await recordAudit(tx, {
        organizationId: ctx.orgId,
        actorUserId: ctx.actorUserId,
        actorRole: ctx.actorRole,
        action: "owner-billing.statement.receipt.detach",
        entityType: "Charge",
        entityId: charge.id,
        meta: { statementId, storageKey: key },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      const fresh = await reReadStatement(tx, ctx.orgId, statementId, inv);
      return { kind: "ok" as const, data: fresh };
    }

    return { kind: "not_found" as const, error: RECEIPT_NOT_FOUND };
  });

  if (updated.kind === "not_found") {
    return { ok: false as const, status: 404, error: updated.error };
  }
  return { ok: true as const, status: 200, data: mapStatement(updated.data) };
}

/**
 * Re-read the statement in-tx for the response DTO after a line-level write
 * (the line write returns the Charge, not the Invoice). Falls back to the
 * passed-in pre-write snapshot if the re-read is somehow empty (unreachable — we
 * just wrote it in the same org/tx).
 */
async function reReadStatement(
  tx: Prisma.TransactionClient,
  orgId: string,
  statementId: string,
  fallback: DbInvoice | null,
): Promise<DbInvoice> {
  const fresh = await findStatementByIdInTx(tx, orgId, statementId);
  if (fresh) return fresh;
  if (fallback) return fallback;
  throw new Error("owner-billing receipts: statement not found on re-read");
}

/** One attached receipt + its short-lived signed view URL. */
export interface ReceiptUrl {
  key: string;
  url: string;
}

/**
 * Mint a fresh signed download URL for EACH receipt attached to the statement
 * (requireRole at the route mirrors the receipts upload/detach gate). Org-scoped
 * pre-read (cross-org / unknown / non-owner-statement id → 404; never leak
 * existence). No state change, no audit — a pure read, mirroring getStatementPdfUrl.
 *
 * SECURITY: the only keys ever signed are the ones in THIS statement's
 * Invoice.attachmentKeys (de-duped, defensive). There is NO caller-supplied key
 * input — an arbitrary or cross-statement key can never be signed through here.
 * Keys are signed via the SHARED storage signer (createSignedDownloadUrl), whose
 * per-key+opts cache the PDF/inventory paths already use.
 */
export async function listReceiptUrlsService(
  ctx: OwnerBillingActorCtx,
  statementId: string,
): Promise<OwnerBillingServiceResult<ReceiptUrl[]>> {
  const inv = await findStatementById(ctx.orgId, statementId);
  if (!inv) return { ok: false as const, status: 404, error: STATEMENT_NOT_FOUND };

  // Sign ONLY the statement-level attachmentKeys — the same set the
  // ReceiptUploader renders. De-dupe so a doubled key is signed once.
  const keys = [...new Set(inv.attachmentKeys ?? [])];
  const data = await Promise.all(
    keys.map(async (key) => ({ key, url: await createSignedDownloadUrl(key) })),
  );
  return { ok: true as const, status: 200, data };
}
