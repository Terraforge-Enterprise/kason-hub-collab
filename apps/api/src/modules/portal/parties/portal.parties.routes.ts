import { Hono, type Context } from "hono";
import type { PortalEnv } from "../auth/portal.auth.types";
import { ownerSearchQuery, createOwnerSchema } from "./portal.parties.validation";
import { searchOwnersService, createOwnerService } from "./portal.parties.service";
import { formatZodError } from "../../../lib/zod-error-mapper";

const portalPartiesRoutes = new Hono<PortalEnv>();

portalPartiesRoutes.get("/owners", async (c: Context<PortalEnv>) => {
  const parsed = ownerSearchQuery.safeParse({ q: c.req.query("q") });
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "parties" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const session = c.get("session");
  if (!session.partyId) {
    return c.json({ error: { code: "no_party", message: "Session has no associated party." } }, 403);
  }
  const result = await searchOwnersService(parsed.data, {
    orgId: session.orgId,
    agentPartyId: session.partyId,
    actorUserId: session.userId,
  });
  if (!result.ok) return c.json({ error: result.error }, result.status as 400);
  return c.json({ data: result.data });
});

portalPartiesRoutes.post("/owners", async (c: Context<PortalEnv>) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { code: "invalid_json", message: "Invalid JSON body." } }, 400);
  }
  const parsed = createOwnerSchema.safeParse(body);
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "parties" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const session = c.get("session");
  if (!session.partyId) {
    return c.json({ error: { code: "no_party", message: "Session has no associated party." } }, 403);
  }
  const result = await createOwnerService(parsed.data, {
    orgId: session.orgId,
    agentPartyId: session.partyId,
    actorUserId: session.userId,
  });
  if (!result.ok) return c.json({ error: result.error }, result.status as 400);
  return c.json({ data: result.data }, 201);
});

export { portalPartiesRoutes };
