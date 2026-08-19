import { Hono } from "hono";
import type { SessionPayload } from "../../lib/auth";
import { updateMyProfileSchema, avatarUploadUrlSchema } from "./profile.validation";
import { getMyProfile, updateMyProfile, mintAvatarUploadUrl } from "./profile.service";
import { formatZodError } from "../../lib/zod-error-mapper";

export const profileRoutes = new Hono<{ Variables: { session: SessionPayload } }>();

profileRoutes.get("/me", async (c) => {
  const session = c.get("session");
  const result = await getMyProfile(session);
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json({ data: result.data });
});

profileRoutes.patch("/me", async (c) => {
  const session = c.get("session");
  const body = await c.req.json().catch(() => null);
  const parsed = updateMyProfileSchema.safeParse(body);
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "profile" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await updateMyProfile(session, parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json({ data: result.data });
});

profileRoutes.post("/avatar/upload-url", async (c) => {
  const session = c.get("session");
  const body = await c.req.json().catch(() => null);
  const parsed = avatarUploadUrlSchema.safeParse(body);
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "profile" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await mintAvatarUploadUrl(session, parsed.data);
  return c.json({ data: result.data });
});
