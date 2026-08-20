import { createMiddleware } from "hono/factory";
import { isPhase2FlagEnabled } from "../../lib/feature-flags";

/** 404 (no shape leak) unless ENABLE_PHASE2_UNIT_ANALYTICS is on. Stacks on top of tasksFlagGate. */
export const analyticsFlagGate = createMiddleware(async (c, next) => {
  if (!isPhase2FlagEnabled("ENABLE_PHASE2_UNIT_ANALYTICS")) {
    return c.json({ error: "not_found" }, 404);
  }
  await next();
});
