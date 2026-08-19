import { createMiddleware } from "hono/factory";
import { isPhase2FlagEnabled } from "../../lib/feature-flags";

/**
 * Canonical 404 while ENABLE_PHASE2_BILLING_DOCS is dark — no shape leak
 * (public-card / owner-ledger.gate.ts precedent). Applied as the FIRST
 * middleware on every accounting-documents router; Plan 2's
 * billing-documents module imports and reuses this same gate.
 */
export const billingDocsFlagGate = createMiddleware(async (c, next) => {
  if (!isPhase2FlagEnabled("ENABLE_PHASE2_BILLING_DOCS")) {
    return c.json({ error: "not_found" }, 404);
  }
  await next();
});
