import { Hono, type Context } from "hono";
import { z } from "zod";
import type { SessionPayload } from "../../lib/auth";
import { requireRole } from "../../middleware/require-role";
import type { AdminRole } from "../../lib/rbac";
import { getActorHeaders } from "../../lib/actor-ctx";
import { formatZodError } from "../../lib/zod-error-mapper";
import {
  createProjectService,
  getProjectByIdService,
  getProjectsService,
  updateProjectService,
} from "./projects.service";
import {
  listPendingVerificationService,
  rejectProjectService,
  verifyProjectService,
} from "./projects.verification.service";
import {
  createProjectSchema,
  listProjectsQuery,
  updateProjectSchema,
} from "./projects.validation";

const rejectSchema = z.object({ note: z.string().trim().min(1).max(2000) }).strict();

const projectsRoutes = new Hono<{ Variables: { session: SessionPayload } }>();

// Defence-in-depth: editor gate at the router root, manager+ checks per-mutation.
projectsRoutes.use("*", requireRole("editor"));

type ProjectsCtx = Context<{ Variables: { session: SessionPayload } }>;

function extractActorContext(c: ProjectsCtx) {
  const session = c.get("session");
  const { ip, userAgent } = getActorHeaders(c);
  return {
    orgId: session.orgId,
    actorUserId: session.userId,
    actorRole: session.role as AdminRole,
    ip,
    userAgent,
  };
}

projectsRoutes.get("/", async (c) => {
  const session = c.get("session");
  const parsed = listProjectsQuery.safeParse(c.req.query());
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "inventory" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await getProjectsService(
    { orgId: session.orgId, role: session.role },
    parsed.data,
  );
  if (!result.ok) return c.json({ error: result.error }, result.status as 403);
  return c.json({ data: result.data });
});

projectsRoutes.get("/pending-verification", requireRole("manager"), async (c) => {
  const result = await listPendingVerificationService(c.get("session").orgId);
  return c.json({ data: result.data });
});

projectsRoutes.get("/:id", async (c) => {
  const session = c.get("session");
  const id = c.req.param("id");
  const result = await getProjectByIdService(
    { orgId: session.orgId, role: session.role },
    id,
  );
  if (!result.ok) return c.json({ error: result.error }, result.status as 403 | 404);
  return c.json({ data: result.data });
});

projectsRoutes.post("/", requireRole("manager"), async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = createProjectSchema.safeParse(body);
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "inventory" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await createProjectService(extractActorContext(c), parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 403 | 409);
  return c.json({ data: result.data }, result.status as 201);
});

projectsRoutes.patch("/:id", requireRole("manager"), async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = updateProjectSchema.safeParse(body);
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "inventory" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await updateProjectService(extractActorContext(c), id, parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 403 | 404 | 409);
  return c.json({ data: result.data });
});

projectsRoutes.post("/:id/verify", requireRole("manager"), async (c) => {
  const result = await verifyProjectService(c.req.param("id"), {
    orgId: c.get("session").orgId,
    actorUserId: c.get("session").userId,
  });
  if (!result.ok) return c.json({ error: result.error }, result.status as 404 | 409);
  return c.json({ data: result.data });
});

projectsRoutes.post("/:id/reject", requireRole("manager"), async (c) => {
  const body = rejectSchema.safeParse(await c.req.json());
  if (!body.success) return c.json({ error: { code: "invalid_body", message: body.error.message } }, 400);
  const result = await rejectProjectService(c.req.param("id"), body.data.note, {
    orgId: c.get("session").orgId,
    actorUserId: c.get("session").userId,
  });
  if (!result.ok) return c.json({ error: result.error }, result.status as 404 | 409);
  return c.json({ data: result.data });
});

export { projectsRoutes };
