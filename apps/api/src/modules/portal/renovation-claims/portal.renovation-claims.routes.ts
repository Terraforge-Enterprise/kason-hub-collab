import { randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import type { PortalEnv } from "../auth/portal.auth.types";
import { getActorHeaders } from "../../../lib/actor-ctx";
import {
  createSignedDownloadUrl,
  createSignedUploadUrl,
  deleteObject,
} from "../../../lib/storage";
import {
  buildClaimDocumentStorageKey,
  cancelClaimService,
  createClaimService,
  deleteDocumentService,
  getClaimByIdService,
  getDocumentViewUrlService,
  listClaimsService,
  listClaimTransitionsService,
  listPackagesService,
  markDocumentUploadedService,
  updateClaimService,
} from "../../renovation-claims";
import {
  createClaimSchema,
  documentMarkUploadedSchema,
  listClaimsQuery,
  listPackagesQuery,
  updateClaimSchema,
  uploadUrlSchema,
} from "../../renovation-claims/renovation-claims.validation";
import type { AdminRole } from "../../../lib/rbac";
import { formatZodError } from "../../../lib/zod-error-mapper";

const portalRenovationClaimsRoutes = new Hono<PortalEnv>();

function actorCtx(c: Context<PortalEnv>) {
  const session = c.get("session");
  const { ip, userAgent } = getActorHeaders(c);
  return {
    orgId: session.orgId,
    actorUserId: session.userId,
    // Portal session has no operator role; tag it with "editor" so the
    // service-level audit row carries a meaningful role string. The
    // service relies on the override flags (requireSubmittedById /
    // requireSalesUnitOwnerPartyId) to gate the call rather than the role.
    actorRole: "editor" as AdminRole,
    ip,
    userAgent,
  };
}

// ─── Packages (read-only) ────────────────────────────────────────────────────

portalRenovationClaimsRoutes.get("/packages", async (c) => {
  const parsed = listPackagesQuery.safeParse(c.req.query());
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "renovation-claims" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  // Force archived=false; the agent UI never needs archived packages.
  const result = await listPackagesService(actorCtx(c), {
    ...parsed.data,
    archived: false,
  });
  if (!result.ok) return c.json({ error: result.error }, result.status as 403);
  return c.json({ data: result.data });
});

// ─── Claims (own-only) ───────────────────────────────────────────────────────

portalRenovationClaimsRoutes.get("/claims", async (c) => {
  const session = c.get("session");
  const parsed = listClaimsQuery.safeParse(c.req.query());
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "renovation-claims" });
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

portalRenovationClaimsRoutes.get("/claims/:id", async (c) => {
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
// detail endpoint. Lets the agent see every prior rejection note +
// amendment cycle in one place rather than only the latest reviewerNote.
portalRenovationClaimsRoutes.get("/claims/:id/transitions", async (c) => {
  const session = c.get("session");
  const id = c.req.param("id");
  const result = await listClaimTransitionsService(actorCtx(c), id, {
    requireSubmittedById: session.userId,
  });
  if (!result.ok) return c.json({ error: result.error }, result.status as 403 | 404);
  return c.json({ data: result.data });
});

portalRenovationClaimsRoutes.post("/claims", async (c) => {
  const session = c.get("session");
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = createClaimSchema.safeParse(body);
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "renovation-claims" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await createClaimService(
    actorCtx(c),
    parsed.data,
    {
      requireSalesUnitOwnerPartyId: session.partyId,
      auditAction: "renovation.claim.create.portal",
    },
  );
  if (!result.ok) {
    return c.json({ error: result.error }, result.status as 400 | 403 | 404 | 409);
  }
  return c.json({ data: result.data }, result.status as 201);
});

portalRenovationClaimsRoutes.patch("/claims/:id", async (c) => {
  const session = c.get("session");
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = updateClaimSchema.safeParse(body);
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "renovation-claims" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await updateClaimService(
    actorCtx(c),
    id,
    parsed.data,
    {
      requireSubmittedById: session.userId,
      rebindOnApproval: true,
      auditAction: "renovation.claim.update.portal",
    },
  );
  if (!result.ok) {
    return c.json({ error: result.error }, result.status as 400 | 403 | 404 | 409);
  }
  return c.json({ data: result.data });
});

// Withdraw a claim. Agent-side: ownership + status="submitted" gates
// inside cancelClaimService. Returns 409 if a reviewer already touched
// the claim (status moved past "submitted").
portalRenovationClaimsRoutes.delete("/claims/:id", async (c) => {
  const session = c.get("session");
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => null);
  const result = await cancelClaimService(actorCtx(c), id, {
    requireSubmittedById: session.userId,
    note: typeof body?.note === "string" ? body.note : null,
    auditAction: "renovation.claim.cancel.portal",
  });
  if (!result.ok) {
    return c.json({ error: result.error }, result.status as 403 | 404 | 409);
  }
  return c.json({ data: result.data });
});

// ─── Document upload flow ───────────────────────────────────────────────────

portalRenovationClaimsRoutes.post("/claims/upload-url", async (c) => {
  const session = c.get("session");
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = uploadUrlSchema.safeParse(body);
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "renovation-claims" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const { filename, contentType, claimId } = parsed.data;

  const storageKey = buildClaimDocumentStorageKey({
    organizationId: session.orgId,
    claimId: claimId ?? null,
    uuid: randomUUID(),
    filename,
  });

  try {
    const signed = await createSignedUploadUrl({ storageKey, contentType });
    return c.json({
      data: {
        uploadUrl: signed.uploadUrl,
        method: signed.method,
        headers: signed.headers,
        fileKey: storageKey,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "upload-url failed";
    return c.json({ error: msg }, 500);
  }
});

portalRenovationClaimsRoutes.post(
  "/claims/:id/documents/mark-uploaded",
  async (c) => {
    const session = c.get("session");
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ error: "Invalid JSON body" }, 400);
    const parsed = documentMarkUploadedSchema.safeParse(body);
    if (!parsed.success) {
      const friendly = formatZodError(parsed.error, { domain: "renovation-claims" });
      return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
    }
    const result = await markDocumentUploadedService(
      actorCtx(c),
      id,
      parsed.data,
      {
        requireSubmittedById: session.userId,
        auditAction: "renovation.claim.document.create.portal",
      },
    );
    if (!result.ok) {
      return c.json({ error: result.error }, result.status as 400 | 403 | 404 | 409);
    }
    return c.json({ data: result.data }, result.status as 201);
  },
);

portalRenovationClaimsRoutes.delete(
  "/claims/:id/documents/:docId",
  async (c) => {
    const session = c.get("session");
    const id = c.req.param("id");
    const docId = c.req.param("docId");
    const result = await deleteDocumentService(
      actorCtx(c),
      id,
      docId,
      { deleteObject },
      {
        requireSubmittedById: session.userId,
        auditAction: "renovation.claim.document.delete.portal",
      },
    );
    if (!result.ok) {
      return c.json({ error: result.error }, result.status as 403 | 404);
    }
    return c.json({ data: result.data });
  },
);

portalRenovationClaimsRoutes.get(
  "/claims/:id/documents/:docId/view-url",
  async (c) => {
    const session = c.get("session");
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
      { requireSubmittedById: session.userId },
    );
    if (!result.ok) {
      return c.json({ error: result.error }, result.status as 403 | 404);
    }
    return c.json({ data: result.data });
  },
);

export { portalRenovationClaimsRoutes };
