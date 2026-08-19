// Feature-flag visibility (2026-08-06). One page of truth for the environment
// you are looking at: this endpoint reports the API's LIVE process.env value
// for every registry flag; the Settings page pairs each with its own baked
// VITE twin so a web-ON/API-OFF split renders as a loud mismatch instead of a
// feature that silently does nothing (the "expenses never reach the invoice"
// class of bug).
//
// Deliberately NOT flag-gated — a diagnostic that hides itself when flags are
// wrong would defeat its purpose. Read-only, manager+.
import { Hono } from "hono";
import { PHASE2_FLAGS } from "@kason/shared";
import type { SessionPayload } from "../../lib/auth";
import { isPhase2FlagEnabled } from "../../lib/feature-flags";
import { requireRole } from "../../middleware/require-role";

const featureFlagsRoutes = new Hono<{ Variables: { session: SessionPayload } }>();

// GET /api/feature-flags — every registry flag with its live API-side value.
featureFlagsRoutes.get("/", requireRole("manager"), (c) => {
  return c.json({
    flags: PHASE2_FLAGS.map((name) => ({ name, api: isPhase2FlagEnabled(name) })),
  });
});

export { featureFlagsRoutes };
