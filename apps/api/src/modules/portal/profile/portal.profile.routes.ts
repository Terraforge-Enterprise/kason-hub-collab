import { Hono } from "hono";
import type { PortalEnv } from "../auth/portal.auth.types";
import {
  getProfile,
  updateAgentBankDetails,
  updateMyPortalProfile,
  mintPortalAvatarUploadUrl,
} from "./portal.profile.repository";
import { updatePortalProfileSchema } from "./portal.profile.validation";
import { formatZodError } from "../../../lib/zod-error-mapper";

const portalProfileRoutes = new Hono<PortalEnv>();

portalProfileRoutes.get("/", async (c) => {
  const session = c.get("session");
  const profile = await getProfile({
    partyId: session.partyId,
    orgId: session.orgId,
    userId: session.userId,
  });
  return c.json({ data: profile });
});

portalProfileRoutes.put("/bank-details", async (c) => {
  const session = c.get("session");
  if (session.userType !== "agent") {
    return c.json({ error: "Only agents can update bank details" }, 403);
  }
  const body = await c.req.json().catch(() => ({}));
  await updateAgentBankDetails(session.partyId, session.orgId, {
    bankName: body.bankName,
    bankAccountHolder: body.bankAccountHolder,
    bankAccountNumber: body.bankAccountNumber,
  });
  return c.json({ data: { ok: true } });
});

portalProfileRoutes.patch("/me", async (c) => {
  const session = c.get("session");
  if (session.userType !== "agent") {
    return c.json({ error: "Only agents can edit their profile" }, 403);
  }
  const raw = await c.req.json().catch(() => null);
  const parsed = updatePortalProfileSchema.safeParse(raw);
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "profile" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await updateMyPortalProfile(
    { partyId: session.partyId, orgId: session.orgId, userId: session.userId },
    parsed.data,
  );
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json({ data: { ok: true } });
});

portalProfileRoutes.post("/avatar/upload-url", async (c) => {
  const session = c.get("session");
  if (session.userType !== "agent") {
    return c.json({ error: "Only agents can upload avatars" }, 403);
  }
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.contentType !== "string" || typeof body.sizeBytes !== "number") {
    return c.json({ error: "Invalid payload" }, 400);
  }
  const result = await mintPortalAvatarUploadUrl(
    { partyId: session.partyId, orgId: session.orgId, userId: session.userId },
    { contentType: body.contentType, sizeBytes: body.sizeBytes },
  );
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json({ data: result.data });
});

export { portalProfileRoutes };
