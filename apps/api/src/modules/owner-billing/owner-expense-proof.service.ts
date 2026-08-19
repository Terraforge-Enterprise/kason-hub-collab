// Per-expense proof (legal bill) attach / detach / list-signed for the
// Owner-Billing module (Task B2). Proof lives in the append-only OwnerExpenseProof
// store (B1), keyed (org, owner, statementMonth, apartmentId, category) — OFF the
// continuously-re-synced owner ledger AND apartment-scoped, so two apartments'
// same-category bills (e.g. two `utilities_tnb` rows) never cross-bind.
//
// One Supabase Storage prefix:
//   owner-statements/<ownerPartyId>/proofs/<uuid>.<ext>
//
// This MIRRORS owner-billing-receipts.service.ts (same EXT_BY_MIME mime gate,
// server-minted key, putObject, createSignedDownloadUrl) with two deliberate
// differences:
//   1. Proof is keyed per (owner, month, apartment, category) — not per statement
//      Invoice/Charge — so it survives ledger re-projection and stays per-apartment.
//   2. DETACH is NO-ORPHAN: it deletes the bucket object AFTER the row commits
//      (best-effort, never throws). The receipts detach deliberately leaves the
//      object orphaned — this one MUST NOT.
import { randomUUID } from "node:crypto";
import { recordAudit } from "../../lib/audit";
import { runtimeConfig } from "../../lib/runtime-config";
import { deleteObject, putObject, requireBucket } from "../../lib/storage";
import { withTransaction } from "./owner-billing.repository";
import { appendProof, deleteProof, findProofById } from "./owner-expense-proof.repository";
import type { OwnerBillingActorCtx, OwnerBillingServiceResult } from "./owner-billing.types";
import { resolveStatementBills } from "./statement-bills";

const NO_FILES = "No files to upload";
const UNSUPPORTED = "Unsupported file type";
const PROOF_NOT_FOUND = "Expense proof not found";

/** Proof bills are photos or PDFs — the same evidence types receipts accept. */
const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

/** One parsed multipart file the route hands the service. */
export interface ProofFile {
  filename: string;
  mimeType: string;
  content: Buffer;
}

/** The (owner, month, apartment, category) the bills attach to. */
export interface AttachExpenseProofInput {
  ownerPartyId: string;
  /** "YYYY-MM" — normalized to first-of-month UTC at the service boundary. */
  statementMonth: string;
  /** The per-apartment statement's apartment; null = legacy combined statement. */
  apartmentId: string | null;
  /** RAW OwnerLedgerEntry.category ("utilities_tnb" | "water" | "wifi" | ...). */
  category: string;
}

/** Read DTO for a persisted proof row (no storageKey leak — signed URLs come via list). */
export interface ExpenseProofRow {
  id: string;
  category: string;
  filename: string;
  apartmentId: string | null;
  createdAt: string;
}

/** One category's bills + their short-lived signed (INLINE) view URLs. `source`/`readOnly`
 *  are additive (Task 4): "manual" proofs stay editable (readOnly:false); grid bills (surfaced
 *  via resolveStatementBills once delegated) are "grid"/readOnly:true. Existing readers that
 *  ignore the two new fields are unaffected. */
export interface ExpenseProofUrlGroup {
  category: string;
  proofs: { id: string; filename: string; url: string; source: "manual" | "grid"; readOnly: boolean }[];
}

/** "YYYY-MM" → first-of-month UTC Date (the proof store's keyed month). */
function firstOfMonthUtc(statementMonth: string): Date {
  const [y, m] = statementMonth.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, 1));
}

/**
 * Per-file mime/size gate. Unknown mime → unsupported. Proof bills (images + PDFs)
 * share the photo cap — a bill PDF has no business being video-sized.
 */
function fileError(file: ProofFile): string | null {
  const ext = EXT_BY_MIME[file.mimeType.toLowerCase()];
  if (!ext) return UNSUPPORTED;
  const cap = runtimeConfig.limits.photoMaxBytes;
  if (file.content.length > cap) {
    return `File exceeds the ${Math.round(cap / 1024 / 1024)} MB limit`;
  }
  return null;
}

/** Server-minted key under owner-statements/<ownerPartyId>/proofs/<uuid>.<ext>. */
function mintKey(ownerPartyId: string, file: ProofFile): string {
  // "bin" is unreachable — fileError already rejected unknown mimes.
  const ext = EXT_BY_MIME[file.mimeType.toLowerCase()] ?? "bin";
  return `owner-statements/${ownerPartyId}/proofs/${randomUUID()}.${ext}`;
}

function toRow(p: { id: string; category: string; filename: string; apartmentId: string | null; createdAt: Date }): ExpenseProofRow {
  return {
    id: p.id,
    category: p.category,
    filename: p.filename,
    apartmentId: p.apartmentId,
    createdAt: p.createdAt.toISOString(),
  };
}

/**
 * Attach one or more bills to a specific (owner, month, apartment, category)
 * expense. requireRole("admin") at the route. Each file is mime/size-gated BEFORE
 * any bucket write, so a bad file (or an empty batch) never lands bytes and never
 * creates a row. The putObject's run before the tx (storage is not transactional);
 * each row append + its audit land in ONE tx.
 * Audit: owner-billing.expense-proof.attach.
 */
export async function attachExpenseProofService(
  ctx: OwnerBillingActorCtx,
  input: AttachExpenseProofInput,
  files: ProofFile[],
): Promise<OwnerBillingServiceResult<ExpenseProofRow[]>> {
  if (files.length === 0) return { ok: false as const, status: 400, error: NO_FILES };

  // Gate every file up front — reject the whole batch on the first bad one, so a
  // partial upload never leaves orphaned bytes for a request that 400s.
  for (const file of files) {
    const err = fileError(file);
    if (err) return { ok: false as const, status: 400, error: err };
  }

  const month = firstOfMonthUtc(input.statementMonth);

  // Persist the bytes (server-named keys) before the DB tx (storage is not
  // transactional); the rows + audits are appended atomically next.
  const staged: { key: string; file: ProofFile }[] = [];
  for (const file of files) {
    const key = mintKey(input.ownerPartyId, file);
    await putObject(key, file.content, file.mimeType.toLowerCase());
    staged.push({ key, file });
  }

  const created = await withTransaction(async (tx) => {
    const rows: ExpenseProofRow[] = [];
    for (const { key, file } of staged) {
      const proof = await appendProof(tx, {
        orgId: ctx.orgId,
        ownerPartyId: input.ownerPartyId,
        statementMonth: month,
        apartmentId: input.apartmentId,
        category: input.category,
        storageKey: key,
        filename: file.filename,
        uploadedById: ctx.actorUserId,
      });
      await recordAudit(tx, {
        organizationId: ctx.orgId,
        actorUserId: ctx.actorUserId,
        actorRole: ctx.actorRole,
        action: "owner-billing.expense-proof.attach",
        entityType: "OwnerExpenseProof",
        entityId: proof.id,
        meta: {
          ownerPartyId: input.ownerPartyId,
          statementMonth: input.statementMonth,
          apartmentId: input.apartmentId,
          category: input.category,
          storageKey: key,
        },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      rows.push(toRow(proof));
    }
    return rows;
  });

  return { ok: true as const, status: 201, data: created };
}

/**
 * Mint a fresh signed VIEW URL for EACH bill attached to (owner, month, apartment),
 * grouped by category. requireRole("manager") at the route (admin/manager read).
 * DELEGATES to resolveStatementBills (Task 4) — the single read authority that unions
 * the manual OwnerExpenseProof store (this function's original, only source) with
 * GridAttachment (flag-gated via ENABLE_GRID_BILLS_ON_OWNER_STATEMENT). Both the admin
 * (owner-billing.routes.ts) and portal (portal.owner-statements.routes.ts) proof routes
 * call THIS function, so grid bills surface on both surfaces from this one seam. Flag
 * OFF ⇒ manual-only, structurally identical to this function's pre-delegation behavior
 * (additive `source`/`readOnly` fields only). No state change, no audit — a pure read.
 *
 * SECURITY: the only keys ever signed are rows already scoped to this (org, owner,
 * month, apartment) inside resolveStatementBills's two repositories — there is NO
 * caller-supplied key input.
 */
export async function listExpenseProofUrlsService(
  ctx: OwnerBillingActorCtx,
  ownerPartyId: string,
  statementMonth: string,
  apartmentId: string | null,
): Promise<OwnerBillingServiceResult<ExpenseProofUrlGroup[]>> {
  return resolveStatementBills(ctx, ownerPartyId, statementMonth, apartmentId);
}

/**
 * Detach (delete) one proof bill. requireRole("admin") at the route. Org-scoped
 * pre-read (cross-org / unknown id → 404; never leak existence). The row is deleted
 * in-tx with an audit row; THEN the bucket object is deleted AFTER the tx commits —
 * best-effort, NEVER throws — so no orphaned bytes are left behind (the no-orphan
 * rule; unlike the receipts detach which deliberately orphans).
 * Audit: owner-billing.expense-proof.detach.
 */
export async function detachExpenseProofService(
  ctx: OwnerBillingActorCtx,
  proofId: string,
): Promise<OwnerBillingServiceResult<{ id: string }>> {
  const proof = await findProofById(ctx.orgId, proofId);
  if (!proof) return { ok: false as const, status: 404, error: PROOF_NOT_FOUND };

  await withTransaction(async (tx) => {
    await deleteProof(tx, ctx.orgId, proofId);
    await recordAudit(tx, {
      organizationId: ctx.orgId,
      actorUserId: ctx.actorUserId,
      actorRole: ctx.actorRole,
      action: "owner-billing.expense-proof.detach",
      entityType: "OwnerExpenseProof",
      entityId: proofId,
      meta: {
        ownerPartyId: proof.ownerPartyId,
        category: proof.category,
        storageKey: proof.storageKey,
      },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
  });

  // NO ORPHAN: delete the bucket object AFTER the row is gone. Best-effort — a
  // failed object delete must never fail the request (the row is already deleted).
  try {
    await deleteObject(requireBucket(), proof.storageKey);
  } catch {
    // eslint-disable-next-line no-console
    console.warn(`[owner-billing] expense-proof detach: best-effort delete failed for ${proof.storageKey}`);
  }

  return { ok: true as const, status: 200, data: { id: proofId } };
}
