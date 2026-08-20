import { Hono } from "hono";
import type { Context } from "hono";
import type { ZodError } from "zod";
import {
  assignTaskSchema,
  attachmentCompleteSchema,
  attachmentUploadUrlSchema,
  createTaskSchema,
  listTasksQuerySchema,
  moveTaskSchema,
  taskLifecycleSchema,
  updateTaskSchema,
} from "@kason/shared";
import { requireRole } from "../../middleware/require-role";
import type { SessionPayload } from "../../lib/auth";
import type { AdminRole } from "../../lib/rbac";
import { getActorHeaders } from "../../lib/actor-ctx";
import { formatZodError } from "../../lib/zod-error-mapper";
import { tasksFlagGate } from "./tasks.gate";
import {
  archiveTaskService,
  assignTaskService,
  createTaskService,
  deleteTaskService,
  getTaskService,
  listTasksService,
  moveTaskService,
  restoreTaskService,
  updateTaskService,
} from "./tasks.service";
import {
  completeTaskAttachment,
  listTaskAttachmentUrls,
  mintTaskAttachmentUploadUrl,
  removeTaskAttachment,
} from "./tasks-media.service";
import type { TasksActorCtx } from "./tasks.types";

const tasksRoutes = new Hono<{ Variables: { session: SessionPayload } }>();

tasksRoutes.use("*", tasksFlagGate);
tasksRoutes.use("*", requireRole("editor"));

type TasksCtx = Context<{ Variables: { session: SessionPayload } }>;

function actor(c: TasksCtx): TasksActorCtx {
  const session = c.get("session");
  const { ip, userAgent } = getActorHeaders(c);
  return {
    orgId: session.orgId,
    actorUserId: session.userId,
    actorRole: session.role as AdminRole,
    ip,
    userAgent,
  };
}

function zerr(c: TasksCtx, err: ZodError) {
  const friendly = formatZodError(err, { domain: "tasks" });
  return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
}

// ─── Board ───────────────────────────────────────────────────────────────────

tasksRoutes.get("/", async (c) => {
  const parsed = listTasksQuerySchema.safeParse(c.req.query());
  if (!parsed.success) return zerr(c, parsed.error);
  const result = await listTasksService(actor(c), parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400);
  return c.json({ data: result.data });
});

tasksRoutes.post("/", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = createTaskSchema.safeParse(body);
  if (!parsed.success) return zerr(c, parsed.error);
  const result = await createTaskService(actor(c), parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404 | 409);
  return c.json({ data: result.data }, result.status as 201);
});

tasksRoutes.get("/:id", async (c) => {
  const result = await getTaskService(actor(c), c.req.param("id"));
  if (!result.ok) return c.json({ error: result.error }, result.status as 404);
  return c.json({ data: result.data });
});

tasksRoutes.patch("/:id", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = updateTaskSchema.safeParse({ ...body, taskId: c.req.param("id") });
  if (!parsed.success) return zerr(c, parsed.error);
  const result = await updateTaskService(actor(c), parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404 | 409);
  return c.json({ data: result.data });
});

tasksRoutes.patch("/:id/status", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = moveTaskSchema.safeParse({ ...body, taskId: c.req.param("id") });
  if (!parsed.success) return zerr(c, parsed.error);
  const result = await moveTaskService(actor(c), parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404 | 409);
  return c.json({ data: result.data });
});

tasksRoutes.patch("/:id/assignee", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = assignTaskSchema.safeParse({ ...body, taskId: c.req.param("id") });
  if (!parsed.success) return zerr(c, parsed.error);
  const result = await assignTaskService(actor(c), parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404 | 409);
  return c.json({ data: result.data });
});

// ─── Lifecycle (manager+) ────────────────────────────────────────────────────

tasksRoutes.post("/:id/archive", requireRole("manager"), async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = taskLifecycleSchema.safeParse({ ...body, taskId: c.req.param("id") });
  if (!parsed.success) return zerr(c, parsed.error);
  const result = await archiveTaskService(actor(c), parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 404 | 409);
  return c.json({ data: result.data });
});

tasksRoutes.post("/:id/restore", requireRole("manager"), async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = taskLifecycleSchema.safeParse({ ...body, taskId: c.req.param("id") });
  if (!parsed.success) return zerr(c, parsed.error);
  const result = await restoreTaskService(actor(c), parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 404 | 409);
  return c.json({ data: result.data });
});

tasksRoutes.delete("/:id", requireRole("manager"), async (c) => {
  const result = await deleteTaskService(actor(c), c.req.param("id"));
  if (!result.ok) return c.json({ error: result.error }, result.status as 404);
  return c.json({ data: result.data });
});

// ─── Attachments (media pipeline lands in Task 3 — stubs for now) ───────────

tasksRoutes.post("/:id/attachments/upload-url", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = attachmentUploadUrlSchema.safeParse(body);
  if (!parsed.success) return zerr(c, parsed.error);
  const result = await mintTaskAttachmentUploadUrl(actor(c), c.req.param("id"), parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404 | 409);
  return c.json({ data: result.data });
});

tasksRoutes.post("/:id/attachments/complete", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = attachmentCompleteSchema.safeParse(body);
  if (!parsed.success) return zerr(c, parsed.error);
  const result = await completeTaskAttachment(actor(c), c.req.param("id"), parsed.data.storageKey);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404 | 409);
  return c.json({ data: result.data });
});

tasksRoutes.get("/:id/attachments/download-urls", async (c) => {
  const result = await listTaskAttachmentUrls(actor(c), c.req.param("id"));
  if (!result.ok) return c.json({ error: result.error }, result.status as 404);
  return c.json({ data: result.data });
});

tasksRoutes.delete("/:id/attachments", async (c) => {
  const key = c.req.query("key");
  if (!key) return c.json({ error: "Missing key" }, 400);
  const result = await removeTaskAttachment(actor(c), c.req.param("id"), key);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404 | 409);
  return c.json({ data: result.data });
});

export { tasksRoutes };
