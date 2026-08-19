// Data Import (M9) — HTTP routes.
// Gated behind ENABLE_PHASE2_TENANT_TRACKER per task spec (no new flag).
// POST /runs is admin-only; GET /runs and GET /runs/:id are editor+.

import { Hono } from "hono";
import { runImportRequestSchema } from "@kason/shared";
import type { SessionPayload } from "../../lib/auth";
import { isPhase2FlagEnabled } from "../../lib/feature-flags";
import { requireRole } from "../../middleware/require-role";
import { listRunsService, getRunService, runImport } from "./service";
import type { ImportSession } from "./types";

export const dataImportRoutes = new Hono<{ Variables: { session: SessionPayload } }>();

// ── Per-request feature-flag gate (FIRST — before requireRole) ───────────────
dataImportRoutes.use("*", async (c, next) => {
  if (!isPhase2FlagEnabled("ENABLE_PHASE2_TENANT_TRACKER")) {
    return c.json({ error: "not_found" }, 404);
  }
  await next();
});

function toImportSession(s: SessionPayload): ImportSession {
  return { orgId: s.orgId, userId: s.userId, role: "admin", userType: "operator" };
}

// ── GET /runs — list import runs (editor+) ───────────────────────────────────

dataImportRoutes.get("/runs", requireRole("editor"), async (c) => {
  const result = await listRunsService(toImportSession(c.get("session")));
  if (!result.ok) return c.json({ error: result.error }, result.status as 400);
  return c.json(result.data, result.status as 200);
});

// ── GET /runs/:id — get import run detail (editor+) ──────────────────────────

dataImportRoutes.get("/runs/:id", requireRole("editor"), async (c) => {
  const result = await getRunService(toImportSession(c.get("session")), c.req.param("id"));
  if (!result.ok) return c.json({ error: result.error }, result.status as 404);
  return c.json(result.data, result.status as 200);
});

// ── POST /runs — trigger an import run (admin only) ──────────────────────────

dataImportRoutes.post("/runs", requireRole("admin"), async (c) => {
  const body: unknown = await c.req.json().catch(() => ({}));
  const parsed = runImportRequestSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
  const result = await runImport(toImportSession(c.get("session")), { dryRun: parsed.data.dryRun });
  if (!result.ok) return c.json({ error: result.error }, result.status as 400);
  return c.json(result.data, result.status as 200);
});
