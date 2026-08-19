import { Hono, type Context } from "hono";
import type { PortalEnv } from "../auth/portal.auth.types";
import { createSalesEntrySchema } from "./portal.sales-entries.validation";
import { createSalesEntryService } from "./portal.sales-entries.service";

const portalSalesEntriesRoutes = new Hono<PortalEnv>();

portalSalesEntriesRoutes.post("/", async (c: Context<PortalEnv>) => {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: { code: "invalid_body", message: "Invalid JSON body" } }, 400);
  }
  const body = createSalesEntrySchema.safeParse(raw);
  if (!body.success) {
    return c.json({ error: { code: "invalid_body", message: body.error.message } }, 400);
  }
  const session = c.get("session");
  if (!session.partyId) {
    return c.json(
      { error: { code: "no_party", message: "Session has no associated party." } },
      403,
    );
  }
  const result = await createSalesEntryService(body.data, {
    orgId: session.orgId,
    agentPartyId: session.partyId,
    actorUserId: session.userId,
  });
  if (!result.ok) {
    return c.json({ error: result.error }, result.status as 400 | 404 | 409);
  }
  return c.json({ data: result.data, warnings: [] }, 201);
});

export { portalSalesEntriesRoutes };
