import { createMiddleware } from "hono/factory";
import { isPhase2FlagEnabled } from "../../lib/feature-flags";

/** Canonical 404 while ENABLE_PHASE2_SPRINTS is dark — no shape leak (mirrors tasksFlagGate). */
export const sprintsFlagGate = createMiddleware(async (c, next) => {
  if (!isPhase2FlagEnabled("ENABLE_PHASE2_SPRINTS")) {
    return c.json({ error: "not_found" }, 404);
  }
  await next();
});
