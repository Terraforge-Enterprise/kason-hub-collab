import { Hono, type Context } from "hono";
import type { SessionPayload } from "../../lib/auth";
import { requireRole } from "../../middleware/require-role";
import {
  listStagesService,
  createStageService,
  updateStageService,
  reorderStagesService,
} from "./renovation-stages.service";
import {
  createStageSchema,
  updateStageSchema,
  reorderStagesSchema,
} from "./renovation-stages.validation";

const renovationStagesRoutes = new Hono<{ Variables: { session: SessionPayload } }>();
// Editor reads, manager+ writes (per-route).
renovationStagesRoutes.use("*", requireRole("editor"));

type Ctx = Context<{ Variables: { session: SessionPayload } }>;
const ctxOf = (c: Ctx) => ({ orgId: c.get("session").orgId, actorUserId: c.get("session").userId });

renovationStagesRoutes.get("/", async (c) => {
  const includeArchived = c.req.query("includeArchived") === "true";
  const result = await listStagesService({ orgId: c.get("session").orgId, includeArchived });
  return c.json({ data: result.data });
});

renovationStagesRoutes.post("/", requireRole("manager"), async (c) => {
  const body = createStageSchema.safeParse(await c.req.json());
  if (!body.success) return c.json({ error: { code: "invalid_body", message: body.error.message } }, 400);
  const result = await createStageService(body.data, ctxOf(c));
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 409);
  return c.json({ data: result.data }, 201);
});

renovationStagesRoutes.patch("/:id", requireRole("manager"), async (c) => {
  const id = c.req.param("id");
  const body = updateStageSchema.safeParse(await c.req.json());
  if (!body.success) return c.json({ error: { code: "invalid_body", message: body.error.message } }, 400);
  const result = await updateStageService(id, body.data, ctxOf(c));
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404);
  return c.json({ data: result.data });
});

renovationStagesRoutes.post("/reorder", requireRole("manager"), async (c) => {
  const body = reorderStagesSchema.safeParse(await c.req.json());
  if (!body.success) return c.json({ error: { code: "invalid_body", message: body.error.message } }, 400);
  const result = await reorderStagesService(body.data, ctxOf(c));
  if (!result.ok) return c.json({ error: result.error }, result.status as 400);
  return c.json({ data: result.data });
});

export { renovationStagesRoutes };
