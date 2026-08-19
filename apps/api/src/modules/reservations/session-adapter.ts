import { createMiddleware } from "hono/factory";
import type { SessionPayload } from "../../lib/auth";
import type { PortalSessionPayload } from "../portal/auth/portal.auth.types";
import type { ReservationSession } from "./types";

export const adminReservationSessionAdapter = createMiddleware(async (c, next) => {
  const raw = c.get("session") as SessionPayload | undefined;
  if (!raw) return c.json({ error: "Unauthorized" }, 401);

  const opRole = raw.role === "admin" || raw.role === "manager" || raw.role === "editor"
    ? raw.role
    : undefined;

  const session: ReservationSession = {
    orgId: raw.orgId,
    userId: raw.userId,
    partyId: raw.partyId ?? "",
    role: "admin",
    operatorRole: opRole,
  };
  c.set("session", session);
  await next();
});

export const agentReservationSessionAdapter = createMiddleware(async (c, next) => {
  const raw = c.get("session") as PortalSessionPayload | undefined;
  if (!raw) return c.json({ error: "Unauthorized" }, 401);
  if (raw.userType !== "agent") return c.json({ error: "Forbidden" }, 403);

  const session: ReservationSession = {
    orgId: raw.orgId,
    userId: raw.userId,
    partyId: raw.partyId,
    role: "agent",
  };
  c.set("session", session);
  await next();
});
