import { Hono } from "hono";
import type { PortalEnv } from "../auth/portal.auth.types";
import { getOwnerDocuments } from "./portal.owner-docs.repository";

const portalOwnerDocsRoutes = new Hono<PortalEnv>();

portalOwnerDocsRoutes.get("/", async (c) => {
  const session = c.get("session");
  const data = await getOwnerDocuments({ partyId: session.partyId, orgId: session.orgId });
  return c.json({ data });
});

export { portalOwnerDocsRoutes };
