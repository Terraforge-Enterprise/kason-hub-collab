import { Hono, type Context } from "hono";
import type { SessionPayload } from "../../lib/auth";
import { requireRole } from "../../middleware/require-role";
import type { AdminRole } from "../../lib/rbac";
import { getActorHeaders } from "../../lib/actor-ctx";
import { formatZodError } from "../../lib/zod-error-mapper";
import { createSignedDownloadUrl, deleteObject } from "../../lib/storage";
import {
  approveClaimService,
  cancelClaimService,
  createClaimService,
  createPackageService,
  getClaimByIdService,
  getDocumentViewUrlService,
  getPackageByIdService,
  listClaimsService,
  listClaimTransitionsService,
  listPackagesService,
  needsAmendmentClaimService,
  rejectClaimService,
  updatePackageService,
} from "./renovation-claims.service";
import {
  createClaimSchema,
  createPackageSchema,
  listClaimsQuery,
  listPackagesQuery,
  needsAmendmentSchema,
  rejectSchema,
  updatePackageSchema,
} from "./renovation-claims.validation";

const renovationRoutes = new Hono<{ Variables: { session: SessionPayload } }>();

renovationRoutes.use("*", requireRole("editor"));

type RenoCtx = Context<{ Variables: { session: SessionPayload } }>;

function actorCtx(c: RenoCtx) {
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

// ─── Packages ────────────────────────────────────────────────────────────────

renovationRoutes.get("/packages", async (c) => {
  const parsed = listPackagesQuery.safeParse(c.req.query());
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "renovation-claims" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await listPackagesService(actorCtx(c), parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 403);
  return c.json({ data: result.data });
});

renovationRoutes.get("/packages/:id", async (c) => {
  const id = c.req.param("id");
  const result = await getPackageByIdService(actorCtx(c), id);
  if (!result.ok) return c.json({ error: result.error }, result.status as 403 | 404);
  return c.json({ data: result.data });
});

renovationRoutes.post("/packages", requireRole("admin"), async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = createPackageSchema.safeParse(body);
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "renovation-claims" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await createPackageService(actorCtx(c), parsed.data);
  if (!result.ok) {
    return c.json({ error: result.error }, result.status as 400 | 403 | 404 | 409);
  }
  return c.json({ data: result.data }, result.status as 201);
});

renovationRoutes.patch("/packages/:id", requireRole("admin"), async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = updatePackageSchema.safeParse(body);
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "renovation-claims" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await updatePackageService(actorCtx(c), id, parsed.data);
  if (!result.ok) {
    return c.json({ error: result.error }, result.status as 400 | 403 | 404 | 409);
  }
  return c.json({ data: result.data });
});

// ─── Claims ──────────────────────────────────────────────────────────────────

renovationRoutes.get("/claims", async (c) => {
  const parsed = listClaimsQuery.safeParse(c.req.query());
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "renovation-claims" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await listClaimsService(actorCtx(c), parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 403);
  return c.json({ data: result.data });
});

renovationRoutes.get("/claims/:id", async (c) => {
  const id = c.req.param("id");
  const result = await getClaimByIdService(actorCtx(c), id);
  if (!result.ok) return c.json({ error: result.error }, result.status as 403 | 404);
  return c.json({ data: result.data });
});

// Audit timeline — RenovationClaimTransition rows are written on every
// approve/reject/needs-amendment but until now no endpoint returned them.
renovationRoutes.get("/claims/:id/transitions", async (c) => {
  const id = c.req.param("id");
  const result = await listClaimTransitionsService(actorCtx(c), id);
  if (!result.ok) return c.json({ error: result.error }, result.status as 403 | 404);
  return c.json({ data: result.data });
});

// Admin create-on-behalf — manager+ submits a claim for an offline agent.
// Same shape as the portal create endpoint, minus the
// `requireSalesUnitOwnerPartyId` ownership gate.
renovationRoutes.post("/claims", requireRole("manager"), async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = createClaimSchema.safeParse(body);
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "renovation-claims" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await createClaimService(actorCtx(c), parsed.data, {
    auditAction: "renovation.claim.create.admin",
  });
  if (!result.ok) {
    return c.json({ error: result.error }, result.status as 400 | 403 | 404 | 409);
  }
  return c.json({ data: result.data }, result.status as 201);
});

// Admin cancel — manager+ tidies up duplicates / mis-submitted claims.
// Portal has its own DELETE handler that requires status="submitted".
renovationRoutes.delete("/claims/:id", requireRole("manager"), async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => null);
  const result = await cancelClaimService(actorCtx(c), id, {
    note: typeof body?.note === "string" ? body.note : null,
    auditAction: "renovation.claim.cancel.admin",
  });
  if (!result.ok) {
    return c.json({ error: result.error }, result.status as 403 | 404 | 409);
  }
  return c.json({ data: result.data });
});

renovationRoutes.post("/claims/:id/approve", requireRole("manager"), async (c) => {
  const id = c.req.param("id");
  const result = await approveClaimService(actorCtx(c), id);
  if (!result.ok) {
    return c.json({ error: result.error }, result.status as 400 | 403 | 404 | 409);
  }
  return c.json({ data: result.data });
});

renovationRoutes.post("/claims/:id/reject", requireRole("manager"), async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = rejectSchema.safeParse(body);
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "renovation-claims" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await rejectClaimService(actorCtx(c), id, parsed.data.note);
  if (!result.ok) {
    return c.json({ error: result.error }, result.status as 400 | 403 | 404 | 409);
  }
  return c.json({ data: result.data });
});

renovationRoutes.post(
  "/claims/:id/needs-amendment",
  requireRole("manager"),
  async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ error: "Invalid JSON body" }, 400);
    const parsed = needsAmendmentSchema.safeParse(body);
    if (!parsed.success) {
      const friendly = formatZodError(parsed.error, { domain: "renovation-claims" });
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

// Admin can also pull short-lived view URLs for any claim's documents.
renovationRoutes.get("/claims/:id/documents/:docId/view-url", async (c) => {
  const id = c.req.param("id");
  const docId = c.req.param("docId");
  const result = await getDocumentViewUrlService(
    actorCtx(c),
    id,
    docId,
    {
      signSupabaseView: async (key) => {
        const viewUrl = await createSignedDownloadUrl(key);
        return { viewUrl, expiresAt: new Date(Date.now() + 60 * 60 * 1000) };
      },
    },
  );
  if (!result.ok) return c.json({ error: result.error }, result.status as 403 | 404);
  return c.json({ data: result.data });
});

// Admin: delete a document on any claim. The service-side guard checks org +
// claim relationship; deletion is rare and goes through the same audit trail.
renovationRoutes.delete(
  "/claims/:id/documents/:docId",
  requireRole("manager"),
  async (c) => {
    const id = c.req.param("id");
    const docId = c.req.param("docId");
    const { deleteDocumentService } = await import("./renovation-claims.service");
    const result = await deleteDocumentService(
      actorCtx(c),
      id,
      docId,
      { deleteObject },
    );
    if (!result.ok) {
      return c.json({ error: result.error }, result.status as 403 | 404);
    }
    return c.json({ data: result.data });
  },
);

export { renovationRoutes };
