import { Hono } from "hono";
import type { PortalEnv } from "../../auth/portal.auth.types";
import { listPropertyTypesService } from "../../../inventory/property-types/property-types.service";

const portalPropertyTypesRoutes = new Hono<PortalEnv>();

// portalAuth gate is applied at the parent mount point (portal.routes.ts).
portalPropertyTypesRoutes.get("/", async (c) => {
  const session = c.get("session");
  const rows = await listPropertyTypesService(session.orgId, { activeOnly: true });
  const slim = rows.map((r) => ({ id: r.id, name: r.name, sortOrder: r.sortOrder }));
  return c.json({ data: slim });
});

export { portalPropertyTypesRoutes };
