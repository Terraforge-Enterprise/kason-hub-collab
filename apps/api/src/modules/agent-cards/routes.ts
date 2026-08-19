// Admin routes for the Agent E-Namecard module (per spec §6.1).
//
// Phase 4 surface adds the moderation queue + mutation endpoints on top
// of Phase 3's read-only routes:
//   - GET  /                          list (queue) — editor
//   - GET  /_meta/pending-count       sidebar badge counter — editor
//   - GET  /version/:versionId        detail — editor (Phase 3)
//   - GET  /:partyId                  history — editor (Phase 3)
//   - POST /version/:versionId/approve   manager
//   - POST /version/:versionId/reject    manager
//   - POST /:partyId/regenerate-token    manager
//   - POST /:partyId/revoke              manager
//
// Cross-org enumeration is blocked at the service layer: queries are
// scoped to `session.orgId` in the WHERE clause, so a request for a
// versionId / partyId from another org returns 404 with no shape leak.
//
// Mutation error mapping:
//   AgentCardNotFoundError                → 404
//   AgentCardConflictError                → 409
//   OrgCardSettingsNotConfiguredError     → 409 (e.g. approving without settings)

import { Hono } from "hono";
import type { SessionPayload } from "../../lib/auth";
import { requireRole } from "../../middleware/require-role";
import {
  AgentCardConflictError,
  AgentCardNotFoundError,
  approveVersion,
  countPendingVersions,
  getVersionForOrg,
  listVersionsForOrg,
  listVersionsForParty,
  OrgCardSettingsNotConfiguredError,
  regenerateToken,
  rejectVersion,
  revokeActiveCard,
} from "./service";
import { listVersionsQuerySchema, rejectVersionSchema } from "./validation";
import { formatZodError } from "../../lib/zod-error-mapper";

const agentCardsRoutes = new Hono<{ Variables: { session: SessionPayload } }>();

// All endpoints require at least 'editor' (the lowest admin tier).
agentCardsRoutes.use("*", requireRole("editor"));

// GET /api/agent-cards/_meta/pending-count — sidebar badge counter.
//
// Declared before any param-style route so the literal "_meta" segment
// always wins. Two segments here, while `/:partyId` is one — they can't
// collide, but keeping literal routes first matches the convention used
// elsewhere in this file.
agentCardsRoutes.get("/_meta/pending-count", async (c) => {
  const session = c.get("session");
  const count = await countPendingVersions(session.orgId);
  return c.json({ data: { count } });
});

// GET /api/agent-cards — paginated queue list with optional ?status= filter.
agentCardsRoutes.get("/", async (c) => {
  const session = c.get("session");
  const parsed = listVersionsQuerySchema.safeParse({
    status: c.req.query("status"),
    limit: c.req.query("limit"),
    offset: c.req.query("offset"),
  });
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "agent-card" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await listVersionsForOrg(session.orgId, parsed.data);
  return c.json(result);
});

// GET /api/agent-cards/version/:versionId — single version detail.
//
// IMPORTANT: this MUST be declared BEFORE the `:partyId` route below,
// otherwise Hono's matcher would treat "version" as a partyId (a UUID
// would never collide, but mistyped or forged params would).
agentCardsRoutes.get("/version/:versionId", async (c) => {
  const session = c.get("session");
  const versionId = c.req.param("versionId");
  const row = await getVersionForOrg(session.orgId, versionId);
  if (!row) {
    // Treat cross-org and not-exist identically — see file header.
    return c.json({ error: "Not found" }, 404);
  }
  return c.json({ data: row });
});

// POST /api/agent-cards/version/:versionId/approve — manager-gated.
//
// Per-route role gate: the file-level middleware enforces `editor`, but
// mutations require `manager` (or higher). We layer a second middleware
// just on these endpoints rather than splitting the file.
agentCardsRoutes.post("/version/:versionId/approve", requireRole("manager"), async (c) => {
  const session = c.get("session");
  const versionId = c.req.param("versionId");
  try {
    const result = await approveVersion(versionId, {
      actorUserId: session.userId,
      actorRole: session.role,
      organizationId: session.orgId,
    });
    return c.json({ data: result });
  } catch (err) {
    if (err instanceof AgentCardNotFoundError) return c.json({ error: err.message }, 404);
    if (err instanceof AgentCardConflictError) return c.json({ error: err.message }, 409);
    if (err instanceof OrgCardSettingsNotConfiguredError) {
      return c.json({ error: err.message, code: err.code }, 409);
    }
    throw err;
  }
});

// POST /api/agent-cards/version/:versionId/reject — manager-gated.
agentCardsRoutes.post("/version/:versionId/reject", requireRole("manager"), async (c) => {
  const session = c.get("session");
  const versionId = c.req.param("versionId");
  const body = await c.req.json().catch(() => ({}));
  const parsed = rejectVersionSchema.safeParse(body);
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "agent-card" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  try {
    const result = await rejectVersion(versionId, {
      actorUserId: session.userId,
      actorRole: session.role,
      organizationId: session.orgId,
      reason: parsed.data.reason,
    });
    return c.json({ data: result });
  } catch (err) {
    if (err instanceof AgentCardNotFoundError) return c.json({ error: err.message }, 404);
    if (err instanceof AgentCardConflictError) return c.json({ error: err.message }, 409);
    throw err;
  }
});

// POST /api/agent-cards/:partyId/regenerate-token — manager-gated.
agentCardsRoutes.post("/:partyId/regenerate-token", requireRole("manager"), async (c) => {
  const session = c.get("session");
  const partyId = c.req.param("partyId");
  try {
    const result = await regenerateToken(partyId, {
      actorUserId: session.userId,
      actorRole: session.role,
      organizationId: session.orgId,
    });
    return c.json({ data: result });
  } catch (err) {
    if (err instanceof AgentCardNotFoundError) return c.json({ error: err.message }, 404);
    if (err instanceof AgentCardConflictError) return c.json({ error: err.message }, 409);
    throw err;
  }
});

// POST /api/agent-cards/:partyId/revoke — manager-gated.
agentCardsRoutes.post("/:partyId/revoke", requireRole("manager"), async (c) => {
  const session = c.get("session");
  const partyId = c.req.param("partyId");
  try {
    const result = await revokeActiveCard(partyId, {
      actorUserId: session.userId,
      actorRole: session.role,
      organizationId: session.orgId,
    });
    return c.json({ data: result });
  } catch (err) {
    if (err instanceof AgentCardNotFoundError) return c.json({ error: err.message }, 404);
    if (err instanceof AgentCardConflictError) return c.json({ error: err.message }, 409);
    throw err;
  }
});

// GET /api/agent-cards/:partyId — version history for one agent.
//
// Returns an empty array when the party has no versions yet (or when
// the partyId belongs to another org). The empty-array case is
// indistinguishable from cross-org by design — callers without a party
// in their org get the same shape as callers whose party is brand new.
agentCardsRoutes.get("/:partyId", async (c) => {
  const session = c.get("session");
  const partyId = c.req.param("partyId");
  const rows = await listVersionsForParty(session.orgId, partyId);
  return c.json({ data: rows });
});

export { agentCardsRoutes };
