import { Hono, type Context } from "hono";
import type { PortalEnv } from "../auth/portal.auth.types";
import { renovationStagesRepository } from "../../renovation-stages/renovation-stages.repository";

const portalRenovationStagesRoutes = new Hono<PortalEnv>();

portalRenovationStagesRoutes.get("/", async (c: Context<PortalEnv>) => {
  const session = c.get("session");
  // Active stages only (no archived). Reuses the admin repository.
  const data = await renovationStagesRepository().list(session.orgId, false);
  // Trim down to fields the portal cares about.
  return c.json({
    data: data.map((s) => ({
      id: s.id,
      key: s.key,
      label: s.label,
      sortOrder: s.sortOrder,
    })),
  });
});

export { portalRenovationStagesRoutes };
