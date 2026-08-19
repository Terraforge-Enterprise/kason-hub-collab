import { createMiddleware } from "hono/factory";
import { isPhase2FlagEnabled } from "../../lib/feature-flags";

/** Canonical 404 while ENABLE_PHASE2_OWNER_BILLING is dark — no shape leak (public-card precedent). */
export const ownerBillingFlagGate = createMiddleware(async (c, next) => {
  if (!isPhase2FlagEnabled("ENABLE_PHASE2_OWNER_BILLING")) {
    return c.json({ error: "not_found" }, 404);
  }
  await next();
});
