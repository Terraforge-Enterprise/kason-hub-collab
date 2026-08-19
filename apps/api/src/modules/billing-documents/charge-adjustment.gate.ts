// apps/api/src/modules/billing-documents/charge-adjustment.gate.ts
//
// Phase 3.1: canonical 404 while ENABLE_PHASE2_INVOICE_ADJUSTMENTS is dark.
// Layered ON TOP of the module-wide billingDocsFlagGate (ENABLE_PHASE2_BILLING_DOCS,
// already applied to every route in billingDocumentsRoutes) — this route needs BOTH
// flags on, mirroring the billingDocsFlagGate pattern for a single route instead of
// the whole router.
import { createMiddleware } from "hono/factory";
import { isPhase2FlagEnabled } from "../../lib/feature-flags";

export const chargeAdjustmentsFlagGate = createMiddleware(async (c, next) => {
  if (!isPhase2FlagEnabled("ENABLE_PHASE2_INVOICE_ADJUSTMENTS")) {
    return c.json({ error: "not_found" }, 404);
  }
  await next();
});
