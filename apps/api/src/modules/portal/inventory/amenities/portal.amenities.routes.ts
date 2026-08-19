import { Hono } from "hono";
import type { PortalEnv } from "../../auth/portal.auth.types";
import { listAmenitiesService } from "../../../inventory/amenities/amenities.service";

const portalAmenitiesRoutes = new Hono<PortalEnv>();

// portalAuth gate is applied at the parent mount point (portal.routes.ts).
portalAmenitiesRoutes.get("/", async (c) => {
  const session = c.get("session");
  const rows = await listAmenitiesService(session.orgId, { activeOnly: true });
  // Slim shape — agent doesn't need isActive/createdAt/updatedAt
  const slim = rows.map((r) => ({ id: r.id, name: r.name, sortOrder: r.sortOrder }));
  return c.json({ data: slim });
});

export { portalAmenitiesRoutes };
