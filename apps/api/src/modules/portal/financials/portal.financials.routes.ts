import { Hono } from "hono";
import type { PortalEnv } from "../auth/portal.auth.types";
import { isPhase2FlagEnabled } from "../../../lib/feature-flags";
import { getFinancials, getFinancialsExtended } from "./portal.financials.repository";

const portalFinancialsRoutes = new Hono<PortalEnv>();

portalFinancialsRoutes.get("/", async (c) => {
  const session = c.get("session");
  const month = c.req.query("month");
  const propertyId = c.req.query("propertyId");
  const scope = { partyId: session.partyId, orgId: session.orgId };

  // Phase-2 owner-billing: when the flag is ON, layer the owner's
  // management-fee / expenses / net-remittance breakdown onto the response.
  // When OFF, return the EXISTING getFinancials shape BYTE-IDENTICALLY — the
  // extension is purely additive and never reachable with the flag off.
  const data = isPhase2FlagEnabled("ENABLE_PHASE2_OWNER_BILLING")
    ? await getFinancialsExtended(scope, month, propertyId)
    : await getFinancials(scope, month, propertyId);

  return c.json({ data });
});

export { portalFinancialsRoutes };
