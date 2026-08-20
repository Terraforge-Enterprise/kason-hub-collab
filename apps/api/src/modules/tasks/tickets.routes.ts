import { Hono } from "hono";
import type { Context } from "hono";
import type { ZodError } from "zod";
import {
  attachmentCompleteSchema,
  attachmentUploadUrlSchema,
  resolveTicketSchema,
  ticketLifecycleSchema,
  updateTicketSchema,
} from "@kason/shared";
import { requireRole } from "../../middleware/require-role";
import type { SessionPayload } from "../../lib/auth";
import type { AdminRole } from "../../lib/rbac";
import { getActorHeaders } from "../../lib/actor-ctx";
import { formatZodError } from "../../lib/zod-error-mapper";
import { tasksFlagGate } from "./tasks.gate";
import {
  getTicketService,
  reopenTicketService,
  resolveTicketService,
  updateTicketService,
  voidTicketService,
} from "./tickets.service";
import {
  completeTicketAttachment,
  listTicketAttachmentUrls,
  mintTicketAttachmentUploadUrl,
  removeTicketAttachment,
} from "./tasks-media.service";
import type { TasksActorCtx } from "./tasks.types";

// NOTE deliberate route absences: no DELETE /:id (tickets retire via void, never
// hard-delete) and no history mutation routes — history is immutable by design.
const ticketsRoutes = new Hono<{ Variables: { session: SessionPayload } }>();

ticketsRoutes.use("*", tasksFlagGate);
ticketsRoutes.use("*", requireRole("editor"));

type TicketsCtx = Context<{ Variables: { session: SessionPayload } }>;

function actor(c: TicketsCtx): TasksActorCtx {
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

function zerr(c: TicketsCtx, err: ZodError) {
  const friendly = formatZodError(err, { domain: "tasks" });
  return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
}

// ─── Read + edit (open tickets only — service enforces) ─────────────────────

ticketsRoutes.get("/:id", async (c) => {
  const result = await getTicketService(actor(c), c.req.param("id"));
  if (!result.ok) return c.json({ error: result.error }, result.status as 404);
  return c.json({ data: result.data });
});

ticketsRoutes.patch("/:id", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = updateTicketSchema.safeParse({ ...body, ticketId: c.req.param("id") });
  if (!parsed.success) return zerr(c, parsed.error);
  const result = await updateTicketService(actor(c), parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404 | 409);
  return c.json({ data: result.data });
});

// ─── Lifecycle ───────────────────────────────────────────────────────────────

ticketsRoutes.post("/:id/resolve", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = resolveTicketSchema.safeParse({ ...body, ticketId: c.req.param("id") });
  if (!parsed.success) return zerr(c, parsed.error);
  const result = await resolveTicketService(actor(c), parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404 | 409);
  return c.json({ data: result.data });
});

ticketsRoutes.post("/:id/void", requireRole("manager"), async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = ticketLifecycleSchema.safeParse({ ...body, ticketId: c.req.param("id") });
  if (!parsed.success) return zerr(c, parsed.error);
  const result = await voidTicketService(actor(c), parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 404 | 409);
  return c.json({ data: result.data });
});

ticketsRoutes.post("/:id/reopen", requireRole("manager"), async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = ticketLifecycleSchema.safeParse({ ...body, ticketId: c.req.param("id") });
  if (!parsed.success) return zerr(c, parsed.error);
  const result = await reopenTicketService(actor(c), parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 404 | 409);
  return c.json({ data: result.data });
});

// ─── Attachments (open-time evidence — frozen once the ticket closes) ────────

ticketsRoutes.post("/:id/attachments/upload-url", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = attachmentUploadUrlSchema.safeParse(body);
  if (!parsed.success) return zerr(c, parsed.error);
  const result = await mintTicketAttachmentUploadUrl(actor(c), c.req.param("id"), parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404 | 409);
  return c.json({ data: result.data });
});

ticketsRoutes.post("/:id/attachments/complete", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = attachmentCompleteSchema.safeParse(body);
  if (!parsed.success) return zerr(c, parsed.error);
  const result = await completeTicketAttachment(actor(c), c.req.param("id"), parsed.data.storageKey);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404 | 409);
  return c.json({ data: result.data });
});

ticketsRoutes.get("/:id/attachments/download-urls", async (c) => {
  const result = await listTicketAttachmentUrls(actor(c), c.req.param("id"));
  if (!result.ok) return c.json({ error: result.error }, result.status as 404);
  return c.json({ data: result.data });
});

ticketsRoutes.delete("/:id/attachments", async (c) => {
  const key = c.req.query("key");
  if (!key) return c.json({ error: "Missing key" }, 400);
  const result = await removeTicketAttachment(actor(c), c.req.param("id"), key);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404 | 409);
  return c.json({ data: result.data });
});

export { ticketsRoutes };
