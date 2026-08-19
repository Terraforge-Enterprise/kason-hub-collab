import { Hono } from "hono";
import type { PortalEnv } from "../auth/portal.auth.types";
import { createSignedDownloadUrl } from "../../../lib/storage";
import { getVisibleUnit, listVisibleUnits } from "./portal.listings.service";

const portalListingsRoutes = new Hono<PortalEnv>();

portalListingsRoutes.get("/", async (c) => {
  // Temporary perf instrumentation (2026-05-20): emit a single structured JSON
  // line per request so we can see where the portal inventory page's latency
  // actually goes. Remove after we've decided whether to cache signed URLs.
  // Grep Lightsail logs for: `scope":"perf","op":"portalListVisibleUnits`
  const tStart = performance.now();
  const session = c.get("session");
  const rows = await listVisibleUnits(session.orgId, session.partyId);
  const tAfterDb = performance.now();
  // Sign each unit's first photo as a small thumbnail so the inventory grid
  // can render a cover image without a per-card round-trip. Bandwidth-cheap:
  // Supabase resizes server-side (~25 KB JPEGs).
  const withCovers = await Promise.all(
    rows.map(async (u) => {
      const firstKey = u.photoKeys[0];
      if (!firstKey) return { ...u, coverPhotoUrl: null as string | null };
      try {
        const coverPhotoUrl = await createSignedDownloadUrl(firstKey, {
          transform: { width: 400, height: 300, resize: "cover" },
        });
        return { ...u, coverPhotoUrl };
      } catch {
        return { ...u, coverPhotoUrl: null as string | null };
      }
    }),
  );
  const tEnd = performance.now();
  const signCount = rows.filter((u) => u.photoKeys[0]).length;
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      scope: "perf",
      op: "portalListVisibleUnits",
      orgId: session.orgId,
      partyId: session.partyId,
      rowCount: rows.length,
      signCount,
      dbMs: Math.round(tAfterDb - tStart),
      signMs: Math.round(tEnd - tAfterDb),
      totalMs: Math.round(tEnd - tStart),
    }),
  );
  return c.json({ rows: withCovers });
});

portalListingsRoutes.get("/:id", async (c) => {
  const session = c.get("session");
  const unit = await getVisibleUnit(session.orgId, session.partyId, c.req.param("id"));
  if (!unit) return c.json({ error: "not found" }, 404);
  return c.json(unit);
});

portalListingsRoutes.get("/:id/media/download-urls", async (c) => {
  const session = c.get("session");
  const unit = await getVisibleUnit(session.orgId, session.partyId, c.req.param("id"));
  if (!unit) return c.json({ error: "not found" }, 404);
  // Pass `filename` so Supabase emits Content-Disposition: attachment.
  // Without it, cross-origin <a download> is ignored and the browser
  // navigates to the image — which looks like a tab crash.
  const basename = (k: string) => {
    const slash = k.lastIndexOf("/");
    return slash >= 0 ? k.slice(slash + 1) : k;
  };
  const photos = await Promise.all(
    unit.photoKeys.map((k) => createSignedDownloadUrl(k, { filename: basename(k) })),
  );
  const videos = await Promise.all(
    unit.videoKeys.map((k) => createSignedDownloadUrl(k, { filename: basename(k) })),
  );
  return c.json({ photos, videos });
});

portalListingsRoutes.get("/:id/media/download-url", async (c) => {
  const session = c.get("session");
  const unitId = c.req.param("id");
  const key = c.req.query("key");
  if (!key) return c.json({ error: "key query param required" }, 400);
  if (!key.startsWith(`units/${unitId}/`)) {
    return c.json({ error: "key does not match unit scope" }, 400);
  }

  const unit = await getVisibleUnit(session.orgId, session.partyId, unitId);
  if (!unit) return c.json({ error: "not found" }, 404);
  if (!unit.photoKeys.includes(key) && !unit.videoKeys.includes(key)) {
    return c.json({ error: "key not attached to this unit" }, 404);
  }

  const lastSlash = key.lastIndexOf("/");
  const filename = lastSlash >= 0 ? key.slice(lastSlash + 1) : key;

  const url = await createSignedDownloadUrl(key, { filename });
  return c.json({ downloadUrl: url });
});

export { portalListingsRoutes };
