import { Hono } from "hono";
import type { SessionPayload } from "../../lib/auth";
import { requireRole } from "../../middleware/require-role";
import { formatZodError } from "../../lib/zod-error-mapper";
import { updateOrganizationProfileSchema } from "./validation";
import {
  getOrganizationProfileService,
  updateOrganizationProfileService,
} from "./service";

const organizationRoutes = new Hono<{ Variables: { session: SessionPayload } }>();

organizationRoutes.get("/profile", requireRole("manager"), async (c) => {
  const session = c.get("session");
  const result = await getOrganizationProfileService(session);
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json({ data: result.data });
});

organizationRoutes.patch("/profile", requireRole("manager"), async (c) => {
  const session = c.get("session");
  const body = await c.req.json().catch(() => null);
  const parsed = updateOrganizationProfileSchema.safeParse(body);
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error);
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await updateOrganizationProfileService(session, parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json({ data: result.data });
});

export { organizationRoutes };
