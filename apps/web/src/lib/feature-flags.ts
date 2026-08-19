// apps/web/src/lib/feature-flags.ts
import type { Phase2Flag } from "@kason/shared";

/**
 * Phase-2 flags default OFF. Vite only exposes VITE_-prefixed vars to the
 * client bundle, so the web variant of ENABLE_PHASE2_X is VITE_ENABLE_PHASE2_X.
 */
export function isPhase2FlagEnabled(flag: Phase2Flag): boolean {
  const v = (import.meta.env as Record<string, string | undefined>)[`VITE_${flag}`];
  return v === "true" || v === "1";
}

/**
 * Invoice-adjustments detail-drawer UI (tabs + line-level CN/DN display,
 * 2026-07-20-invoice-adjustments plan Phase 1/2). Kept as a standalone check
 * — NOT added to the canonical `Phase2Flag` union in `packages/shared` — because
 * this frontend cut does not touch `packages/*`; a later backend phase folds
 * `ENABLE_PHASE2_INVOICE_ADJUSTMENTS` into that shared list. Mirrors the same
 * `VITE_ENABLE_PHASE2_*` convention `isPhase2FlagEnabled` reads. Flag off (the
 * default) ⇒ the detail drawer renders exactly as it did before this cut.
 */
export function isInvoiceAdjustmentsEnabled(): boolean {
  const v = (import.meta.env as Record<string, string | undefined>).VITE_ENABLE_PHASE2_INVOICE_ADJUSTMENTS;
  return v === "true" || v === "1";
}
