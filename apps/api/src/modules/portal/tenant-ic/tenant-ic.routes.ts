import { Hono } from "hono";
import { z } from "zod";
import { getDb } from "@kason/db";
import { deleteObject, createSignedUploadUrl, createSignedDownloadUrl, requireBucket } from "../../../lib/storage";
import {
  requestUploadUrl,
  deleteUpload,
  viewUrlForAgent,
  IcServiceError,
} from "./tenant-ic.service";
import type { PortalEnv } from "../auth/portal.auth.types";
import { formatZodError } from "../../../lib/zod-error-mapper";

const tenantIcRoutes = new Hono<PortalEnv>();

const uploadUrlSchema = z.object({
  side: z.enum(["front", "back"]),
  contentType: z.enum(["image/jpeg", "image/png", "image/heic"]),
});

const deleteUploadSchema = z.object({
  storageKey: z.string().min(1),
});

// POST /upload-url — agent only
tenantIcRoutes.post("/upload-url", async (c) => {
  const session = c.get("session");
  if (session.userType !== "agent") {
    return c.json({ error: "Forbidden" }, 403);
  }
  const parsed = uploadUrlSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "tenant-ic" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const { side, contentType } = parsed.data;
  try {
    const result = await requestUploadUrl({
      prisma: getDb() as any,
      signSupabaseUpload: async (key) => {
        // Forward Supabase's full signed-upload contract — method (POST) and
        // headers (authorization Bearer + x-upsert) — so the browser can
        // upload directly. Dropping these caused PUT 404 in production.
        const signed = await createSignedUploadUrl({ storageKey: key, contentType });
        return {
          uploadUrl: signed.uploadUrl,
          method: signed.method,
          headers: signed.headers,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        };
      },
      session: { partyId: session.partyId, orgId: session.orgId, role: session.role },
      side,
      contentType,
    });
    return c.json({ data: result });
  } catch (err) {
    if (err instanceof IcServiceError) {
      return c.json({ error: err.message }, err.status as any);
    }
    throw err;
  }
});

// DELETE /upload
tenantIcRoutes.delete("/upload", async (c) => {
  const session = c.get("session");
  const parsed = deleteUploadSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "tenant-ic" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const { storageKey } = parsed.data;
  try {
    await deleteUpload({
      prisma: getDb() as any,
      deleteObject,
      bucket: requireBucket(),
      session: { partyId: session.partyId, orgId: session.orgId, role: session.role },
      storageKey,
    });
    return c.json({ data: { ok: true } });
  } catch (err) {
    if (err instanceof IcServiceError) {
      return c.json({ error: err.message }, err.status as any);
    }
    throw err;
  }
});

// GET /view-url?storageKey=...
tenantIcRoutes.get("/view-url", async (c) => {
  const session = c.get("session");
  const storageKey = c.req.query("storageKey");
  if (!storageKey) {
    return c.json({ error: "storageKey is required" }, 400);
  }
  const ip = c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null;
  const userAgent = c.req.header("user-agent") ?? null;
  try {
    const result = await viewUrlForAgent({
      prisma: getDb() as any,
      signSupabaseView: async (key) => {
        const viewUrl = await createSignedDownloadUrl(key);
        return { viewUrl, expiresAt: new Date(Date.now() + 60 * 60 * 1000) };
      },
      session: { partyId: session.partyId, orgId: session.orgId, role: session.role },
      storageKey,
      ip,
      userAgent,
    });
    return c.json({ data: result });
  } catch (err) {
    if (err instanceof IcServiceError) {
      return c.json({ error: err.message }, err.status as any);
    }
    throw err;
  }
});

export { tenantIcRoutes };
