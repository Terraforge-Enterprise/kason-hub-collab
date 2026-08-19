import { Hono } from "hono";
import type { DashboardSession } from "./dashboard.types";
import { getDashboardStatsService, getDashboardSummaryService } from "./dashboard.service";

const dashboardRoutes = new Hono<{ Variables: { session: DashboardSession } }>();

dashboardRoutes.get("/summary", async (c) => {
  const data = await getDashboardSummaryService(c.get("session"));
  return c.json({ data });
});

dashboardRoutes.get("/stats", async (c) => {
  const data = await getDashboardStatsService(c.get("session"));
  return c.json({ data });
});

export { dashboardRoutes };
