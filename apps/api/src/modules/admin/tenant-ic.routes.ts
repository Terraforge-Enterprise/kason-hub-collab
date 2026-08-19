import { Hono } from "hono";
import { getDb } from "@kason/db";
import { createSignedDownloadUrl, deleteObject, requireBucket } from "../../lib/storage";
import { viewUrlForAdmin, IcServiceError } from "../portal/tenant-ic/tenant-ic.service";
import { runTenantIcSweeper, runTenantIcHousekeeping } from "../portal/tenant-ic/sweeper";
import type { SessionPayload } from "../../lib/auth";

type AdminEnv = { Variables: { session: SessionPayload } };

const adminTenantIcRoutes = new Hono<AdminEnv>();

// GET /view-url?claimItemId=...&side=...
adminTenantIcRoutes.get("/view-url", async (c) => {
  const session = c.get("session");
  const claimItemId = c.req.query("claimItemId");
  const side = c.req.query("side") as "front" | "back" | undefined;

  if (!claimItemId) {
    return c.json({ error: "claimItemId is required" }, 400);
  }
  if (side !== "front" && side !== "back") {
    return c.json({ error: "side must be 'front' or 'back'" }, 400);
  }

  const ip = c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null;
  const userAgent = c.req.header("user-agent") ?? null;

  try {
    const result = await viewUrlForAdmin({
      prisma: getDb() as any,
      signSupabaseView: async (key) => {
        const viewUrl = await createSignedDownloadUrl(key);
        return { viewUrl, expiresAt: new Date(Date.now() + 60 * 60 * 1000) };
      },
      session: {
        userId: session.userId,
        partyId: session.partyId ?? "",
        orgId: session.orgId,
        role: session.role,
      },
      claimItemId,
      side,
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

adminTenantIcRoutes.post("/jobs/tenant-ic-sweeper/run", async (c) => {
  const session = c.get("session");
  if (session.role !== "admin") return c.json({ error: "Forbidden" }, 403);
  const prisma = getDb() as any;
  const result = await runTenantIcSweeper({ prisma, deleteObject, bucket: requireBucket() });
  return c.json(result);
});

adminTenantIcRoutes.post("/jobs/tenant-ic-housekeeping/run", async (c) => {
  const session = c.get("session");
  if (session.role !== "admin") return c.json({ error: "Forbidden" }, 403);
  const prisma = getDb() as any;
  const result = await runTenantIcHousekeeping({ prisma });
  return c.json(result);
});

export { adminTenantIcRoutes };
