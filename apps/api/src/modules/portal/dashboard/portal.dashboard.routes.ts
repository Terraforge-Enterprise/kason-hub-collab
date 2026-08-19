import { Hono } from "hono";
import type { PortalEnv } from "../auth/portal.auth.types";
import { getDashboardData, getOwnerDashboardData } from "./portal.dashboard.repository";

const portalDashboardRoutes = new Hono<PortalEnv>();

portalDashboardRoutes.get("/", async (c) => {
  const session = c.get("session");
  const data = session.userType === "owner"
    ? await getOwnerDashboardData({ partyId: session.partyId, orgId: session.orgId })
    : await getDashboardData({ partyId: session.partyId, orgId: session.orgId });
  return c.json({ data });
});

export { portalDashboardRoutes };
