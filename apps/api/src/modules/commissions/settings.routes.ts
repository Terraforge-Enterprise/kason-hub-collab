import { Hono } from "hono";
import { requireRole } from "../../middleware/require-role";
import type { CommissionsSession } from "./commissions.types";
import { getCommissionSettingsService } from "./settings.service";
import {
  createTaTierService,
  updateTaTierService,
  deleteTaTierService,
} from "./ta-tiers.service";
import { createTaTierSchema, updateTaTierSchema } from "@kason/shared";
import { formatZodError } from "../../lib/zod-error-mapper";

/**
 * Commission settings sub-router.
 *
 * Mounted at `/api/commissions/settings` by the parent `commissionsRoutes`.
 *
 * - GET `/`                   — aggregate read, Manager Admin+ (`manager`).
 * - POST   `/ta-tiers`        — Super Admin only (`admin`).
 * - PUT    `/ta-tiers/:id`    — Super Admin only.
 * - DELETE `/ta-tiers/:id`    — Super Admin only.
 *
 * Middleware is pinned per-route (no shared `.use()` block) so the read
 * path stays Manager-accessible while all writes require Super Admin.
 */
const settingsRoutes = new Hono<{ Variables: { session: CommissionsSession } }>();

settingsRoutes.get("/", requireRole("manager"), async (c) => {
  const session = c.get("session");
  const res = await getCommissionSettingsService(session);
  if (!res.ok) {
    return c.json({ error: res.error }, res.status as 400 | 404 | 500);
  }
  return c.json({ data: res.data }, 200);
});

settingsRoutes.post("/ta-tiers", requireRole("admin"), async (c) => {
  const session = c.get("session");
  const parsed = createTaTierSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "commission" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const res = await createTaTierService(session, parsed.data);
  if (!res.ok) {
    return c.json({ error: res.error }, res.status as 400 | 409 | 500);
  }
  return c.json({ data: res.data }, res.status as 201);
});

settingsRoutes.put("/ta-tiers/:id", requireRole("admin"), async (c) => {
  const session = c.get("session");
  const id = c.req.param("id");
  const parsed = updateTaTierSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "commission" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const res = await updateTaTierService(session, id, parsed.data);
  if (!res.ok) {
    return c.json({ error: res.error }, res.status as 400 | 404 | 409 | 500);
  }
  return c.json({ data: res.data }, 200);
});

settingsRoutes.delete("/ta-tiers/:id", requireRole("admin"), async (c) => {
  const session = c.get("session");
  const id = c.req.param("id");
  const res = await deleteTaTierService(session, id);
  if (!res.ok) {
    return c.json({ error: res.error }, res.status as 404 | 500);
  }
  return c.json({ data: res.data }, 200);
});

export default settingsRoutes;
