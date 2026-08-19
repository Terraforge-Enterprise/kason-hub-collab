import { Hono, type Context } from "hono";
import type { PortalEnv } from "../auth/portal.auth.types";
import { getActorHeaders } from "../../../lib/actor-ctx";
import {
  cancelClaimService,
  createClaimService,
  getClaimByIdService,
  listClaimsService,
  listClaimTransitionsService,
  updateClaimService,
} from "../../sales-claims";
import {
  createClaimSchema,
  listClaimsQuery,
  updateClaimSchema,
} from "../../sales-claims/sales-claims.validation";
import type { AdminRole } from "../../../lib/rbac";
import { formatZodError } from "../../../lib/zod-error-mapper";

const portalSalesClaimsRoutes = new Hono<PortalEnv>();

function actorCtx(c: Context<PortalEnv>) {
  const session = c.get("session");
  const { ip, userAgent } = getActorHeaders(c);
  return {
    orgId: session.orgId,
    actorUserId: session.userId,
    // Portal session has no operator role; tag it with "editor" so the
    // service-level audit row carries a meaningful role string. The service
    // relies on the override flags (requireSubmittedById /
    // requireSalesUnitOwnerPartyId) to gate the call rather than the role.
    actorRole: "editor" as AdminRole,
    ip,
    userAgent,
  };
}

// ─── Claims (own-only) ───────────────────────────────────────────────────────

portalSalesClaimsRoutes.get("/", async (c) => {
  const session = c.get("session");
  const parsed = listClaimsQuery.safeParse(c.req.query());
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "sales-claims" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await listClaimsService(
    actorCtx(c),
    {
      ...parsed.data,
      submittedByEq: session.userId,
    },
    // Portal own-only: caller is the submitter, so the role-stripping that
    // protects editors from OTHER agents' commission data must be bypassed.
    // Ownership is enforced by `submittedByEq: session.userId` above.
    { forceFullSelect: true },
  );
  if (!result.ok) return c.json({ error: result.error }, result.status as 403);
  return c.json({ data: result.data });
});

portalSalesClaimsRoutes.get("/:id", async (c) => {
  const session = c.get("session");
  const id = c.req.param("id");
  const result = await getClaimByIdService(actorCtx(c), id, {
    requireSubmittedById: session.userId,
    // Portal own-only: caller is the submitter, full shape is correct.
    // `requireSubmittedById` enforces ownership before any data is returned.
    forceFullSelect: true,
  });
  if (!result.ok) return c.json({ error: result.error }, result.status as 403 | 404);
  return c.json({ data: result.data });
});

// Audit timeline — agent's own claim only. Same ownership rule as the
// detail endpoint above (requireSubmittedById = session.userId). Lets the
// agent see every prior rejection note + amendment cycle in one place.
portalSalesClaimsRoutes.get("/:id/transitions", async (c) => {
  const session = c.get("session");
  const id = c.req.param("id");
  const result = await listClaimTransitionsService(actorCtx(c), id, {
    requireSubmittedById: session.userId,
  });
  if (!result.ok) return c.json({ error: result.error }, result.status as 403 | 404);
  return c.json({ data: result.data });
});

portalSalesClaimsRoutes.post("/", async (c) => {
  const session = c.get("session");
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = createClaimSchema.safeParse(body);
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "sales-claims" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await createClaimService(actorCtx(c), parsed.data, {
    requireSalesUnitOwnerPartyId: session.partyId,
    auditAction: "sales.claim.create.portal",
  });
  if (!result.ok) {
    return c.json({ error: result.error }, result.status as 400 | 403 | 404 | 409);
  }
  return c.json({ data: result.data }, result.status as 201);
});

portalSalesClaimsRoutes.patch("/:id", async (c) => {
  const session = c.get("session");
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = updateClaimSchema.safeParse(body);
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "sales-claims" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await updateClaimService(actorCtx(c), id, parsed.data, {
    requireSubmittedById: session.userId,
    rebindOnApproval: true,
    auditAction: "sales.claim.update.portal",
  });
  if (!result.ok) {
    return c.json({ error: result.error }, result.status as 400 | 403 | 404 | 409);
  }
  return c.json({ data: result.data });
});

// Withdraw a claim. Agent-side: ownership + status="submitted" gates are
// enforced inside cancelClaimService. Returns 409 if the claim has already
// been picked up for review (status moved past "submitted"), so the agent
// gets a useful error rather than a silent success.
portalSalesClaimsRoutes.delete("/:id", async (c) => {
  const session = c.get("session");
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => null);
  const result = await cancelClaimService(actorCtx(c), id, {
    requireSubmittedById: session.userId,
    note: typeof body?.note === "string" ? body.note : null,
    auditAction: "sales.claim.cancel.portal",
  });
  if (!result.ok) {
    return c.json({ error: result.error }, result.status as 403 | 404 | 409);
  }
  return c.json({ data: result.data });
});

export { portalSalesClaimsRoutes };
