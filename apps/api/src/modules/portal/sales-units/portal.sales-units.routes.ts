import { Hono, type Context } from "hono";
import type { PortalEnv } from "../auth/portal.auth.types";
import { getActorHeaders } from "../../../lib/actor-ctx";
import {
  cancelSalesUnitSourcingService,
  createSalesUnitService,
  getSalesUnitByIdService,
  getSalesUnitsService,
  updateSalesUnitService,
} from "../../sales";
import {
  createSalesUnitSchema,
  listSalesUnitsQuery,
  updateSalesUnitSchema,
} from "../../sales/sales.validation";
import { getPortalSalesUnitDetailService } from "./portal.sales-units.service";
import type { AdminRole } from "../../../lib/rbac";
import { formatZodError } from "../../../lib/zod-error-mapper";

const portalSalesUnitsRoutes = new Hono<PortalEnv>();

function actorCtx(c: Context<PortalEnv>) {
  const session = c.get("session");
  const { ip, userAgent } = getActorHeaders(c);
  return {
    orgId: session.orgId,
    actorUserId: session.userId,
    // Portal session role is the agent's directory role; for service-level
    // audit + RBAC short-circuit we use "editor" — the service relies on
    // the override flags (agentPartyIdOverride / requireOwnerPartyId) to
    // gate the call rather than the role string.
    actorRole: "editor" as AdminRole,
    ip,
    userAgent,
  };
}

portalSalesUnitsRoutes.get("/", async (c) => {
  const session = c.get("session");
  const parsed = listSalesUnitsQuery.safeParse(c.req.query());
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "sales" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await getSalesUnitsService(
    { orgId: session.orgId, role: "editor" },
    { ...parsed.data, agentPartyIdEq: session.partyId },
  );
  if (!result.ok) return c.json({ error: result.error }, result.status as 403);
  return c.json({ data: result.data });
});

portalSalesUnitsRoutes.get("/:id/detail", async (c) => {
  const session = c.get("session");
  if (!session.partyId) return c.json({ error: "no_party" }, 403);
  const result = await getPortalSalesUnitDetailService(
    { orgId: session.orgId, agentPartyId: session.partyId },
    c.req.param("id"),
  );
  if (!result.ok) return c.json({ error: result.error }, result.status as 404);
  return c.json({ data: result.data });
});

portalSalesUnitsRoutes.get("/:id", async (c) => {
  const session = c.get("session");
  const id = c.req.param("id");
  const result = await getSalesUnitByIdService(
    { orgId: session.orgId, role: "editor" },
    id,
  );
  if (!result.ok) return c.json({ error: result.error }, result.status as 403 | 404);
  // Ownership check — agent only sees their own submissions.
  if (result.data.agentPartyId !== session.partyId) {
    return c.json({ error: "Sales unit not found" }, 404);
  }
  return c.json({ data: result.data });
});

portalSalesUnitsRoutes.post("/", async (c) => {
  const session = c.get("session");
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = createSalesUnitSchema.safeParse(body);
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "sales" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await createSalesUnitService(
    actorCtx(c),
    parsed.data,
    {
      agentPartyIdOverride: session.partyId,
      // Per unified-property-sourcing spec §3.1 — the creator IS the
      // in-charge. Server forces this; whatever the portal payload sent
      // for inChargePartyId is ignored.
      inChargePartyIdOverride: session.partyId,
      sourceFlag: "AGENT_SOURCED",
      sourcingApproved: false,
      auditAction: "sales.unit.submit.portal",
    },
  );
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 403 | 404 | 409);
  return c.json({ data: result.data }, result.status as 201);
});

portalSalesUnitsRoutes.patch("/:id", async (c) => {
  const session = c.get("session");
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = updateSalesUnitSchema.safeParse(body);
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "sales" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await updateSalesUnitService(
    actorCtx(c),
    id,
    parsed.data,
    {
      requireOwnerPartyId: session.partyId,
      rebindOnApproval: true,
      auditAction: "sales.unit.update.portal",
    },
  );
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 403 | 404 | 409);
  return c.json({ data: result.data });
});

// Withdraw — soft-delete via sourcingCancelled. Only while not approved
// AND only the agent who submitted (ownership gate).
portalSalesUnitsRoutes.delete("/:id", async (c) => {
  const session = c.get("session");
  const result = await cancelSalesUnitSourcingService(
    actorCtx(c),
    c.req.param("id"),
    { requireOwnerPartyId: session.partyId! },
  );
  if (!result.ok) {
    return c.json({ error: result.error }, result.status as 403 | 404 | 409);
  }
  return c.json({ data: result.data });
});

export { portalSalesUnitsRoutes };
