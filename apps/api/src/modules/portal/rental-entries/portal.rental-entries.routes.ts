import { Hono, type Context } from "hono";
import type { PortalEnv } from "../auth/portal.auth.types";
import { createRentalEntrySchema } from "./portal.rental-entries.validation";
import { createRentalEntryService } from "./portal.rental-entries.service";
import { formatZodError } from "../../../lib/zod-error-mapper";

const portalRentalEntriesRoutes = new Hono<PortalEnv>();

portalRentalEntriesRoutes.post("/", async (c: Context<PortalEnv>) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { code: "invalid_json", message: "Invalid JSON body." } }, 400);
  }
  const parsed = createRentalEntrySchema.safeParse(body);
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "sales" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const session = c.get("session");
  if (!session.partyId) {
    return c.json({ error: { code: "no_party", message: "Session has no associated party." } }, 403);
  }
  const result = await createRentalEntryService(parsed.data, {
    orgId: session.orgId,
    agentPartyId: session.partyId,
    actorUserId: session.userId,
  });
  if (!result.ok) {
    return c.json({ error: result.error }, result.status as 400 | 404 | 409);
  }
  return c.json({ data: result.data, warnings: [] }, 201);
});

export { portalRentalEntriesRoutes };
