// apps/api/src/modules/owner-ledger/closed-period.ts
// R1/R2 — the error a closed-period write guard throws, plus its 409 body builder.
import type { ClosedPeriodErrorBody, Phase2Flag } from "@kason/shared";
import { isPhase2FlagEnabled } from "../../lib/feature-flags";

// R4 flag — NOT in the flag registry yet (added by the PPA spike, plan Task 11).
// An absent flag reads OFF via isPhase2FlagEnabled (a plain process.env lookup),
// so the cast is safe: while unset it returns false and PPA stays dark.
const PPA_FLAG = "ENABLE_PHASE2_PRIOR_PERIOD_ADJUSTMENT" as Phase2Flag;

/**
 * Thrown IN-TRANSACTION by `assertPeriodOpen` when a write targets a frozen
 * owner-statement month. Routes translate it to HTTP 409 via `toClosedPeriodBody`
 * (the central `app.onError` handler + the createEntryService result path).
 *
 * `priorPeriodAdjustmentSupported`/`suggestedPostingMonth` are resolved at
 * construction time from the PPA flag, so they reflect the flag state at the
 * moment of rejection.
 */
export class ClosedPeriodError extends Error {
  readonly originalBillingMonth: string;
  readonly currentOpenMonth: string;
  readonly priorPeriodAdjustmentSupported: boolean;
  readonly suggestedPostingMonth: string | null;

  constructor(args: { originalBillingMonth: string; currentOpenMonth: string }) {
    super(`closed_period: statement month ${args.originalBillingMonth} is frozen`);
    this.name = "ClosedPeriodError";
    this.originalBillingMonth = args.originalBillingMonth;
    this.currentOpenMonth = args.currentOpenMonth;
    const ppa = isPhase2FlagEnabled(PPA_FLAG);
    this.priorPeriodAdjustmentSupported = ppa;
    // suggestedPostingMonth equals currentOpenMonth today, but is kept as its own
    // field (null when PPA is off) so the two can evolve independently (spec R2).
    this.suggestedPostingMonth = ppa ? args.currentOpenMonth : null;
  }
}

/** Build the structured 409 body from a ClosedPeriodError. */
export function toClosedPeriodBody(e: ClosedPeriodError): ClosedPeriodErrorBody {
  return {
    code: "closed_period",
    originalBillingMonth: e.originalBillingMonth,
    currentOpenMonth: e.currentOpenMonth,
    priorPeriodAdjustmentSupported: e.priorPeriodAdjustmentSupported,
    suggestedPostingMonth: e.suggestedPostingMonth,
  };
}
