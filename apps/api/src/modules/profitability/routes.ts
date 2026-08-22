import { Hono } from "hono";
import { z } from "zod";
import type { SessionPayload } from "../../lib/auth";
import { requirePermission } from "../../middleware/require-permission";
import { getProfitability } from "./service";

const routes = new Hono<{ Variables: { session: SessionPayload } }>();
routes.use("*", requirePermission("profit.view"));
const querySchema = z.object({ view: z.enum(["owner", "tenant"]).default("owner"), month: z.string().regex(/^\d{4}-\d{2}$/).optional(), q: z.string().max(120).optional() });
routes.get("/", async (c) => {
  const parsed = querySchema.safeParse(c.req.query());
  if (!parsed.success) return c.json({ error: "invalid_profitability_filters" }, 400);
  return c.json({ data: await getProfitability(c.get("session").orgId, parsed.data) });
});
export { routes as profitabilityRoutes };
