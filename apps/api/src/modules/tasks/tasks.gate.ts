import { createMiddleware } from "hono/factory";
import { isPhase2FlagEnabled } from "../../lib/feature-flags";

/** Canonical 404 while ENABLE_PHASE2_TASKS is dark — no shape leak (public-card precedent). */
export const tasksFlagGate = createMiddleware(async (c, next) => {
  if (!isPhase2FlagEnabled("ENABLE_PHASE2_TASKS")) {
    return c.json({ error: "not_found" }, 404);
  }
  await next();
});
