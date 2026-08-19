import { Hono } from "hono";
import type { PortalEnv } from "../auth/portal.auth.types";
import { getActorHeaders } from "../../../lib/actor-ctx";
import {
  createProjectService,
  getProjectsService,
} from "../../projects";
import {
  createProjectSchema,
  listProjectsQuery,
} from "../../projects/projects.validation";
import type { AdminRole } from "../../../lib/rbac";
import { formatZodError } from "../../../lib/zod-error-mapper";

const portalProjectsRoutes = new Hono<PortalEnv>();

portalProjectsRoutes.get("/", async (c) => {
  const session = c.get("session");
  const parsed = listProjectsQuery.safeParse(c.req.query());
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "inventory" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await getProjectsService(
    { orgId: session.orgId, role: "editor" },
    parsed.data,
  );
  if (!result.ok) return c.json({ error: result.error }, result.status as 403);
  return c.json({ data: result.data });
});

portalProjectsRoutes.post("/", async (c) => {
  const session = c.get("session");
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = createProjectSchema.safeParse(body);
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "inventory" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const { ip, userAgent } = getActorHeaders(c);
  // Portal-created projects start as `unverified` — managers must promote
  // via PATCH /api/projects/:id { status: "active" } before SalesUnits
  // are accepted against them on the admin side. This is the agreed
  // contract noted in projects.types.ts.
  const result = await createProjectService(
    {
      orgId: session.orgId,
      actorUserId: session.userId,
      // Portal session has no operator role; tag it with "editor" so the
      // service-level audit row carries a meaningful role string. The
      // statusOverride bypasses the manager+ gate for portal use.
      actorRole: "editor" as AdminRole,
      ip,
      userAgent,
    },
    parsed.data,
    { statusOverride: "unverified" },
  );
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 403 | 409);
  return c.json({ data: result.data }, result.status as 201);
});

export { portalProjectsRoutes };
