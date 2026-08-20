import { Hono } from "hono";
import type { Context } from "hono";
import type { ZodError } from "zod";
import {
  attachmentUploadUrlSchema,
  createTicketSchema,
  listTicketsQuerySchema,
  quickLogSchema,
} from "@kason/shared";
import { requireRole } from "../../middleware/require-role";
import type { SessionPayload } from "../../lib/auth";
import type { AdminRole } from "../../lib/rbac";
import { getActorHeaders } from "../../lib/actor-ctx";
import { formatZodError } from "../../lib/zod-error-mapper";
import { tasksFlagGate } from "./tasks.gate";
import {
  createTicketService,
  listUnitHistoryService,
  listUnitTicketsService,
  quickLogService,
} from "./tickets.service";
import {
  listUnitHistoryAttachmentUrls,
  mintHistoryAttachmentUploadUrl,
} from "./tasks-media.service";
import type { TasksActorCtx } from "./tasks.types";

// Unit-scoped surface of the Tasks + Tickets module (mounted at /api/units).
// NOTE deliberate route absences: NO PATCH/DELETE on history anywhere —
// immutability is enforced by the absence of mutation routes.
const unitScopedTasksRoutes = new Hono<{ Variables: { session: SessionPayload } }>();

unitScopedTasksRoutes.use("*", tasksFlagGate);
unitScopedTasksRoutes.use("*", requireRole("editor"));

type UnitsCtx = Context<{ Variables: { session: SessionPayload } }>;

function actor(c: UnitsCtx): TasksActorCtx {
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

function zerr(c: UnitsCtx, err: ZodError) {
  const friendly = formatZodError(err, { domain: "tasks" });
  return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
}

// ─── Tickets per unit ────────────────────────────────────────────────────────

unitScopedTasksRoutes.get("/:unitId/tickets", async (c) => {
  const parsed = listTicketsQuerySchema.safeParse(c.req.query());
  if (!parsed.success) return zerr(c, parsed.error);
  const result = await listUnitTicketsService(actor(c), c.req.param("unitId"), parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404);
  return c.json({ data: result.data });
});

unitScopedTasksRoutes.post("/:unitId/tickets", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = createTicketSchema.safeParse({ ...body, unitId: c.req.param("unitId") });
  if (!parsed.success) return zerr(c, parsed.error);
  const result = await createTicketService(actor(c), parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404);
  return c.json({ data: result.data }, result.status as 201);
});

// ─── Immutable history per unit (create + read only) ────────────────────────

unitScopedTasksRoutes.get("/:unitId/history", async (c) => {
  const result = await listUnitHistoryService(actor(c), c.req.param("unitId"));
  if (!result.ok) return c.json({ error: result.error }, result.status as 404);
  return c.json({ data: result.data });
});

unitScopedTasksRoutes.post("/:unitId/history", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = quickLogSchema.safeParse({ ...body, unitId: c.req.param("unitId") });
  if (!parsed.success) return zerr(c, parsed.error);
  const result = await quickLogService(actor(c), parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404);
  return c.json({ data: result.data }, result.status as 201);
});

unitScopedTasksRoutes.post("/:unitId/history/attachments/upload-url", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = attachmentUploadUrlSchema.safeParse(body);
  if (!parsed.success) return zerr(c, parsed.error);
  const result = await mintHistoryAttachmentUploadUrl(actor(c), c.req.param("unitId"), parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404);
  return c.json({ data: result.data });
});

unitScopedTasksRoutes.get("/:unitId/history/attachments/download-urls", async (c) => {
  const result = await listUnitHistoryAttachmentUrls(actor(c), c.req.param("unitId"));
  if (!result.ok) return c.json({ error: result.error }, result.status as 404);
  return c.json({ data: result.data });
});

export { unitScopedTasksRoutes };
