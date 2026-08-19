import { Hono, type Context } from "hono";
import type { SessionPayload } from "../../lib/auth";
import { requireRole } from "../../middleware/require-role";
import type { AdminRole } from "../../lib/rbac";
import { getActorHeaders } from "../../lib/actor-ctx";
import { formatZodError } from "../../lib/zod-error-mapper";
import {
  approveClaimService,
  cancelClaimService,
  createClaimService,
  getClaimByIdService,
  listClaimsService,
  listClaimTransitionsService,
  needsAmendmentClaimService,
  rejectClaimService,
} from "./sales-claims.service";
import {
  createClaimSchema,
  listClaimsQuery,
  needsAmendmentSchema,
  rejectSchema,
} from "./sales-claims.validation";

const salesClaimsRoutes = new Hono<{ Variables: { session: SessionPayload } }>();

salesClaimsRoutes.use("*", requireRole("editor"));

type SalesClaimsCtx = Context<{ Variables: { session: SessionPayload } }>;

function actorCtx(c: SalesClaimsCtx) {
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

// ─── Claims ──────────────────────────────────────────────────────────────────

salesClaimsRoutes.get("/", async (c) => {
  const parsed = listClaimsQuery.safeParse(c.req.query());
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "sales-claims" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await listClaimsService(actorCtx(c), parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 403);
  return c.json({ data: result.data });
});

salesClaimsRoutes.get("/:id", async (c) => {
  const id = c.req.param("id");
  const result = await getClaimByIdService(actorCtx(c), id);
  if (!result.ok) return c.json({ error: result.error }, result.status as 403 | 404);
  return c.json({ data: result.data });
});

// Audit timeline — every approve/reject/needs-amendment writes a row to
// SalesClaimTransition, but until now no endpoint returned them. Manager
// review flows want to see "who reviewed what, when, with what note."
salesClaimsRoutes.get("/:id/transitions", async (c) => {
  const id = c.req.param("id");
  const result = await listClaimTransitionsService(actorCtx(c), id);
  if (!result.ok) return c.json({ error: result.error }, result.status as 403 | 404);
  return c.json({ data: result.data });
});

// Admin create-on-behalf — manager+ submits a claim for an offline agent.
// `createClaimService` is shape-compatible with the portal flow; the only
// difference is omitting `requireSalesUnitOwnerPartyId` so any sales unit
// in the org is acceptable.
salesClaimsRoutes.post("/", requireRole("manager"), async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = createClaimSchema.safeParse(body);
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "sales-claims" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await createClaimService(actorCtx(c), parsed.data, {
    auditAction: "sales.claim.create.admin",
  });
  if (!result.ok) {
    return c.json({ error: result.error }, result.status as 400 | 403 | 404 | 409);
  }
  return c.json({ data: result.data }, result.status as 201);
});

// Cancel a claim. Manager+ — admins use this to tidy up
// duplicates / mis-submitted entries. Portal has its own DELETE handler
// that imposes the additional "must still be `submitted`" gate.
salesClaimsRoutes.delete("/:id", requireRole("manager"), async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => null);
  const result = await cancelClaimService(actorCtx(c), id, {
    note: typeof body?.note === "string" ? body.note : null,
    auditAction: "sales.claim.cancel.admin",
  });
  if (!result.ok) {
    return c.json({ error: result.error }, result.status as 403 | 404 | 409);
  }
  return c.json({ data: result.data });
});

salesClaimsRoutes.post("/:id/approve", requireRole("manager"), async (c) => {
  const id = c.req.param("id");
  const result = await approveClaimService(actorCtx(c), id);
  if (!result.ok) {
    return c.json({ error: result.error }, result.status as 400 | 403 | 404 | 409);
  }
  return c.json({ data: result.data });
});

salesClaimsRoutes.post("/:id/reject", requireRole("manager"), async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = rejectSchema.safeParse(body);
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "sales-claims" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await rejectClaimService(actorCtx(c), id, parsed.data.note);
  if (!result.ok) {
    return c.json({ error: result.error }, result.status as 400 | 403 | 404 | 409);
  }
  return c.json({ data: result.data });
});

salesClaimsRoutes.post(
  "/:id/needs-amendment",
  requireRole("manager"),
  async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ error: "Invalid JSON body" }, 400);
    const parsed = needsAmendmentSchema.safeParse(body);
    if (!parsed.success) {
      const friendly = formatZodError(parsed.error, { domain: "sales-claims" });
      return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
    }
    const result = await needsAmendmentClaimService(
      actorCtx(c),
      id,
      parsed.data.note,
    );
    if (!result.ok) {
      return c.json({ error: result.error }, result.status as 400 | 403 | 404 | 409);
    }
    return c.json({ data: result.data });
  },
);

export { salesClaimsRoutes };
