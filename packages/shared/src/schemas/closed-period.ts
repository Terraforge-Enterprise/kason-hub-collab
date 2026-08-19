// packages/shared/src/schemas/closed-period.ts
// R2 — the structured 409 body a route returns when a write targets a FROZEN
// owner-statement period. Shared so web consumers can parse it. Months are "YYYY-MM".
import { z } from "zod";

const MONTH = /^\d{4}-\d{2}$/;

export const closedPeriodErrorBody = z.object({
  code: z.literal("closed_period"),
  /** The frozen statement month the rejected write targeted. */
  originalBillingMonth: z.string().regex(MONTH),
  /** Where the ledger is now (first-of-current-UTC-month) — informational, PPA-independent. */
  currentOpenMonth: z.string().regex(MONTH),
  /** Reflects ENABLE_PHASE2_PRIOR_PERIOD_ADJUSTMENT (false while the flag/feature is dark). */
  priorPeriodAdjustmentSupported: z.boolean(),
  /** Where an adjustment MAY be posted — non-null only when priorPeriodAdjustmentSupported. */
  suggestedPostingMonth: z.string().regex(MONTH).nullable(),
});

export type ClosedPeriodErrorBody = z.infer<typeof closedPeriodErrorBody>;
