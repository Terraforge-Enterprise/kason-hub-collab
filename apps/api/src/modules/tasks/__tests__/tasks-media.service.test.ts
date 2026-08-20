import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── Hoisted mock state ──────────────────────────────────────────────────────
// The service reads db.task/db.ticket/db.listing/db.ticketHistory directly via
// getDb(), and runs its writes through withTransaction(tx => ...). Both get the
// same vi.fn() graph so tests can pin reads and assert in-tx writes.
const { mockDb, mockTx } = vi.hoisted(() => {
  const mockTx = {
    task: { findFirst: vi.fn(), update: vi.fn() },
    ticket: { findFirst: vi.fn(), update: vi.fn() },
  };
  const mockDb = {
    task: { findFirst: vi.fn(), findMany: vi.fn() },
    ticket: { findFirst: vi.fn() },
    listing: { findFirst: vi.fn() },
    ticketHistory: { findMany: vi.fn() },
  };
  return { mockDb, mockTx };
});

vi.mock("@kason/db", () => ({ getDb: () => mockDb }));

vi.mock("../tasks.repository", () => ({
  withTransaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb(mockTx)),
}));

vi.mock("../../../lib/audit", () => ({
  recordAudit: vi.fn(async () => undefined),
}));

vi.mock("../../../lib/storage", () => ({
  createSignedUploadUrl: vi.fn(async (p: { storageKey: string; contentType: string }) => ({
    uploadUrl: `https://signed.test/${p.storageKey}`,
    method: "PUT" as const,
    headers: { "content-type": p.contentType },
    storageKey: p.storageKey,
  })),
  createSignedDownloadUrl: vi.fn(
    async (key: string, opts?: { transform?: unknown }) =>
      opts?.transform ? `https://cdn.test/thumb/${key}` : `https://cdn.test/full/${key}`,
  ),
  objectExists: vi.fn(async () => true),
}));

import { recordAudit } from "../../../lib/audit";
import { runtimeConfig } from "../../../lib/runtime-config";
import {
  createSignedDownloadUrl,
  createSignedUploadUrl,
  objectExists,
} from "../../../lib/storage";
import { withTransaction } from "../tasks.repository";
import {
  HISTORY_KEY_RE,
  TASK_KEY_RE,
  TICKET_KEY_RE,
  completeTaskAttachment,
  completeTicketAttachment,
  listTaskAttachmentUrls,
  listTicketAttachmentUrls,
  listUnitHistoryAttachmentUrls,
  mintHistoryAttachmentUploadUrl,
  mintTaskAttachmentUploadUrl,
  mintTicketAttachmentUploadUrl,
  removeTaskAttachment,
  removeTicketAttachment,
  validateHistoryKeys,
} from "../tasks-media.service";
import type { TasksServiceResult } from "../tasks.types";

const ORG = "00000000-0000-0000-0000-000000000001";
const ACTOR = "00000000-0000-0000-0000-000000000002";
const TASK = "00000000-0000-0000-0000-0000000000bb";
const TICKET = "00000000-0000-0000-0000-0000000000dd";
const UNIT = "00000000-0000-0000-0000-0000000000cc";
const OTHER = "99999999-9999-9999-9999-999999999999";
const FILE_ID = "11111111-2222-3333-4444-555555555555";

const ctx = {
  orgId: ORG,
  actorUserId: ACTOR,
  actorRole: "manager" as const,
  ip: "1.2.3.4",
  userAgent: "vitest",
};

const taskKey = (ext = "jpg", id = TASK) => `tasks/${id}/${FILE_ID}.${ext}`;
const ticketKey = (ext = "jpg", id = TICKET) => `tickets/${id}/${FILE_ID}.${ext}`;
const historyKey = (ext = "jpg", id = UNIT) => `unit-history/${id}/${FILE_ID}.${ext}`;

const ALLOWED_EXTS = ["jpg", "png", "webp", "mp4", "mov", "webm", "pdf"];

/** 12 distinct shape-valid keys — an entity already at the attachment cap. */
const capKeys = (prefix: string) =>
  Array.from(
    { length: 12 },
    (_, i) => `${prefix}/${String(i).padStart(8, "0")}-0000-0000-0000-000000000000.jpg`,
  );

const IMG_INPUT = { filename: "photo.jpg", mimeType: "image/jpeg", sizeBytes: 1024 };

const ARCHIVED_MSG = "Task is archived — restore it first";
const FROZEN_MSG = "Ticket is closed — attachments are frozen";

function expectErr<T>(r: TasksServiceResult<T>, status: number, error: string): void {
  expect(r).toEqual({ ok: false, status, error });
}

function dataOf<T>(r: TasksServiceResult<T>): T {
  if (!r.ok) throw new Error(`expected ok result, got ${r.status}: ${r.error}`);
  return r.data;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.task.findFirst.mockResolvedValue(null);
  mockDb.task.findMany.mockResolvedValue([]);
  mockDb.ticket.findFirst.mockResolvedValue(null);
  mockDb.listing.findFirst.mockResolvedValue(null);
  mockDb.ticketHistory.findMany.mockResolvedValue([]);
  mockTx.task.findFirst.mockResolvedValue(null);
  mockTx.task.update.mockResolvedValue({});
  mockTx.ticket.findFirst.mockResolvedValue(null);
  mockTx.ticket.update.mockResolvedValue({});
  vi.mocked(objectExists).mockResolvedValue(true);
});

// ─── Key regexes ─────────────────────────────────────────────────────────────

describe("storage key regexes", () => {
  it("accept jpg/png/webp/mp4/mov/webm/pdf for each entity prefix", () => {
    for (const ext of ALLOWED_EXTS) {
      expect(TASK_KEY_RE.test(taskKey(ext))).toBe(true);
      expect(TICKET_KEY_RE.test(ticketKey(ext))).toBe(true);
      expect(HISTORY_KEY_RE.test(historyKey(ext))).toBe(true);
    }
  });

  it("reject any other extension", () => {
    for (const ext of ["gif", "exe", "txt", "heic", "svg", "jpg.exe"]) {
      expect(TASK_KEY_RE.test(taskKey(ext))).toBe(false);
      expect(TICKET_KEY_RE.test(ticketKey(ext))).toBe(false);
      expect(HISTORY_KEY_RE.test(historyKey(ext))).toBe(false);
    }
  });

  it("reject malformed and cross-entity keys", () => {
    expect(TASK_KEY_RE.test(`tasks/${TASK}/short.jpg`)).toBe(false); // non-uuid filename
    expect(TASK_KEY_RE.test(`tasks/${FILE_ID}.jpg`)).toBe(false); // missing segment
    expect(TASK_KEY_RE.test(ticketKey())).toBe(false); // wrong prefix
    expect(TICKET_KEY_RE.test(taskKey())).toBe(false);
    expect(HISTORY_KEY_RE.test(taskKey())).toBe(false);
  });
});

// ─── Task mint ───────────────────────────────────────────────────────────────

describe("mintTaskAttachmentUploadUrl", () => {
  it("404s on unknown task (org-scoped read)", async () => {
    const result = await mintTaskAttachmentUploadUrl(ctx, TASK, IMG_INPUT);
    expectErr(result, 404, "Task not found");
    expect(mockDb.task.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: TASK, organizationId: ORG } }),
    );
  });

  it("409s on archived task", async () => {
    mockDb.task.findFirst.mockResolvedValue({ id: TASK, status: "archived", attachmentKeys: [] });
    const result = await mintTaskAttachmentUploadUrl(ctx, TASK, IMG_INPUT);
    expectErr(result, 409, ARCHIVED_MSG);
  });

  it("409s at the 12-attachment cap before minting a signed URL", async () => {
    mockDb.task.findFirst.mockResolvedValue({
      id: TASK,
      status: "todo",
      attachmentKeys: capKeys(`tasks/${TASK}`),
    });
    const result = await mintTaskAttachmentUploadUrl(ctx, TASK, IMG_INPUT);
    expectErr(result, 409, "Attachment limit reached");
    expect(createSignedUploadUrl).not.toHaveBeenCalled();
  });

  it("400s on unknown mime type without touching the DB", async () => {
    const result = await mintTaskAttachmentUploadUrl(ctx, TASK, {
      filename: "anim.gif",
      mimeType: "image/gif",
      sizeBytes: 100,
    });
    expectErr(result, 400, "Unsupported file type");
    expect(createSignedUploadUrl).not.toHaveBeenCalled();
    expect(mockDb.task.findFirst).not.toHaveBeenCalled();
  });

  it("400s when an image exceeds photoMaxBytes", async () => {
    const cap = runtimeConfig.limits.photoMaxBytes;
    const result = await mintTaskAttachmentUploadUrl(ctx, TASK, {
      filename: "big.png",
      mimeType: "image/png",
      sizeBytes: cap + 1,
    });
    expectErr(result, 400, `File exceeds the ${Math.round(cap / 1024 / 1024)} MB limit`);
  });

  it("400s when a video exceeds videoMaxBytes", async () => {
    const cap = runtimeConfig.limits.videoMaxBytes;
    const result = await mintTaskAttachmentUploadUrl(ctx, TASK, {
      filename: "big.mp4",
      mimeType: "video/mp4",
      sizeBytes: cap + 1,
    });
    expectErr(result, 400, `File exceeds the ${Math.round(cap / 1024 / 1024)} MB limit`);
  });

  it("caps pdf at the photo limit (not the video limit)", async () => {
    const cap = runtimeConfig.limits.photoMaxBytes;
    const result = await mintTaskAttachmentUploadUrl(ctx, TASK, {
      filename: "quote.pdf",
      mimeType: "application/pdf",
      sizeBytes: cap + 1,
    });
    expectErr(result, 400, `File exceeds the ${Math.round(cap / 1024 / 1024)} MB limit`);
  });

  it("mints a tasks/<id>/<uuid>.<ext> upload URL with lowercased content type", async () => {
    mockDb.task.findFirst.mockResolvedValue({
      id: TASK,
      status: "in_progress",
      attachmentKeys: [],
    });
    const result = await mintTaskAttachmentUploadUrl(ctx, TASK, {
      filename: "Clip.MOV",
      mimeType: "VIDEO/QUICKTIME",
      sizeBytes: 1024,
    });
    const data = dataOf(result);
    expect(data.storageKey).toMatch(new RegExp(`^tasks/${TASK}/[0-9a-f-]{36}\\.mov$`));
    expect(data.method).toBe("PUT");
    expect(data.uploadUrl).toContain(data.storageKey);
    expect(createSignedUploadUrl).toHaveBeenCalledWith({
      storageKey: data.storageKey,
      contentType: "video/quicktime",
    });
  });
});

// ─── Task complete ───────────────────────────────────────────────────────────

describe("completeTaskAttachment", () => {
  it("400s on a key failing the regex", async () => {
    const result = await completeTaskAttachment(ctx, TASK, taskKey("gif"));
    expectErr(result, 400, "Invalid storage key");
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it("400s on a wrong entity prefix or another task's key", async () => {
    expectErr(await completeTaskAttachment(ctx, TASK, ticketKey()), 400, "Invalid storage key");
    expectErr(
      await completeTaskAttachment(ctx, TASK, taskKey("jpg", OTHER)),
      400,
      "Invalid storage key",
    );
  });

  it("404s when the object is not in the bucket", async () => {
    vi.mocked(objectExists).mockResolvedValue(false);
    const result = await completeTaskAttachment(ctx, TASK, taskKey());
    expectErr(result, 404, "Object not found in bucket");
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it("404s when the task is missing inside the tx", async () => {
    const result = await completeTaskAttachment(ctx, TASK, taskKey());
    expectErr(result, 404, "Task not found");
  });

  it("409s on an archived task inside the tx", async () => {
    mockTx.task.findFirst.mockResolvedValue({ id: TASK, status: "archived", attachmentKeys: [] });
    const result = await completeTaskAttachment(ctx, TASK, taskKey());
    expectErr(result, 409, ARCHIVED_MSG);
  });

  it("is idempotent: key already present → same array, no write, no audit", async () => {
    const key = taskKey();
    mockTx.task.findFirst.mockResolvedValue({ id: TASK, status: "todo", attachmentKeys: [key] });
    const result = await completeTaskAttachment(ctx, TASK, key);
    expect(dataOf(result)).toEqual({ attachmentKeys: [key] });
    expect(mockTx.task.update).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("409s when the 12-attachment cap is reached", async () => {
    mockTx.task.findFirst.mockResolvedValue({
      id: TASK,
      status: "todo",
      attachmentKeys: capKeys(`tasks/${TASK}`),
    });
    const result = await completeTaskAttachment(ctx, TASK, taskKey());
    expectErr(result, 409, "Attachment limit reached");
    expect(mockTx.task.update).not.toHaveBeenCalled();
  });

  it("appends the key and records an in-tx audit on success", async () => {
    const existing = taskKey("png");
    const key = taskKey("jpg");
    mockTx.task.findFirst.mockResolvedValue({
      id: TASK,
      status: "todo",
      attachmentKeys: [existing],
    });
    const result = await completeTaskAttachment(ctx, TASK, key);
    expect(dataOf(result)).toEqual({ attachmentKeys: [existing, key] });
    expect(mockTx.task.update).toHaveBeenCalledWith({
      where: { id: TASK },
      data: { attachmentKeys: [existing, key] },
    });
    expect(recordAudit).toHaveBeenCalledTimes(1);
    expect(recordAudit).toHaveBeenCalledWith(
      mockTx,
      expect.objectContaining({
        organizationId: ORG,
        actorUserId: ACTOR,
        action: "tasks.task.attachment.add",
        entityType: "Task",
        entityId: TASK,
        meta: { storageKey: key },
      }),
    );
  });
});

// ─── Task list/remove ────────────────────────────────────────────────────────

describe("listTaskAttachmentUrls", () => {
  it("404s on unknown task", async () => {
    const result = await listTaskAttachmentUrls(ctx, TASK);
    expectErr(result, 404, "Task not found");
  });

  it("returns url+thumbnail for images, thumbnail null for video/pdf", async () => {
    const jpg = taskKey("jpg");
    const mp4 = taskKey("mp4");
    const pdf = taskKey("pdf");
    mockDb.task.findFirst.mockResolvedValue({ attachmentKeys: [jpg, mp4, pdf] });
    const data = dataOf(await listTaskAttachmentUrls(ctx, TASK));
    expect(data).toEqual([
      { key: jpg, url: `https://cdn.test/full/${jpg}`, thumbnail: `https://cdn.test/thumb/${jpg}`, kind: "image" },
      { key: mp4, url: `https://cdn.test/full/${mp4}`, thumbnail: null, kind: "video" },
      { key: pdf, url: `https://cdn.test/full/${pdf}`, thumbnail: null, kind: "pdf" },
    ]);
    expect(createSignedDownloadUrl).toHaveBeenCalledWith(jpg, {
      transform: { width: 600, height: 600, resize: "cover", quality: 75 },
    });
  });

  it("unions the paired ticket's files after the task's own, flagged linkedFrom: ticket", async () => {
    const own = taskKey("jpg");
    const shared = ticketKey("png");
    mockDb.task.findFirst.mockResolvedValue({ attachmentKeys: [own], ticketId: TICKET });
    mockDb.ticket.findFirst.mockResolvedValue({ attachmentKeys: [shared] });
    const data = dataOf(await listTaskAttachmentUrls(ctx, TASK));
    expect(data.map((e) => [e.key, e.linkedFrom])).toEqual([
      [own, undefined],
      [shared, "ticket"],
    ]);
  });

  it("returns own files only when the linked ticket row is gone", async () => {
    const own = taskKey("jpg");
    mockDb.task.findFirst.mockResolvedValue({ attachmentKeys: [own], ticketId: TICKET });
    mockDb.ticket.findFirst.mockResolvedValue(null);
    const data = dataOf(await listTaskAttachmentUrls(ctx, TASK));
    expect(data.map((e) => e.key)).toEqual([own]);
  });
});

describe("removeTaskAttachment", () => {
  it("400s on a malformed or wrong-prefix key before opening a tx", async () => {
    expectErr(await removeTaskAttachment(ctx, TASK, taskKey("gif")), 400, "Invalid storage key");
    expectErr(await removeTaskAttachment(ctx, TASK, ticketKey()), 400, "Invalid storage key");
    expectErr(
      await removeTicketAttachment(ctx, TICKET, taskKey()),
      400,
      "Invalid storage key",
    );
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it("404s on unknown task", async () => {
    const result = await removeTaskAttachment(ctx, TASK, taskKey());
    expectErr(result, 404, "Task not found");
  });

  it("is idempotent: absent key → same array, no write, no audit", async () => {
    const other = taskKey("png");
    mockTx.task.findFirst.mockResolvedValue({ id: TASK, status: "todo", attachmentKeys: [other] });
    const result = await removeTaskAttachment(ctx, TASK, taskKey("jpg"));
    expect(dataOf(result)).toEqual({ attachmentKeys: [other] });
    expect(mockTx.task.update).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("filters the key and records an in-tx remove audit on success", async () => {
    const keep = taskKey("png");
    const gone = taskKey("jpg");
    mockTx.task.findFirst.mockResolvedValue({
      id: TASK,
      status: "todo",
      attachmentKeys: [keep, gone],
    });
    const result = await removeTaskAttachment(ctx, TASK, gone);
    expect(dataOf(result)).toEqual({ attachmentKeys: [keep] });
    expect(mockTx.task.update).toHaveBeenCalledWith({
      where: { id: TASK },
      data: { attachmentKeys: [keep] },
    });
    expect(recordAudit).toHaveBeenCalledWith(
      mockTx,
      expect.objectContaining({
        action: "tasks.task.attachment.remove",
        entityType: "Task",
        entityId: TASK,
        meta: { storageKey: gone },
      }),
    );
  });
});

// ─── Ticket mint/complete/list/remove ────────────────────────────────────────

describe("mintTicketAttachmentUploadUrl", () => {
  it("404s on unknown ticket", async () => {
    const result = await mintTicketAttachmentUploadUrl(ctx, TICKET, IMG_INPUT);
    expectErr(result, 404, "Ticket not found");
    expect(mockDb.ticket.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: TICKET, organizationId: ORG } }),
    );
  });

  it.each(["resolved", "void"])("409s when the ticket is %s", async (status) => {
    mockDb.ticket.findFirst.mockResolvedValue({ id: TICKET, status, attachmentKeys: [] });
    const result = await mintTicketAttachmentUploadUrl(ctx, TICKET, IMG_INPUT);
    expectErr(result, 409, FROZEN_MSG);
  });

  it("409s at the 12-attachment cap before minting a signed URL", async () => {
    mockDb.ticket.findFirst.mockResolvedValue({
      id: TICKET,
      status: "open",
      attachmentKeys: capKeys(`tickets/${TICKET}`),
    });
    const result = await mintTicketAttachmentUploadUrl(ctx, TICKET, IMG_INPUT);
    expectErr(result, 409, "Attachment limit reached");
    expect(createSignedUploadUrl).not.toHaveBeenCalled();
  });

  it("mints a tickets/<id>/ key for an open ticket", async () => {
    mockDb.ticket.findFirst.mockResolvedValue({
      id: TICKET,
      status: "in_progress",
      attachmentKeys: [],
    });
    const data = dataOf(await mintTicketAttachmentUploadUrl(ctx, TICKET, IMG_INPUT));
    expect(data.storageKey).toMatch(new RegExp(`^tickets/${TICKET}/[0-9a-f-]{36}\\.jpg$`));
  });
});

describe("completeTicketAttachment", () => {
  it("400s on a wrong entity prefix", async () => {
    expectErr(await completeTicketAttachment(ctx, TICKET, taskKey()), 400, "Invalid storage key");
  });

  it("404s when the object is not in the bucket", async () => {
    vi.mocked(objectExists).mockResolvedValue(false);
    expectErr(
      await completeTicketAttachment(ctx, TICKET, ticketKey()),
      404,
      "Object not found in bucket",
    );
  });

  it("409s inside the tx when the ticket is closed", async () => {
    mockTx.ticket.findFirst.mockResolvedValue({
      id: TICKET,
      status: "resolved",
      attachmentKeys: [],
    });
    const result = await completeTicketAttachment(ctx, TICKET, ticketKey());
    expectErr(result, 409, FROZEN_MSG);
  });

  it("is idempotent: key already present → same array, no write, no audit", async () => {
    const key = ticketKey();
    mockTx.ticket.findFirst.mockResolvedValue({
      id: TICKET,
      status: "open",
      attachmentKeys: [key],
    });
    const result = await completeTicketAttachment(ctx, TICKET, key);
    expect(dataOf(result)).toEqual({ attachmentKeys: [key] });
    expect(mockTx.ticket.update).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("409s when the 12-attachment cap is reached", async () => {
    mockTx.ticket.findFirst.mockResolvedValue({
      id: TICKET,
      status: "open",
      attachmentKeys: capKeys(`tickets/${TICKET}`),
    });
    const result = await completeTicketAttachment(ctx, TICKET, ticketKey());
    expectErr(result, 409, "Attachment limit reached");
    expect(mockTx.ticket.update).not.toHaveBeenCalled();
  });

  it("appends the key and records the ticket add audit on success", async () => {
    const key = ticketKey();
    mockTx.ticket.findFirst.mockResolvedValue({ id: TICKET, status: "open", attachmentKeys: [] });
    const result = await completeTicketAttachment(ctx, TICKET, key);
    expect(dataOf(result)).toEqual({ attachmentKeys: [key] });
    expect(mockTx.ticket.update).toHaveBeenCalledWith({
      where: { id: TICKET },
      data: { attachmentKeys: [key] },
    });
    expect(recordAudit).toHaveBeenCalledWith(
      mockTx,
      expect.objectContaining({
        action: "tasks.ticket.attachment.add",
        entityType: "Ticket",
        entityId: TICKET,
        meta: { storageKey: key },
      }),
    );
  });
});

describe("listTicketAttachmentUrls", () => {
  it("404s on unknown ticket", async () => {
    expectErr(await listTicketAttachmentUrls(ctx, TICKET), 404, "Ticket not found");
  });

  it("maps keys to signed urls", async () => {
    const key = ticketKey("webp");
    mockDb.ticket.findFirst.mockResolvedValue({ attachmentKeys: [key] });
    const data = dataOf(await listTicketAttachmentUrls(ctx, TICKET));
    expect(data).toEqual([
      {
        key,
        url: `https://cdn.test/full/${key}`,
        thumbnail: `https://cdn.test/thumb/${key}`,
        kind: "image",
      },
    ]);
  });

  it("unions the paired task's files (deduped) after the ticket's own, flagged linkedFrom: task", async () => {
    const own = ticketKey("webp");
    const shared = taskKey("jpg");
    mockDb.ticket.findFirst.mockResolvedValue({ attachmentKeys: [own] });
    mockDb.task.findMany.mockResolvedValue([
      { attachmentKeys: [shared] },
      { attachmentKeys: [shared] },
    ]);
    const data = dataOf(await listTicketAttachmentUrls(ctx, TICKET));
    expect(data.map((e) => [e.key, e.linkedFrom])).toEqual([
      [own, undefined],
      [shared, "task"],
    ]);
  });
});

describe("removeTicketAttachment", () => {
  it("409s inside the tx when the ticket is closed", async () => {
    mockTx.ticket.findFirst.mockResolvedValue({
      id: TICKET,
      status: "void",
      attachmentKeys: [ticketKey()],
    });
    expectErr(await removeTicketAttachment(ctx, TICKET, ticketKey()), 409, FROZEN_MSG);
  });

  it("is idempotent on an absent key", async () => {
    mockTx.ticket.findFirst.mockResolvedValue({ id: TICKET, status: "open", attachmentKeys: [] });
    const result = await removeTicketAttachment(ctx, TICKET, ticketKey());
    expect(dataOf(result)).toEqual({ attachmentKeys: [] });
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("filters the key and records the ticket remove audit on success", async () => {
    const key = ticketKey();
    mockTx.ticket.findFirst.mockResolvedValue({
      id: TICKET,
      status: "open",
      attachmentKeys: [key],
    });
    const result = await removeTicketAttachment(ctx, TICKET, key);
    expect(dataOf(result)).toEqual({ attachmentKeys: [] });
    expect(recordAudit).toHaveBeenCalledWith(
      mockTx,
      expect.objectContaining({
        action: "tasks.ticket.attachment.remove",
        entityType: "Ticket",
        entityId: TICKET,
      }),
    );
  });
});

// ─── Unit-history pipeline ───────────────────────────────────────────────────

describe("mintHistoryAttachmentUploadUrl", () => {
  it("404s on an unknown unit", async () => {
    const result = await mintHistoryAttachmentUploadUrl(ctx, UNIT, IMG_INPUT);
    expectErr(result, 404, "Unit not found");
    expect(mockDb.listing.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: UNIT, organizationId: ORG } }),
    );
  });

  it("mints a unit-history/<unitId>/ key", async () => {
    mockDb.listing.findFirst.mockResolvedValue({ id: UNIT });
    const data = dataOf(await mintHistoryAttachmentUploadUrl(ctx, UNIT, IMG_INPUT));
    expect(data.storageKey).toMatch(new RegExp(`^unit-history/${UNIT}/[0-9a-f-]{36}\\.jpg$`));
  });
});

describe("validateHistoryKeys", () => {
  it("rejects bad prefixes and other units' keys", async () => {
    expect(await validateHistoryKeys(UNIT, [taskKey()])).toBe("Invalid attachment key");
    expect(await validateHistoryKeys(UNIT, [historyKey("jpg", OTHER)])).toBe(
      "Invalid attachment key",
    );
    expect(await validateHistoryKeys(UNIT, [historyKey("gif")])).toBe("Invalid attachment key");
    expect(objectExists).not.toHaveBeenCalled();
  });

  it("rejects keys missing from storage", async () => {
    vi.mocked(objectExists).mockResolvedValue(false);
    expect(await validateHistoryKeys(UNIT, [historyKey()])).toBe(
      "Attachment not found in storage",
    );
  });

  it("returns null when every key is valid and present", async () => {
    expect(await validateHistoryKeys(UNIT, [historyKey("jpg"), historyKey("pdf")])).toBeNull();
    expect(objectExists).toHaveBeenCalledTimes(2);
  });
});

describe("listUnitHistoryAttachmentUrls", () => {
  it("404s on an unknown unit", async () => {
    expectErr(await listUnitHistoryAttachmentUrls(ctx, UNIT), 404, "Unit not found");
  });

  it("dedupes keys across entries and maps kinds", async () => {
    const img = historyKey("jpg");
    const vid = historyKey("webm");
    const pdf = historyKey("pdf");
    mockDb.listing.findFirst.mockResolvedValue({ id: UNIT });
    mockDb.ticketHistory.findMany.mockResolvedValue([
      { attachmentKeys: [img, vid] },
      { attachmentKeys: [img, pdf] }, // img repeated — must appear once
    ]);
    const data = dataOf(await listUnitHistoryAttachmentUrls(ctx, UNIT));
    expect(data).toEqual([
      { key: img, url: `https://cdn.test/full/${img}`, thumbnail: `https://cdn.test/thumb/${img}`, kind: "image" },
      { key: vid, url: `https://cdn.test/full/${vid}`, thumbnail: null, kind: "video" },
      { key: pdf, url: `https://cdn.test/full/${pdf}`, thumbnail: null, kind: "pdf" },
    ]);
    expect(mockDb.ticketHistory.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: ORG, unitId: UNIT } }),
    );
  });
});
