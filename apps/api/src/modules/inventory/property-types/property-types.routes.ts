import { Hono } from "hono";
import type { Context } from "hono";
import type { SessionPayload } from "../../../lib/auth";
import type { AdminRole } from "../../../lib/rbac";
import { getActorHeaders } from "../../../lib/actor-ctx";
import { requireRole } from "../../../middleware/require-role";
import {
  type PropertyTypeActorCtx,
  createPropertyTypeService,
  deletePropertyTypeService,
  getPropertyTypeUsageService,
  listPropertyTypesService,
  updatePropertyTypeService,
} from "./property-types.service";
import { createPropertyTypeSchema, updatePropertyTypeSchema } from "./property-types.validation";

const propertyTypesRoutes = new Hono<{ Variables: { session: SessionPayload } }>();
type PropertyTypesCtx = Context<{ Variables: { session: SessionPayload } }>;

function actor(c: PropertyTypesCtx): PropertyTypeActorCtx {
  const session = c.get("session");
  const { ip, userAgent } = getActorHeaders(c);
  return { orgId: session.orgId, actorUserId: session.userId, actorRole: session.role as AdminRole, ip, userAgent };
}

// NOTE: no tasksFlagGate — property types are an ungated inventory catalog
// (amenities precedent), not a Tasks-flag-gated feature.
propertyTypesRoutes.use("*", requireRole("editor"));

propertyTypesRoutes.get("/", async (c) => {
  const session = c.get("session");
  const activeOnly = c.req.query("activeOnly") === "true";
  return c.json({ data: await listPropertyTypesService(session.orgId, { activeOnly }) });
});

propertyTypesRoutes.get("/:id/usage", async (c) => {
  const session = c.get("session");
  const result = await getPropertyTypeUsageService(session.orgId, c.req.param("id"));
  if (!result.ok) return c.json({ error: result.error }, result.status as 404);
  return c.json({ data: result.data });
});

propertyTypesRoutes.post("/", requireRole("manager"), async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: { code: "invalid_json", message: "Invalid JSON body" } }, 400);
  const parsed = createPropertyTypeSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: { code: "invalid_payload", message: parsed.error.issues[0]?.message ?? "Invalid payload" } }, 400);
  const result = await createPropertyTypeService(actor(c), parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 409);
  return c.json({ data: result.data }, 201);
});

propertyTypesRoutes.patch("/:id", requireRole("manager"), async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: { code: "invalid_json", message: "Invalid JSON body" } }, 400);
  const parsed = updatePropertyTypeSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: { code: "invalid_payload", message: parsed.error.issues[0]?.message ?? "Invalid payload" } }, 400);
  const result = await updatePropertyTypeService(actor(c), c.req.param("id"), parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 404 | 409);
  return c.json({ data: result.data });
});

propertyTypesRoutes.delete("/:id", requireRole("manager"), async (c) => {
  const result = await deletePropertyTypeService(actor(c), c.req.param("id"));
  if (!result.ok) return c.json({ error: result.error }, result.status as 404 | 409);
  return c.json({ data: result.data });
});

export { propertyTypesRoutes };
