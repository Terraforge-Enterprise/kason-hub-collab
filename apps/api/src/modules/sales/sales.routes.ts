import { Hono, type Context } from "hono";
import type { SessionPayload } from "../../lib/auth";
import { requireRole } from "../../middleware/require-role";
import type { AdminRole } from "../../lib/rbac";
import { getActorHeaders } from "../../lib/actor-ctx";
import { formatZodError } from "../../lib/zod-error-mapper";
import {
  approveSalesUnitService,
  createSalesUnitService,
  getRenovationTransitionsService,
  getSalesUnitByIdService,
  getSalesUnitsService,
  listSourceQueueService,
  needsAmendmentSalesUnitService,
  rejectSalesUnitService,
  setRenovationStatusService,
  updateSalesUnitService,
} from "./sales.service";
import {
  amendmentSchema,
  createSalesUnitSchema,
  listSalesUnitsQuery,
  rejectSchema,
  renovationStatusSchema,
  updateSalesUnitSchema,
} from "./sales.validation";

const salesRoutes = new Hono<{ Variables: { session: SessionPayload } }>();

salesRoutes.use("*", requireRole("editor"));

type SalesCtx = Context<{ Variables: { session: SessionPayload } }>;

function extractActorContext(c: SalesCtx) {
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

// ─── Sales units (CRUD) ──────────────────────────────────────────────────────

salesRoutes.get("/units", async (c) => {
  const session = c.get("session");
  const parsed = listSalesUnitsQuery.safeParse(c.req.query());
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "sales" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await getSalesUnitsService(
    { orgId: session.orgId, role: session.role },
    parsed.data,
  );
  if (!result.ok) return c.json({ error: result.error }, result.status as 403);
  return c.json({ data: result.data });
});

salesRoutes.get("/units/:id", async (c) => {
  const session = c.get("session");
  const id = c.req.param("id");
  const result = await getSalesUnitByIdService(
    { orgId: session.orgId, role: session.role },
    id,
  );
  if (!result.ok) return c.json({ error: result.error }, result.status as 403 | 404);
  return c.json({ data: result.data });
});

salesRoutes.post("/units", requireRole("manager"), async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = createSalesUnitSchema.safeParse(body);
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "sales" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await createSalesUnitService(extractActorContext(c), parsed.data);
  if (!result.ok) {
    return c.json({ error: result.error }, result.status as 400 | 403 | 404 | 409);
  }
  return c.json({ data: result.data }, result.status as 201);
});

salesRoutes.patch("/units/:id", requireRole("manager"), async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = updateSalesUnitSchema.safeParse(body);
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "sales" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await updateSalesUnitService(extractActorContext(c), id, parsed.data);
  if (!result.ok) {
    return c.json({ error: result.error }, result.status as 400 | 403 | 404 | 409);
  }
  return c.json({ data: result.data });
});

// ─── Source queue ────────────────────────────────────────────────────────────

salesRoutes.get("/source-queue", requireRole("manager"), async (c) => {
  const result = await listSourceQueueService(extractActorContext(c));
  if (!result.ok) return c.json({ error: result.error }, result.status as 403);
  return c.json({ data: result.data });
});

salesRoutes.post("/source-queue/:id/approve", requireRole("manager"), async (c) => {
  const id = c.req.param("id");
  const result = await approveSalesUnitService(extractActorContext(c), id);
  if (!result.ok) {
    return c.json({ error: result.error }, result.status as 400 | 403 | 404 | 409);
  }
  return c.json({ data: result.data });
});

salesRoutes.post("/source-queue/:id/reject", requireRole("manager"), async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = rejectSchema.safeParse(body);
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "sales" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await rejectSalesUnitService(extractActorContext(c), id, parsed.data);
  if (!result.ok) {
    return c.json({ error: result.error }, result.status as 400 | 403 | 404);
  }
  return c.json({ data: result.data });
});

salesRoutes.post(
  "/source-queue/:id/needs-amendment",
  requireRole("manager"),
  async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ error: "Invalid JSON body" }, 400);
    const parsed = amendmentSchema.safeParse(body);
    if (!parsed.success) {
      const friendly = formatZodError(parsed.error, { domain: "sales" });
      return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
    }
    const result = await needsAmendmentSalesUnitService(
      extractActorContext(c),
      id,
      parsed.data,
    );
    if (!result.ok) {
      return c.json({ error: result.error }, result.status as 400 | 403 | 404);
    }
    return c.json({ data: result.data });
  },
);

// ─── Renovation status ───────────────────────────────────────────────────────

salesRoutes.patch("/units/:id/renovation", requireRole("manager"), async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = renovationStatusSchema.safeParse(body);
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "sales" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await setRenovationStatusService(extractActorContext(c), id, parsed.data);
  if (!result.ok) {
    return c.json({ error: result.error }, result.status as 400 | 403 | 404 | 409);
  }
  return c.json({ data: result.data });
});

salesRoutes.get("/units/:id/renovation/transitions", async (c) => {
  const session = c.get("session");
  const id = c.req.param("id");
  const result = await getRenovationTransitionsService(
    { orgId: session.orgId, role: session.role },
    id,
  );
  if (!result.ok) return c.json({ error: result.error }, result.status as 403 | 404);
  return c.json({ data: result.data });
});

export { salesRoutes };
