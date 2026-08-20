// Attachment media pipeline for the Tasks + Tickets module (M7).
//
// Three Supabase Storage prefixes, one shared flow:
//   tasks/<taskId>/<uuid>.<ext>        — board-task evidence (WhatsApp parity)
//   tickets/<ticketId>/<uuid>.<ext>    — ticket open-time evidence
//   unit-history/<unitId>/<uuid>.<ext> — per-unit history entry media
//
// Flow: mint a presigned upload URL (server names the object — the client
// never picks keys) → client PUTs directly to Supabase → client calls
// complete, which verifies the object actually landed before appending the
// key to the entity's attachmentKeys array inside a transaction with an
// in-tx audit row. Listing mints short-lived download URLs (+ a 600px
// thumbnail transform for images). Removal filters the key (audited);
// the bucket object is intentionally left in place — orphan cleanup is a
// storage-lifecycle concern, not a request-path one.
import { randomUUID } from "node:crypto";
import type { Prisma } from "@kason/db";
import { getDb } from "@kason/db";
import type { AttachmentUploadUrlInput } from "@kason/shared";
import { recordAudit } from "../../lib/audit";
import { runtimeConfig } from "../../lib/runtime-config";
import {
  createSignedDownloadUrl,
  createSignedUploadUrl,
  objectExists,
} from "../../lib/storage";
import { withTransaction } from "./tasks.repository";
import type { TasksActorCtx, TasksServiceResult } from "./tasks.types";

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "application/pdf": "pdf",
};
const IMAGE_EXT = new Set(["jpg", "png", "webp"]);
const VIDEO_EXT = new Set(["mp4", "mov", "webm"]);
const MAX_ATTACHMENTS = 12;
const TICKET_OPEN = new Set(["open", "in_progress"]);

/** Service-internal error carrying the HTTP-ish status the routes map 1:1. */
class HttpishError extends Error {
  constructor(
    public status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

export const TASK_KEY_RE =
  /^tasks\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|png|webp|mp4|mov|webm|pdf)$/i;
export const TICKET_KEY_RE =
  /^tickets\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|png|webp|mp4|mov|webm|pdf)$/i;
export const HISTORY_KEY_RE =
  /^unit-history\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|png|webp|mp4|mov|webm|pdf)$/i;

type SignedUpload = {
  uploadUrl: string;
  method: string;
  headers: Record<string, string>;
  storageKey: string;
};
type AttachmentUrl = {
  key: string;
  url: string;
  thumbnail: string | null;
  kind: "image" | "video" | "pdf";
  /** Set when the file lives on the paired entity (ticket ⇄ task union view) — read-only there. */
  linkedFrom?: "ticket" | "task";
};

/** Wraps a service body: HttpishError → typed error result; anything else rethrows. */
async function run<T>(fn: () => Promise<T>): Promise<TasksServiceResult<T>> {
  try {
    return { ok: true, status: 200, data: await fn() };
  } catch (err) {
    if (err instanceof HttpishError) {
      return { ok: false, status: err.status, error: err.message };
    }
    throw err;
  }
}

/**
 * Mime/size gate. Unknown mime → "Unsupported file type". Videos get the
 * env-driven video cap; images and PDFs share the photo cap (a quote PDF
 * has no business being 50 MB).
 */
function sizeError(input: AttachmentUploadUrlInput): string | null {
  const ext = EXT_BY_MIME[input.mimeType.toLowerCase()];
  if (!ext) return "Unsupported file type";
  const cap = VIDEO_EXT.has(ext)
    ? runtimeConfig.limits.videoMaxBytes
    : runtimeConfig.limits.photoMaxBytes;
  if (input.sizeBytes > cap) {
    return `File exceeds the ${Math.round(cap / 1024 / 1024)} MB limit`;
  }
  return null;
}

async function mint(prefix: string, input: AttachmentUploadUrlInput): Promise<SignedUpload> {
  // "bin" is unreachable — sizeError already rejected unknown mimes.
  const ext = EXT_BY_MIME[input.mimeType.toLowerCase()] ?? "bin";
  const storageKey = `${prefix}/${randomUUID()}.${ext}`;
  return createSignedUploadUrl({ storageKey, contentType: input.mimeType.toLowerCase() });
}

async function toUrls(keys: string[]): Promise<AttachmentUrl[]> {
  return Promise.all(
    keys.map(async (key) => {
      const ext = key.slice(key.lastIndexOf(".") + 1).toLowerCase();
      const kind: AttachmentUrl["kind"] = IMAGE_EXT.has(ext)
        ? "image"
        : VIDEO_EXT.has(ext)
          ? "video"
          : "pdf";
      const url = await createSignedDownloadUrl(key);
      // Thumbnails only make sense for images — Supabase's transform API
      // does not frame-grab videos, and PDFs render client-side.
      const thumbnail =
        kind === "image"
          ? await createSignedDownloadUrl(key, {
              transform: { width: 600, height: 600, resize: "cover", quality: 75 },
            })
          : null;
      return { key, url, thumbnail, kind };
    }),
  );
}

// ─── Tasks ───────────────────────────────────────────────────────────────────

export async function mintTaskAttachmentUploadUrl(
  ctx: TasksActorCtx,
  taskId: string,
  input: AttachmentUploadUrlInput,
): Promise<TasksServiceResult<SignedUpload>> {
  return run(async () => {
    // Free check first — reject bad mime/size without a DB roundtrip.
    const sizeErr = sizeError(input);
    if (sizeErr) throw new HttpishError(400, sizeErr);
    const db = getDb();
    const task = await db.task.findFirst({
      where: { id: taskId, organizationId: ctx.orgId },
      select: { id: true, status: true, attachmentKeys: true },
    });
    if (!task) throw new HttpishError(404, "Task not found");
    if (task.status === "archived") {
      throw new HttpishError(409, "Task is archived — restore it first");
    }
    // Early reject at the cap so the client doesn't upload bytes destined
    // for a 409 at complete. Best-effort only (concurrent mints can both
    // pass) — the in-tx check in completeTaskAttachment stays authoritative.
    if (task.attachmentKeys.length >= MAX_ATTACHMENTS) {
      throw new HttpishError(409, "Attachment limit reached");
    }
    return mint(`tasks/${taskId}`, input);
  });
}

export async function completeTaskAttachment(
  ctx: TasksActorCtx,
  taskId: string,
  storageKey: string,
): Promise<TasksServiceResult<{ attachmentKeys: string[] }>> {
  return run(async () => {
    if (!TASK_KEY_RE.test(storageKey) || !storageKey.startsWith(`tasks/${taskId}/`)) {
      throw new HttpishError(400, "Invalid storage key");
    }
    if (!(await objectExists(storageKey))) {
      throw new HttpishError(404, "Object not found in bucket");
    }
    return withTransaction(async (tx: Prisma.TransactionClient) => {
      const task = await tx.task.findFirst({
        where: { id: taskId, organizationId: ctx.orgId },
        select: { id: true, status: true, attachmentKeys: true },
      });
      if (!task) throw new HttpishError(404, "Task not found");
      if (task.status === "archived") {
        throw new HttpishError(409, "Task is archived — restore it first");
      }
      if (task.attachmentKeys.includes(storageKey)) {
        // Idempotent retry (client re-POSTed complete) — no write, no audit.
        return { attachmentKeys: task.attachmentKeys };
      }
      if (task.attachmentKeys.length >= MAX_ATTACHMENTS) {
        throw new HttpishError(409, "Attachment limit reached");
      }
      const next = [...task.attachmentKeys, storageKey];
      // Update-by-PK is the sanctioned exception here: the id comes from the
      // org-scoped findFirst in this same transaction.
      await tx.task.update({ where: { id: taskId }, data: { attachmentKeys: next } });
      await recordAudit(tx, {
        organizationId: ctx.orgId,
        actorUserId: ctx.actorUserId,
        actorRole: ctx.actorRole,
        action: "tasks.task.attachment.add",
        entityType: "Task",
        entityId: taskId,
        meta: { storageKey },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return { attachmentKeys: next };
    });
  });
}

export async function listTaskAttachmentUrls(
  ctx: TasksActorCtx,
  taskId: string,
): Promise<TasksServiceResult<AttachmentUrl[]>> {
  return run(async () => {
    const db = getDb();
    const task = await db.task.findFirst({
      where: { id: taskId, organizationId: ctx.orgId },
      select: { attachmentKeys: true, ticketId: true },
    });
    if (!task) throw new HttpishError(404, "Task not found");
    const own = await toUrls(task.attachmentKeys);
    if (!task.ticketId) return own;
    // Union view: evidence uploaded on the paired ticket shows here read-only.
    const ticket = await db.ticket.findFirst({
      where: { id: task.ticketId, organizationId: ctx.orgId },
      select: { attachmentKeys: true },
    });
    const linked = ticket ? await toUrls(ticket.attachmentKeys) : [];
    return [...own, ...linked.map((e) => ({ ...e, linkedFrom: "ticket" as const }))];
  });
}

export async function removeTaskAttachment(
  ctx: TasksActorCtx,
  taskId: string,
  storageKey: string,
): Promise<TasksServiceResult<{ attachmentKeys: string[] }>> {
  return run(async () => {
    // Malformed keys can never be in the array — reject loudly instead of
    // returning an idempotent no-op, so client bugs keep their log signal.
    if (!TASK_KEY_RE.test(storageKey) || !storageKey.startsWith(`tasks/${taskId}/`)) {
      throw new HttpishError(400, "Invalid storage key");
    }
    return withTransaction(async (tx: Prisma.TransactionClient) => {
      const task = await tx.task.findFirst({
        where: { id: taskId, organizationId: ctx.orgId },
        select: { id: true, status: true, attachmentKeys: true },
      });
      if (!task) throw new HttpishError(404, "Task not found");
      if (task.status === "archived") {
        throw new HttpishError(409, "Task is archived — restore it first");
      }
      if (!task.attachmentKeys.includes(storageKey)) {
        // Idempotent — already gone, nothing to write or audit.
        return { attachmentKeys: task.attachmentKeys };
      }
      const next = task.attachmentKeys.filter((key) => key !== storageKey);
      // Sanctioned update-by-PK after the org-scoped read in this same tx.
      await tx.task.update({ where: { id: taskId }, data: { attachmentKeys: next } });
      await recordAudit(tx, {
        organizationId: ctx.orgId,
        actorUserId: ctx.actorUserId,
        actorRole: ctx.actorRole,
        action: "tasks.task.attachment.remove",
        entityType: "Task",
        entityId: taskId,
        meta: { storageKey },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return { attachmentKeys: next };
    });
  });
}

// ─── Tickets ─────────────────────────────────────────────────────────────────
// Resolved/void tickets are immutable history — attachments freeze with them.

export async function mintTicketAttachmentUploadUrl(
  ctx: TasksActorCtx,
  ticketId: string,
  input: AttachmentUploadUrlInput,
): Promise<TasksServiceResult<SignedUpload>> {
  return run(async () => {
    // Free check first — reject bad mime/size without a DB roundtrip.
    const sizeErr = sizeError(input);
    if (sizeErr) throw new HttpishError(400, sizeErr);
    const db = getDb();
    const ticket = await db.ticket.findFirst({
      where: { id: ticketId, organizationId: ctx.orgId },
      select: { id: true, status: true, attachmentKeys: true },
    });
    if (!ticket) throw new HttpishError(404, "Ticket not found");
    if (!TICKET_OPEN.has(ticket.status)) {
      throw new HttpishError(409, "Ticket is closed — attachments are frozen");
    }
    // Early reject at the cap — best-effort; the in-tx check in
    // completeTicketAttachment stays authoritative.
    if (ticket.attachmentKeys.length >= MAX_ATTACHMENTS) {
      throw new HttpishError(409, "Attachment limit reached");
    }
    return mint(`tickets/${ticketId}`, input);
  });
}

export async function completeTicketAttachment(
  ctx: TasksActorCtx,
  ticketId: string,
  storageKey: string,
): Promise<TasksServiceResult<{ attachmentKeys: string[] }>> {
  return run(async () => {
    if (!TICKET_KEY_RE.test(storageKey) || !storageKey.startsWith(`tickets/${ticketId}/`)) {
      throw new HttpishError(400, "Invalid storage key");
    }
    if (!(await objectExists(storageKey))) {
      throw new HttpishError(404, "Object not found in bucket");
    }
    return withTransaction(async (tx: Prisma.TransactionClient) => {
      const ticket = await tx.ticket.findFirst({
        where: { id: ticketId, organizationId: ctx.orgId },
        select: { id: true, status: true, attachmentKeys: true },
      });
      if (!ticket) throw new HttpishError(404, "Ticket not found");
      if (!TICKET_OPEN.has(ticket.status)) {
        throw new HttpishError(409, "Ticket is closed — attachments are frozen");
      }
      if (ticket.attachmentKeys.includes(storageKey)) {
        return { attachmentKeys: ticket.attachmentKeys };
      }
      if (ticket.attachmentKeys.length >= MAX_ATTACHMENTS) {
        throw new HttpishError(409, "Attachment limit reached");
      }
      const next = [...ticket.attachmentKeys, storageKey];
      // Sanctioned update-by-PK after the org-scoped read in this same tx.
      await tx.ticket.update({ where: { id: ticketId }, data: { attachmentKeys: next } });
      await recordAudit(tx, {
        organizationId: ctx.orgId,
        actorUserId: ctx.actorUserId,
        actorRole: ctx.actorRole,
        action: "tasks.ticket.attachment.add",
        entityType: "Ticket",
        entityId: ticketId,
        meta: { storageKey },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return { attachmentKeys: next };
    });
  });
}

export async function listTicketAttachmentUrls(
  ctx: TasksActorCtx,
  ticketId: string,
): Promise<TasksServiceResult<AttachmentUrl[]>> {
  return run(async () => {
    const db = getDb();
    const ticket = await db.ticket.findFirst({
      where: { id: ticketId, organizationId: ctx.orgId },
      select: { attachmentKeys: true },
    });
    if (!ticket) throw new HttpishError(404, "Ticket not found");
    const own = await toUrls(ticket.attachmentKeys);
    // Union view: evidence uploaded on the paired board task shows here
    // read-only. ticketId isn't unique on Task, so union across all of them.
    const tasks = await db.task.findMany({
      where: { ticketId, organizationId: ctx.orgId },
      select: { attachmentKeys: true },
    });
    const taskKeys = [...new Set(tasks.flatMap((t) => t.attachmentKeys))];
    const linked = await toUrls(taskKeys);
    return [...own, ...linked.map((e) => ({ ...e, linkedFrom: "task" as const }))];
  });
}

export async function removeTicketAttachment(
  ctx: TasksActorCtx,
  ticketId: string,
  storageKey: string,
): Promise<TasksServiceResult<{ attachmentKeys: string[] }>> {
  return run(async () => {
    // Malformed keys can never be in the array — reject loudly instead of
    // returning an idempotent no-op, so client bugs keep their log signal.
    if (!TICKET_KEY_RE.test(storageKey) || !storageKey.startsWith(`tickets/${ticketId}/`)) {
      throw new HttpishError(400, "Invalid storage key");
    }
    return withTransaction(async (tx: Prisma.TransactionClient) => {
      const ticket = await tx.ticket.findFirst({
        where: { id: ticketId, organizationId: ctx.orgId },
        select: { id: true, status: true, attachmentKeys: true },
      });
      if (!ticket) throw new HttpishError(404, "Ticket not found");
      if (!TICKET_OPEN.has(ticket.status)) {
        throw new HttpishError(409, "Ticket is closed — attachments are frozen");
      }
      if (!ticket.attachmentKeys.includes(storageKey)) {
        return { attachmentKeys: ticket.attachmentKeys };
      }
      const next = ticket.attachmentKeys.filter((key) => key !== storageKey);
      // Sanctioned update-by-PK after the org-scoped read in this same tx.
      await tx.ticket.update({ where: { id: ticketId }, data: { attachmentKeys: next } });
      await recordAudit(tx, {
        organizationId: ctx.orgId,
        actorUserId: ctx.actorUserId,
        actorRole: ctx.actorRole,
        action: "tasks.ticket.attachment.remove",
        entityType: "Ticket",
        entityId: ticketId,
        meta: { storageKey },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return { attachmentKeys: next };
    });
  });
}

// ─── Unit-history ────────────────────────────────────────────────────────────
// History entries are immutable rows; their attachmentKeys are set at create
// time (quick-log / resolve in tasks.service). This module only mints upload
// URLs, validates the keys the client hands back, and lists per-unit media.

export async function mintHistoryAttachmentUploadUrl(
  ctx: TasksActorCtx,
  unitId: string,
  input: AttachmentUploadUrlInput,
): Promise<TasksServiceResult<SignedUpload>> {
  return run(async () => {
    // Free check first — reject bad mime/size without a DB roundtrip.
    const sizeErr = sizeError(input);
    if (sizeErr) throw new HttpishError(400, sizeErr);
    const db = getDb();
    const unit = await db.listing.findFirst({
      where: { id: unitId, organizationId: ctx.orgId },
      select: { id: true },
    });
    if (!unit) throw new HttpishError(404, "Unit not found");
    return mint(`unit-history/${unitId}`, input);
  });
}

/**
 * Pre-create validation for history attachmentKeys supplied by the client
 * (quick-log / resolve payloads). Returns the first error message, or null
 * when every key is shape-valid, unit-scoped, and actually in the bucket.
 */
export async function validateHistoryKeys(
  unitId: string,
  keys: string[],
): Promise<string | null> {
  for (const key of keys) {
    if (!HISTORY_KEY_RE.test(key) || !key.startsWith(`unit-history/${unitId}/`)) {
      return "Invalid attachment key";
    }
    if (!(await objectExists(key))) {
      return "Attachment not found in storage";
    }
  }
  return null;
}

export async function listUnitHistoryAttachmentUrls(
  ctx: TasksActorCtx,
  unitId: string,
): Promise<TasksServiceResult<AttachmentUrl[]>> {
  return run(async () => {
    const db = getDb();
    const unit = await db.listing.findFirst({
      where: { id: unitId, organizationId: ctx.orgId },
      select: { id: true },
    });
    if (!unit) throw new HttpishError(404, "Unit not found");
    const entries = await db.ticketHistory.findMany({
      where: { organizationId: ctx.orgId, unitId },
      select: { attachmentKeys: true },
    });
    // The same object can be referenced by several history entries — sign once.
    const keys = [...new Set(entries.flatMap((entry) => entry.attachmentKeys))];
    return toUrls(keys);
  });
}
