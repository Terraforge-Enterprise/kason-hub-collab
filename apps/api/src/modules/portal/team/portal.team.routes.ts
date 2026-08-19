import { Hono } from "hono";
import type { PortalEnv } from "../auth/portal.auth.types";
import {
  getPortalTeam,
  getPortalUplineChain,
  getPortalDownlineSubtree,
  listSplittableAgents,
} from "./portal.team.repository";

const portalTeamRoutes = new Hono<PortalEnv>();

portalTeamRoutes.get("/", async (c) => {
  const session = c.get("session");
  if (!session.partyId) {
    return c.json({ error: "AGENT_PROFILE_MISSING" }, 403);
  }
  const data = await getPortalTeam(session.partyId, session.orgId);
  return c.json({ data });
});

// GET /portal/team/upline-chain
//
// Returns the caller's reporting chain from organization root → self
// (root-first ordering). The synthetic org node sits separately in
// `data.organization` so the UI can render it distinctly. The agent
// themselves is included in `chain` with `isSelf: true` so the UI can
// highlight the leaf.
//
// Privacy: only ids/names/levels are returned for the chain. Contact
// details are intentionally NOT exposed — agents shouldn't snoop on
// their managers' phones/emails. This also makes the response cheap
// enough to cache.
// GET /portal-api/team/splittable
//
// Slim list of agents the caller can name on a claim split: self + upline
// chain + direct downlines. Names + ids only — used to wire `partyPartyId`
// on portal sales/renovation claim split rows so commission analytics can
// join through the Party graph instead of relying on free-text names.
portalTeamRoutes.get("/splittable", async (c) => {
  const session = c.get("session");
  if (!session.partyId) {
    return c.json({ error: "AGENT_PROFILE_MISSING" }, 403);
  }
  const data = await listSplittableAgents(session.partyId, session.orgId);
  return c.json({ data });
});

portalTeamRoutes.get("/upline-chain", async (c) => {
  const session = c.get("session");
  if (!session.partyId) {
    return c.json({ error: "AGENT_PROFILE_MISSING" }, 403);
  }
  const data = await getPortalUplineChain(session.partyId, session.orgId);
  if (!data) {
    return c.json({ error: "AGENT_PROFILE_MISSING" }, 404);
  }
  return c.json({ data });
});

// GET /portal-api/team/downlines
//
// Full recursive subtree of agents below the caller. Returns every level,
// not just direct reports — Leaders / Pre-Leaders need to manage their whole
// team. Full contact info (name, email, phone) included. Empty array for
// callers with no downlines (New Agents).
portalTeamRoutes.get("/downlines", async (c) => {
  const session = c.get("session");
  if (!session.partyId) {
    return c.json({ error: "AGENT_PROFILE_MISSING" }, 403);
  }
  const data = await getPortalDownlineSubtree(session.partyId, session.orgId);
  return c.json({ data });
});

export { portalTeamRoutes };
