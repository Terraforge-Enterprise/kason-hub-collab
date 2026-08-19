import { Hono, type Context } from "hono";
import type { SessionPayload } from "../../lib/auth";
import { requireRole } from "../../middleware/require-role";
import type { AdminRole } from "../../lib/rbac";
import {
  createListingService,
  deactivateListingService,
  deleteListingService,
  getDeactivationPreviewService,
  getDeletionPreviewService,
  getListingByIdService,
  getListingsService,
  reactivateListingService,
  updateListingService,
} from "./listings.service";
import { listExplorerUnits } from "./listings-explorer.service";
import {
  isVideoKey,
  stripExifInPlace,
  transcodeVideoInPlace,
} from "./listings-media.service";
import {
  createListingSchema,
  listListingsQuery,
  mediaCompleteSchema,
  mediaUploadUrlSchema,
  updateListingSchema,
} from "./listings.validation";
import { buildMediaUploadUrl, completeMediaUpload, removeMediaKey } from "./listings-media-upload.service";
import { createSignedDownloadUrl } from "../../lib/storage";
import { getDb } from "@kason/db";
import { runtimeConfig } from "../../lib/runtime-config";
import { formatZodError } from "../../lib/zod-error-mapper";

const listingsRoutes = new Hono<{ Variables: { session: SessionPayload } }>();

// Defence-in-depth: route-level editor gate + service-level atLeast() check.
// Manager/admin gates on mutating routes enforced individually below.
listingsRoutes.use("*", requireRole("editor"));

type ListingsCtx = Context<{ Variables: { session: SessionPayload } }>;

function extractActorContext(c: ListingsCtx) {
  const session = c.get("session");
  const ip = c.req.header("x-forwarded-for") ?? undefined;
  const userAgent = c.req.header("user-agent") ?? undefined;
  return {
    orgId: session.orgId,
    actorUserId: session.userId,
    actorRole: session.role as AdminRole,
    ip,
    userAgent,
  };
}

// Admin-scoped inventory explorer — same row shape as /portal-api/listings
// so the web client can reuse the agent's filter/card UI, but without the
// per-agent visibility filter. Operators see every unit in their org.
// RBAC: editor+ (the route-level `requireRole("editor")` above gates this).
listingsRoutes.get("/explorer", async (c) => {
  const session = c.get("session");
  const rows = await listExplorerUnits(session.orgId);
  return c.json({ rows });
});

// Caps for the upload UI. Browser reads this at panel mount so the
// rejection message ("up to N MB") matches the actual server gate without
// any deploy coupling.
listingsRoutes.get("/media/limits", async (c) => {
  return c.json({
    data: {
      photoMaxBytes: runtimeConfig.limits.photoMaxBytes,
      videoMaxBytes: runtimeConfig.limits.videoMaxBytes,
    },
  });
});

listingsRoutes.get("/", async (c) => {
  const session = c.get("session");
  const parsed = listListingsQuery.safeParse(c.req.query());
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "listings" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await getListingsService(
    { orgId: session.orgId, role: session.role },
    parsed.data,
  );
  if (!result.ok) return c.json({ error: result.error }, result.status as 403);
  return c.json({ data: result.data });
});

listingsRoutes.get("/:id", async (c) => {
  const session = c.get("session");
  const id = c.req.param("id");
  const result = await getListingByIdService(
    { orgId: session.orgId, role: session.role },
    id,
  );
  if (!result.ok) return c.json({ error: result.error }, result.status as 403 | 404);
  return c.json({ data: result.data });
});

listingsRoutes.post("/", requireRole("manager"), async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = createListingSchema.safeParse(body);
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "listings" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await createListingService(extractActorContext(c), parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 403 | 404 | 409);
  return c.json({ data: result.data }, result.status as 201);
});

listingsRoutes.patch("/:id", requireRole("manager"), async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = updateListingSchema.safeParse(body);
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "listings" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await updateListingService(extractActorContext(c), id, parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 403 | 404 | 409);
  return c.json({ data: result.data });
});

// NOTE: the sourcing-approval routes
//   POST /:id/approve, /:id/reject, /:id/needs-amendment,
//   POST /:id/approve-changes, /:id/reject-changes
// were removed in the inventory three-table refactor. Every approval and
// amendment flow now goes through the submissions module
// (apps/api/src/modules/submissions/submission.service.ts:
// approveSubmissionService / rejectSubmissionService /
// setSubmissionNeedsAmendmentService). The submissions routes are wired in
// a later task.

listingsRoutes.get("/:id/deactivation-preview", requireRole("manager"), async (c) => {
  const id = c.req.param("id");
  const result = await getDeactivationPreviewService(extractActorContext(c), id);
  if (!result.ok) return c.json({ error: result.error }, result.status as 403 | 404);
  return c.json({ data: result.data });
});

listingsRoutes.post("/:id/deactivate", requireRole("manager"), async (c) => {
  const id = c.req.param("id");
  const result = await deactivateListingService(extractActorContext(c), id);
  if (!result.ok) {
    return c.json({ error: result.error }, result.status as 403 | 404 | 409);
  }
  return c.json({ data: result.data });
});

listingsRoutes.post("/:id/reactivate", requireRole("manager"), async (c) => {
  const id = c.req.param("id");
  const result = await reactivateListingService(extractActorContext(c), id);
  if (!result.ok) {
    return c.json({ error: result.error }, result.status as 403 | 404 | 409);
  }
  return c.json({ data: result.data });
});

listingsRoutes.get("/:id/deletion-preview", requireRole("admin"), async (c) => {
  const id = c.req.param("id");
  const result = await getDeletionPreviewService(extractActorContext(c), id);
  if (!result.ok) return c.json({ error: result.error }, result.status as 403 | 404);
  return c.json({ data: result.data });
});

listingsRoutes.delete("/:id", requireRole("admin"), async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => null);
  const confirmCode =
    body && typeof body.confirmCode === "string" ? body.confirmCode : "";
  if (!confirmCode) {
    return c.json({ error: "confirmCode is required" }, 400);
  }
  const result = await deleteListingService(
    extractActorContext(c),
    id,
    confirmCode,
  );
  if (!result.ok) {
    return c.json(
      { error: result.error },
      result.status as 400 | 403 | 404 | 409,
    );
  }
  return c.json({ data: result.data });
});

listingsRoutes.post("/:id/media/upload-url", requireRole("manager"), async (c) => {
  const session = c.get("session");
  const unitId = c.req.param("id");
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = mediaUploadUrlSchema.safeParse(body);
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "listings" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await buildMediaUploadUrl({
    orgId: session.orgId,
    unitId,
    ...parsed.data,
  });
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404 | 409);
  return c.json({ data: result.data });
});

listingsRoutes.post("/:id/media/complete", requireRole("manager"), async (c) => {
  const session = c.get("session");
  const unitId = c.req.param("id");
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = mediaCompleteSchema.safeParse(body);
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "listings" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await completeMediaUpload({
    orgId: session.orgId,
    unitId,
    storageKey: parsed.data.storageKey,
  });
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404 | 409);
  return c.json({ data: result.data });
});

// Remove a single media key from this Listing's photoKeys / videoKeys, then
// best-effort delete the underlying object from storage (removeMediaKey ->
// deleteObjectsBestEffort). The happy path leaves no orphan; deleteObjects-
// BestEffort never throws, so a rare storage-delete failure is logged (the DB
// key is already removed by then) and later reconciled by the
// report:storage-orphans CLI rather than surfaced as an error here.
//
// editor+ may delete media — widened from manager so admins/managers/editors
// can all curate listing photos and videos. (Whole-listing deletion,
// DELETE /:id, stays admin-only.) The explicit requireRole("editor") is kept
// even though the file-wide use("*", requireRole("editor")) already gates
// every route, so this route's own floor stays visible and survives any change
// to that base gate.
//
// Key carried in `?key=` because storage keys contain slashes; matches the
// GET /media/download-url convention.
listingsRoutes.delete("/:id/media", requireRole("editor"), async (c) => {
  const session = c.get("session");
  const unitId = c.req.param("id");
  const key = c.req.query("key");
  if (!key) return c.json({ error: "key query param required" }, 400);
  const result = await removeMediaKey({
    orgId: session.orgId,
    unitId,
    storageKey: key,
  });
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404);
  return c.json({ data: result.data });
});

listingsRoutes.get("/:id/media/download-url", async (c) => {
  const session = c.get("session");
  const unitId = c.req.param("id");
  const key = c.req.query("key");
  if (!key) return c.json({ error: "key query param required" }, 400);
  if (!key.startsWith(`units/${unitId}/`)) {
    return c.json({ error: "key does not match unit scope" }, 400);
  }

  // Ownership check — the requester's org must own the listing, and the
  // key must actually be attached to this Listing (photoKeys/videoKeys live
  // on Listing per-room per spec 2026-05-24).
  const listing = await getDb().listing.findUnique({
    where: { id: unitId },
    select: {
      organizationId: true,
      photoKeys: true,
      videoKeys: true,
    },
  });
  if (!listing || listing.organizationId !== session.orgId) {
    return c.json({ error: "unit not found" }, 404);
  }
  if (!listing.photoKeys.includes(key) && !listing.videoKeys.includes(key)) {
    return c.json({ error: "key not attached to this unit" }, 404);
  }

  // Extract a filename for Content-Disposition. Default to the last key segment.
  const lastSlash = key.lastIndexOf("/");
  const filename = lastSlash >= 0 ? key.slice(lastSlash + 1) : key;

  const url = await createSignedDownloadUrl(key, { filename });
  return c.json({ downloadUrl: url });
});

// Bulk variant: mints all signed URLs for a unit's media in one round-trip.
// For each photo: returns BOTH a thumbnail URL (Supabase Storage server-side
// resize, ~25 KB) for the grid AND a full-size URL for downloads. Cuts the
// admin unit-detail page from N+1 round-trips to 1 + N parallel image fetches.
listingsRoutes.get("/:id/media/download-urls", async (c) => {
  const session = c.get("session");
  const unitId = c.req.param("id");

  const listing = await getDb().listing.findUnique({
    where: { id: unitId },
    select: {
      organizationId: true,
      photoKeys: true,
      videoKeys: true,
    },
  });
  if (!listing || listing.organizationId !== session.orgId) {
    return c.json({ error: "unit not found" }, 404);
  }
  const photoKeys = listing.photoKeys;
  const videoKeys = listing.videoKeys;

  const filenameOf = (key: string) => {
    const lastSlash = key.lastIndexOf("/");
    return lastSlash >= 0 ? key.slice(lastSlash + 1) : key;
  };

  const photos = await Promise.all(
    photoKeys.map(async (key) => {
      // Parallel: full-size + thumbnail mint at the same time, not sequential.
      const [url, thumbnail] = await Promise.all([
        createSignedDownloadUrl(key, { filename: filenameOf(key) }),
        createSignedDownloadUrl(key, {
          transform: { width: 600, height: 600, resize: "cover", quality: 75 },
        }),
      ]);
      return { key, url, thumbnail };
    }),
  );
  const videos = await Promise.all(
    videoKeys.map(async (key) => ({
      key,
      url: await createSignedDownloadUrl(key, { filename: filenameOf(key) }),
    })),
  );

  return c.json({ data: { photos, videos } });
});

// Fire-and-forget media post-processing trigger. The client uploads directly
// to Supabase Storage via a signed URL, then POSTs here so the server can
// strip EXIF (for photos) or transcode to 720p H.264 (for videos). Returns
// 202 immediately; processing runs on setImmediate. Non-durable — proper
// queue is future work.
listingsRoutes.post("/:id/media/:key/processed", requireRole("manager"), async (c) => {
  const rawKey = c.req.param("key");
  const key = decodeURIComponent(rawKey);
  const process = isVideoKey(key) ? transcodeVideoInPlace : stripExifInPlace;
  setImmediate(() => {
    process(key).catch((err) => {
      // eslint-disable-next-line no-console
      console.error("media processing failed", { key, error: String(err) });
    });
  });
  return c.json({ queued: true }, 202);
});

export { listingsRoutes };
