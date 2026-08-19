import { Hono } from "hono";
import type { SessionPayload } from "../../lib/auth";
import { requireRole } from "../../middleware/require-role";
import { updateOrgCardSettingsSchema } from "./validation";
import { getOrgCardSettings, updateOrgCardSettings } from "./service";
import { formatZodError } from "../../lib/zod-error-mapper";

// NOTE on role gating: spec §6.1 calls for `requireRole('viewer')` on GET and
// `requireRole('editor')` on PUT. This codebase's `AdminRole` union is
// `'editor' | 'manager' | 'admin'` — there is no 'viewer' tier. We therefore
// gate GET on 'editor' (the lowest available admin role) and PUT on 'editor'
// to match the spec's intent ("editor+ can configure"). If a 'viewer' role is
// added later, GET should be relaxed to it.

const organizationCardSettingsRoutes = new Hono<{ Variables: { session: SessionPayload } }>();

// GET /api/organization-card-settings — read the org's card branding settings
organizationCardSettingsRoutes.get("/", requireRole("editor"), async (c) => {
  const session = c.get("session");
  const settings = await getOrgCardSettings(session.orgId);
  return c.json({ data: settings });
});

// PUT /api/organization-card-settings — update branding; flips isConfigured
// when all required fields (agencyName, agencyLicense, addressLine1) are
// non-empty.
organizationCardSettingsRoutes.put("/", requireRole("editor"), async (c) => {
  const session = c.get("session");
  const body = await c.req.json().catch(() => null);
  const parsed = updateOrgCardSettingsSchema.safeParse(body);
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "agent-card" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const updated = await updateOrgCardSettings(session.orgId, parsed.data);
  return c.json({ data: updated });
});

export { organizationCardSettingsRoutes };
