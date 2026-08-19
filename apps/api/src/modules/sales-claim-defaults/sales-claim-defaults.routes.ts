import { Hono, type Context } from "hono";
import type { SessionPayload } from "../../lib/auth";
import { requireRole } from "../../middleware/require-role";
import { getDefaultsService, upsertDefaultsService } from "./sales-claim-defaults.service";
import { upsertDefaultsSchema } from "./sales-claim-defaults.validation";

const salesClaimDefaultsRoutes = new Hono<{ Variables: { session: SessionPayload } }>();
salesClaimDefaultsRoutes.use("*", requireRole("editor"));

type Ctx = Context<{ Variables: { session: SessionPayload } }>;
const ctxOf = (c: Ctx) => ({ orgId: c.get("session").orgId, actorUserId: c.get("session").userId });

salesClaimDefaultsRoutes.get("/", async (c) => {
  const appliesTo = c.req.query("appliesTo") ?? "__catchall__";
  const result = await getDefaultsService({ orgId: c.get("session").orgId, appliesTo });
  if (!result.ok) return c.json({ error: result.error }, result.status as 404);
  return c.json({ data: result.data });
});

salesClaimDefaultsRoutes.put("/", requireRole("manager"), async (c) => {
  const body = upsertDefaultsSchema.safeParse(await c.req.json());
  if (!body.success) return c.json({ error: { code: "invalid_body", message: body.error.message } }, 400);
  const result = await upsertDefaultsService(body.data, ctxOf(c));
  if (!result.ok) return c.json({ error: result.error }, result.status as 400);
  return c.json({ data: result.data });
});

export { salesClaimDefaultsRoutes };
