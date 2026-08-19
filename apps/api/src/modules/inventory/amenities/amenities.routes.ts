import { Hono } from "hono";
import type { SessionPayload } from "../../../lib/auth";
import { requireRole } from "../../../middleware/require-role";
import {
  createAmenityService,
  deleteAmenityService,
  getAmenityUsageService,
  listAmenitiesService,
  updateAmenityService,
} from "./amenities.service";
import { createAmenitySchema, updateAmenitySchema } from "./amenities.validation";

const amenitiesRoutes = new Hono<{ Variables: { session: SessionPayload } }>();

// Route-level: editor+ for reads. Per-route gate for writes.
amenitiesRoutes.use("*", requireRole("editor"));

amenitiesRoutes.get("/", async (c) => {
  const session = c.get("session");
  const activeOnly = c.req.query("activeOnly") === "true";
  const rows = await listAmenitiesService(session.orgId, { activeOnly });
  return c.json({ data: rows });
});

amenitiesRoutes.get("/:id/usage", async (c) => {
  const session = c.get("session");
  const result = await getAmenityUsageService(session.orgId, c.req.param("id"));
  if (!result.ok) return c.json({ error: result.error }, result.status as 404);
  return c.json({ data: result.data });
});

amenitiesRoutes.post("/", requireRole("manager"), async (c) => {
  const session = c.get("session");
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: { code: "invalid_json", message: "Invalid JSON body" } }, 400);
  const parsed = createAmenitySchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: { code: "invalid_payload", message: parsed.error.issues[0]?.message ?? "Invalid payload" } },
      400,
    );
  }
  const result = await createAmenityService(session.orgId, parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 409);
  return c.json({ data: result.data }, 201);
});

amenitiesRoutes.patch("/:id", requireRole("manager"), async (c) => {
  const session = c.get("session");
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: { code: "invalid_json", message: "Invalid JSON body" } }, 400);
  const parsed = updateAmenitySchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: { code: "invalid_payload", message: parsed.error.issues[0]?.message ?? "Invalid payload" } },
      400,
    );
  }
  const result = await updateAmenityService(session.orgId, c.req.param("id"), parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 404 | 409);
  return c.json({ data: result.data });
});

amenitiesRoutes.delete("/:id", requireRole("manager"), async (c) => {
  const session = c.get("session");
  const result = await deleteAmenityService(session.orgId, c.req.param("id"));
  if (!result.ok) return c.json({ error: result.error }, result.status as 404);
  return c.json({ data: result.data });
});

export { amenitiesRoutes };
