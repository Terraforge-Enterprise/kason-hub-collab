import { Hono } from "hono";
import { z } from "zod";
import { requireRole } from "../../middleware/require-role";
import type { CommissionsSession } from "./commissions.types";
import { listDealAuditService } from "./deal-audit.service";

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const dealAuditRoutes = new Hono<{ Variables: { session: CommissionsSession } }>();

dealAuditRoutes.use("/", requireRole("manager"));
dealAuditRoutes.use("/*", requireRole("manager"));

dealAuditRoutes.get("/", async (c) => {
  const parsed = querySchema.safeParse({
    page: c.req.query("page"),
    pageSize: c.req.query("pageSize"),
  });
  if (!parsed.success) return c.json({ error: "invalid query" }, 400);
  const res = await listDealAuditService(c.get("session") as any, parsed.data);
  if (!res.ok) return c.json({ error: res.error }, res.status as 400 | 404 | 500);
  return c.json(res.data, 200);
});

export default dealAuditRoutes;
