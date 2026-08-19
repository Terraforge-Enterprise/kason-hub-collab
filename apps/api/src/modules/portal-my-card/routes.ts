// Portal routes for the agent's "My Card" surface (per spec §6.2).
//
// Mounted under `/portal-api/my-card` from the portal sub-app, which
// applies the portal auth middleware before any of these handlers fire.
// `c.get("session")` therefore always returns a valid PortalSessionPayload
// here (with `partyId`, `orgId`, `userId`, `userType`, `role`).
//
// All four endpoints are agent-only — guarded with a 403 short-circuit
// since the portal sub-app currently mounts the userTypeGuard at the
// path-prefix level (and the guard for /my-card/* is applied in
// portal/index.ts when this router is registered).

import { Hono } from "hono";
import type { PortalEnv } from "../portal/auth/portal.auth.types";
import {
  getMyCard,
  submitMyCard,
  reconfirmMyCard,
  withdrawMyCard,
  MyCardNotFoundError,
  MyCardPendingExistsError,
  OrgCardSettingsNotConfiguredError,
  ReconfirmCapReachedError,
  ReconfirmNotInWindowError,
  ReconfirmRateLimitedError,
} from "./service";
import { submitMyCardSchema } from "./validation";
import { formatZodError } from "../../lib/zod-error-mapper";

const portalMyCardRoutes = new Hono<PortalEnv>();

// Defense-in-depth: even if the parent portal router forgets to apply the
// agent-only guard, every handler here re-checks userType. Tenants and
// owners do not have card surfaces.
function ensureAgent(session: PortalEnv["Variables"]["session"]) {
  return session.userType === "agent";
}

portalMyCardRoutes.get("/", async (c) => {
  const session = c.get("session");
  if (!ensureAgent(session)) {
    return c.json({ error: "Only agents have an e-namecard" }, 403);
  }
  const data = await getMyCard(session.partyId);
  return c.json({ data });
});

portalMyCardRoutes.post("/submit", async (c) => {
  const session = c.get("session");
  if (!ensureAgent(session)) {
    return c.json({ error: "Only agents can submit a card" }, 403);
  }
  const body = await c.req.json().catch(() => ({}));
  const parsed = submitMyCardSchema.safeParse(body);
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "agent-card" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  try {
    const result = await submitMyCard(session.partyId, parsed.data, {
      actorUserId: session.userId,
      actorRole: session.userType, // "agent" — portal session has no admin role
      organizationId: session.orgId,
    });
    return c.json({ data: result });
  } catch (err) {
    if (err instanceof MyCardPendingExistsError) {
      return c.json({ error: { code: err.code, message: err.message } }, err.status);
    }
    if (err instanceof OrgCardSettingsNotConfiguredError) {
      return c.json({ error: { code: err.code, message: err.message } }, err.status);
    }
    throw err;
  }
});

portalMyCardRoutes.post("/reconfirm", async (c) => {
  const session = c.get("session");
  if (!ensureAgent(session)) {
    return c.json({ error: "Only agents can re-confirm a card" }, 403);
  }
  try {
    const result = await reconfirmMyCard(session.partyId, {
      actorUserId: session.userId,
      actorRole: session.userType,
      organizationId: session.orgId,
    });
    return c.json({ data: result });
  } catch (err) {
    if (err instanceof MyCardNotFoundError) {
      return c.json({ error: { code: err.code, message: err.message } }, err.status);
    }
    if (err instanceof ReconfirmNotInWindowError) {
      return c.json({ error: { code: err.code, message: err.message } }, err.status);
    }
    if (err instanceof ReconfirmCapReachedError) {
      return c.json({ error: { code: err.code, message: err.message } }, err.status);
    }
    if (err instanceof ReconfirmRateLimitedError) {
      return c.json({ error: { code: err.code, message: err.message } }, err.status);
    }
    if (err instanceof OrgCardSettingsNotConfiguredError) {
      return c.json({ error: { code: err.code, message: err.message } }, err.status);
    }
    throw err;
  }
});

portalMyCardRoutes.post("/withdraw", async (c) => {
  const session = c.get("session");
  if (!ensureAgent(session)) {
    return c.json({ error: "Only agents can withdraw a card" }, 403);
  }
  try {
    const result = await withdrawMyCard(session.partyId, {
      actorUserId: session.userId,
      actorRole: session.userType,
      organizationId: session.orgId,
    });
    return c.json({ data: result });
  } catch (err) {
    if (err instanceof MyCardNotFoundError) {
      return c.json({ error: { code: err.code, message: err.message } }, err.status);
    }
    throw err;
  }
});

export { portalMyCardRoutes };
