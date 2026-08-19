import { Hono } from "hono";
import { getDb } from "@kason/db";
import type { PortalEnv } from "../auth/portal.auth.types";
import { existingClaimsOnKeyQuerySchema } from "@kason/shared";
import { getExistingClaimsOnKey } from "./existing-claims-on-key.service";
import { formatZodError } from "../../../lib/zod-error-mapper";

const existingClaimsOnKeyRoutes = new Hono<PortalEnv>();

existingClaimsOnKeyRoutes.get("/existing-on-key", async (c) => {
  const session = c.get("session");
  const parsed = existingClaimsOnKeyQuerySchema.safeParse({
    propertyId: c.req.query("propertyId"),
    unitCode: c.req.query("unitCode"),
    roomType: c.req.query("roomType"),
    moveInDate: c.req.query("moveInDate"),
  });
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "commission" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const { propertyId, unitCode, roomType, moveInDate } = parsed.data;

  const db = getDb();
  const data = await getExistingClaimsOnKey(db, session.orgId, {
    propertyId,
    unitCode,
    roomType,
    moveInDate: new Date(moveInDate),
  });

  return c.json({ data });
});

export { existingClaimsOnKeyRoutes };
