import { Hono, type Context } from "hono";
import type { SessionPayload } from "../../lib/auth";
import { requireRole } from "../../middleware/require-role";
import type { AdminRole } from "../../lib/rbac";
import { getActorHeaders } from "../../lib/actor-ctx";
import { formatZodError } from "../../lib/zod-error-mapper";
import {
  createLabelService,
  deleteLabelService,
  listLabelsService,
  updateLabelService,
} from "./renovation-settings.service";
import {
  createLabelSchema,
  updateLabelSchema,
} from "./renovation-settings.validation";

const renovationSettingsRoutes = new Hono<{
  Variables: { session: SessionPayload };
}>();

// All renovation-settings endpoints are admin-internal: editors may *read*
// to populate dropdowns, only admins may *write*.
renovationSettingsRoutes.use("*", requireRole("editor"));

type RenoSettingsCtx = Context<{ Variables: { session: SessionPayload } }>;

function actorCtx(c: RenoSettingsCtx) {
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

// ─── Labels ──────────────────────────────────────────────────────────────────

renovationSettingsRoutes.get("/labels", async (c) => {
  const result = await listLabelsService(actorCtx(c));
  if (!result.ok) return c.json({ error: result.error }, result.status as 403);
  return c.json({ data: result.data });
});

renovationSettingsRoutes.post("/labels", requireRole("admin"), async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = createLabelSchema.safeParse(body);
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "renovations" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await createLabelService(actorCtx(c), parsed.data);
  if (!result.ok) {
    return c.json({ error: result.error }, result.status as 400 | 403 | 409);
  }
  return c.json({ data: result.data }, result.status as 201);
});

renovationSettingsRoutes.patch("/labels/:id", requireRole("admin"), async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = updateLabelSchema.safeParse(body);
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "renovations" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await updateLabelService(actorCtx(c), id, parsed.data);
  if (!result.ok) {
    return c.json({ error: result.error }, result.status as 400 | 403 | 404);
  }
  return c.json({ data: result.data });
});

renovationSettingsRoutes.delete(
  "/labels/:id",
  requireRole("admin"),
  async (c) => {
    const id = c.req.param("id");
    const result = await deleteLabelService(actorCtx(c), id);
    if (!result.ok) {
      return c.json({ error: result.error }, result.status as 403 | 404);
    }
    return c.json({ data: result.data });
  },
);

export { renovationSettingsRoutes };
