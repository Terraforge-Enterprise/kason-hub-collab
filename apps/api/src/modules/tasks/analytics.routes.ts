import { Hono } from "hono";
import type { Context } from "hono";
import type { ZodError } from "zod";
import { analyticsQuerySchema, unitMiniStatQuerySchema } from "@kason/shared";
import { requireRole } from "../../middleware/require-role";
import type { SessionPayload } from "../../lib/auth";
import { getActorHeaders } from "../../lib/actor-ctx";
import { formatZodError } from "../../lib/zod-error-mapper";
import { tasksFlagGate } from "./tasks.gate";
import { analyticsFlagGate } from "./analytics.gate";
import { getUnitsAnalytics, getCategoryLens, getTrend, getUnitMiniStat } from "./analytics.service";
import type { TasksActorCtx } from "./tasks.types";

const analyticsRoutes = new Hono<{ Variables: { session: SessionPayload } }>();

// Double gate: both flags must be on; either off → 404 (no shape leak).
analyticsRoutes.use("*", tasksFlagGate, analyticsFlagGate);

type AnalyticsCtx = Context<{ Variables: { session: SessionPayload } }>;

function actor(c: AnalyticsCtx): TasksActorCtx {
  const session = c.get("session");
  const { ip, userAgent } = getActorHeaders(c);
  return {
    orgId: session.orgId,
    actorUserId: session.userId,
    actorRole: session.role as import("../../lib/rbac").AdminRole,
    ip,
    userAgent,
  };
}

function zerr(c: AnalyticsCtx, err: ZodError) {
  const friendly = formatZodError(err, { domain: "tasks" });
  return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
}

// ─── GET /analytics/units — ranked unit table (manager+) ─────────────────────

analyticsRoutes.get("/units", requireRole("manager"), async (c) => {
  const parsed = analyticsQuerySchema.safeParse(c.req.query());
  if (!parsed.success) return zerr(c, parsed.error);
  const result = await getUnitsAnalytics(actor(c).orgId, parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 500);
  return c.json({ data: result.data }, 200);
});

// ─── GET /analytics/categories — category lens (manager+) ────────────────────

analyticsRoutes.get("/categories", requireRole("manager"), async (c) => {
  const parsed = analyticsQuerySchema.safeParse(c.req.query());
  if (!parsed.success) return zerr(c, parsed.error);
  const result = await getCategoryLens(actor(c).orgId, parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 500);
  return c.json({ data: result.data }, 200);
});

// ─── GET /analytics/trend — monthly volume trend (manager+) ──────────────────

analyticsRoutes.get("/trend", requireRole("manager"), async (c) => {
  const parsed = analyticsQuerySchema.safeParse(c.req.query());
  if (!parsed.success) return zerr(c, parsed.error);
  const result = await getTrend(actor(c).orgId, parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 500);
  return c.json({ data: result.data }, 200);
});

// ─── GET /analytics/units/:unitId — per-unit mini-stat (editor+) ─────────────

analyticsRoutes.get("/units/:unitId", requireRole("editor"), async (c) => {
  const parsed = unitMiniStatQuerySchema.safeParse(c.req.query());
  if (!parsed.success) return zerr(c, parsed.error);
  const result = await getUnitMiniStat(actor(c).orgId, c.req.param("unitId"), parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404 | 500);
  return c.json({ data: result.data }, 200);
});

export { analyticsRoutes };
