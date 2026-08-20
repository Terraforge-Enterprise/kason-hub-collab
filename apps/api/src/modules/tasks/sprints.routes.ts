import { Hono } from "hono";
import type { Context } from "hono";
import type { ZodError } from "zod";
import {
  createSprintSchema,
  listSprintsQuerySchema,
  sprintLifecycleSchema,
  sprintTrendsQuerySchema,
  updateSprintSchema,
} from "@kason/shared";
import { requireRole } from "../../middleware/require-role";
import type { SessionPayload } from "../../lib/auth";
import type { AdminRole } from "../../lib/rbac";
import { getActorHeaders } from "../../lib/actor-ctx";
import { formatZodError } from "../../lib/zod-error-mapper";
import { tasksFlagGate } from "./tasks.gate";
import { sprintsFlagGate } from "./sprints.gate";
import {
  burndownService,
  closeSprintService,
  createSprintService,
  deleteSprintService,
  getSprintService,
  listSprintsService,
  startSprintService,
  trendsService,
  updateSprintService,
} from "./sprints.service";
import type { TasksActorCtx } from "./tasks.types";

const sprintsRoutes = new Hono<{ Variables: { session: SessionPayload } }>();

// Both gates first (canonical 404 while dark), then editor default; manager
// routes layer requireRole("manager") per-route below (mirrors tasks.routes.ts).
sprintsRoutes.use("*", tasksFlagGate);
sprintsRoutes.use("*", sprintsFlagGate);
sprintsRoutes.use("*", requireRole("editor"));

type SprintsCtx = Context<{ Variables: { session: SessionPayload } }>;

function actor(c: SprintsCtx): TasksActorCtx {
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

function zerr(c: SprintsCtx, err: ZodError) {
  const friendly = formatZodError(err, { domain: "tasks" });
  return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
}

// ─── Reads (editor) ───────────────────────────────────────────────────────────

sprintsRoutes.get("/", async (c) => {
  const parsed = listSprintsQuerySchema.safeParse(c.req.query());
  if (!parsed.success) return zerr(c, parsed.error);
  const result = await listSprintsService(actor(c), parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400);
  return c.json({ data: result.data });
});

// ⚠️ ROUTE ORDER: `/trends` MUST precede `/:id` — otherwise Hono matches it as
// `/:id` with id="trends" and the request falls through to getSprintService (404).
sprintsRoutes.get("/trends", async (c) => {
  const parsed = sprintTrendsQuerySchema.safeParse(c.req.query());
  if (!parsed.success) return zerr(c, parsed.error);
  const result = await trendsService(actor(c), parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400);
  return c.json({ data: result.data });
});

sprintsRoutes.get("/:id", async (c) => {
  const result = await getSprintService(actor(c), c.req.param("id"));
  if (!result.ok) return c.json({ error: result.error }, result.status as 404);
  return c.json({ data: result.data });
});

sprintsRoutes.get("/:id/burndown", async (c) => {
  const result = await burndownService(actor(c), c.req.param("id"));
  if (!result.ok) return c.json({ error: result.error }, result.status as 404);
  return c.json({ data: result.data });
});

// ─── Mutations (manager+) ───────────────────────────────────────────────────

sprintsRoutes.post("/", requireRole("manager"), async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = createSprintSchema.safeParse(body);
  if (!parsed.success) return zerr(c, parsed.error);
  const result = await createSprintService(actor(c), parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404 | 409);
  return c.json({ data: result.data }, result.status as 201);
});

sprintsRoutes.patch("/:id", requireRole("manager"), async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = updateSprintSchema.safeParse({ ...body, sprintId: c.req.param("id") });
  if (!parsed.success) return zerr(c, parsed.error);
  const result = await updateSprintService(actor(c), parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404 | 409);
  return c.json({ data: result.data });
});

sprintsRoutes.post("/:id/start", requireRole("manager"), async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = sprintLifecycleSchema.safeParse({ ...body, sprintId: c.req.param("id") });
  if (!parsed.success) return zerr(c, parsed.error);
  const result = await startSprintService(actor(c), parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404 | 409);
  return c.json({ data: result.data });
});

sprintsRoutes.post("/:id/close", requireRole("manager"), async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = sprintLifecycleSchema.safeParse({ ...body, sprintId: c.req.param("id") });
  if (!parsed.success) return zerr(c, parsed.error);
  const result = await closeSprintService(actor(c), parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404 | 409);
  return c.json({ data: result.data });
});

sprintsRoutes.delete("/:id", requireRole("manager"), async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = sprintLifecycleSchema.safeParse({ ...body, sprintId: c.req.param("id") });
  if (!parsed.success) return zerr(c, parsed.error);
  const result = await deleteSprintService(actor(c), parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404 | 409);
  return c.json({ data: result.data });
});

export { sprintsRoutes };
