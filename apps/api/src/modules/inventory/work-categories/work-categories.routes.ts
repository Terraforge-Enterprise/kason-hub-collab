import { Hono } from "hono";
import type { Context } from "hono";
import type { SessionPayload } from "../../../lib/auth";
import type { AdminRole } from "../../../lib/rbac";
import { getActorHeaders } from "../../../lib/actor-ctx";
import { requireRole } from "../../../middleware/require-role";
import { tasksFlagGate } from "../../tasks/tasks.gate";
import {
  type WorkCategoryActorCtx,
  createWorkCategoryService,
  deleteWorkCategoryService,
  getWorkCategoryUsageService,
  listWorkCategoriesService,
  updateWorkCategoryService,
} from "./work-categories.service";
import { createWorkCategorySchema, updateWorkCategorySchema } from "./work-categories.validation";

const workCategoriesRoutes = new Hono<{ Variables: { session: SessionPayload } }>();

type WorkCategoriesCtx = Context<{ Variables: { session: SessionPayload } }>;

function actor(c: WorkCategoriesCtx): WorkCategoryActorCtx {
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

workCategoriesRoutes.use("*", tasksFlagGate);
workCategoriesRoutes.use("*", requireRole("editor"));

workCategoriesRoutes.get("/", async (c) => {
  const session = c.get("session");
  const activeOnly = c.req.query("activeOnly") === "true";
  return c.json({ data: await listWorkCategoriesService(session.orgId, { activeOnly }) });
});

workCategoriesRoutes.get("/:id/usage", async (c) => {
  const session = c.get("session");
  const result = await getWorkCategoryUsageService(session.orgId, c.req.param("id"));
  if (!result.ok) return c.json({ error: result.error }, result.status as 404);
  return c.json({ data: result.data });
});

workCategoriesRoutes.post("/", requireRole("manager"), async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: { code: "invalid_json", message: "Invalid JSON body" } }, 400);
  const parsed = createWorkCategorySchema.safeParse(body);
  if (!parsed.success) return c.json({ error: { code: "invalid_payload", message: parsed.error.issues[0]?.message ?? "Invalid payload" } }, 400);
  const result = await createWorkCategoryService(actor(c), parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 409);
  return c.json({ data: result.data }, 201);
});

workCategoriesRoutes.patch("/:id", requireRole("manager"), async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: { code: "invalid_json", message: "Invalid JSON body" } }, 400);
  const parsed = updateWorkCategorySchema.safeParse(body);
  if (!parsed.success) return c.json({ error: { code: "invalid_payload", message: parsed.error.issues[0]?.message ?? "Invalid payload" } }, 400);
  const result = await updateWorkCategoryService(actor(c), c.req.param("id"), parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 404 | 409);
  return c.json({ data: result.data });
});

workCategoriesRoutes.delete("/:id", requireRole("manager"), async (c) => {
  const result = await deleteWorkCategoryService(actor(c), c.req.param("id"));
  if (!result.ok) return c.json({ error: result.error }, result.status as 404 | 409);
  return c.json({ data: result.data });
});

export { workCategoriesRoutes };
