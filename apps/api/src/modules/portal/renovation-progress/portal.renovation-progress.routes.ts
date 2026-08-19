import { Hono, type Context } from "hono";
import { flipStageSchema } from "./portal.renovation-progress.validation";
import {
  flipStageStatusService,
  markRenovationCompleteService,
} from "./portal.renovation-progress.service";
import type { PortalEnv } from "../auth/portal.auth.types";
import { formatZodError } from "../../../lib/zod-error-mapper";

const portalRenovationProgressRoutes = new Hono<PortalEnv>();

portalRenovationProgressRoutes.patch("/:progressId/stage/:stageProgressId", async (c: Context<PortalEnv>) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { code: "invalid_json", message: "Invalid JSON body." } }, 400);
  }
  const parsed = flipStageSchema.safeParse(body);
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "renovations" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const session = c.get("session");
  if (!session.partyId) {
    return c.json({ error: { code: "no_party", message: "Session has no associated party." } }, 403);
  }
  const result = await flipStageStatusService(
    c.req.param("progressId")!,
    c.req.param("stageProgressId")!,
    parsed.data,
    { orgId: session.orgId, agentPartyId: session.partyId, actorUserId: session.userId },
  );
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404 | 409);
  return c.json({ data: result.data });
});

portalRenovationProgressRoutes.post("/:progressId/mark-complete", async (c: Context<PortalEnv>) => {
  const session = c.get("session");
  if (!session.partyId) {
    return c.json({ error: { code: "no_party", message: "Session has no associated party." } }, 403);
  }
  const result = await markRenovationCompleteService(
    c.req.param("progressId")!,
    { orgId: session.orgId, agentPartyId: session.partyId, actorUserId: session.userId },
  );
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404 | 409);
  return c.json({ data: result.data });
});

export { portalRenovationProgressRoutes };
