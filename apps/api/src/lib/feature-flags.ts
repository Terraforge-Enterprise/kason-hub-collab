// apps/api/src/lib/feature-flags.ts
import type { Phase2Flag } from "@kason/shared";

/**
 * Phase-2 flags default OFF: absent/unset env ⇒ false. On: "true" | "1".
 *
 * Per-env enablement (not in this file): main dev/staging sets ENABLE_PHASE2_*
 * in the Lightsail container env via .github/workflows/cd-auto-deploy.yml; the
 * web bundle mirrors them as VITE_ENABLE_PHASE2_* in apps/web/.env.production.
 * uat/prod stay dark until promoted deliberately.
 */
export function isPhase2FlagEnabled(flag: Phase2Flag): boolean {
  const v = process.env[flag];
  return v === "true" || v === "1";
}

/**
 * Letting-commission routing (first-full-month rent → KAEN Invoice/IVTEN + owner-borne SST).
 * DEFAULT ON (user directive: ship live), with an explicit kill switch. Unlike the Phase-2
 * flags this is opt-OUT: active everywhere unless ENABLE_LETTING_COMMISSION is "0" | "false".
 */
export function isLettingCommissionEnabled(): boolean {
  const v = process.env.ENABLE_LETTING_COMMISSION;
  return v !== "0" && v !== "false";
}
