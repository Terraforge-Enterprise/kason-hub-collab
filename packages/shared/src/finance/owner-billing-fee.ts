// Owner-Billing (M6) — the per-owner management fee + per-row SST money function.
// Plan: docs/superpowers/plans/2026-06-11-phase2-owner-billing.md (Task B1).
//
// Deterministic integer-cent math. The cent primitive (`toCents` /
// `centsToString`) is the shared foundation in packages/shared/src/utils/money-cents.ts
// — the SAME one `prorateAmount` builds on — so the half-up-on-magnitude contract
// lives in one place (and B2/B3 net-remittance / statement totals reuse it too).
// Money strings are parsed to cents by exact decimal-string splitting (NOT
// parseFloat, which drifts), and rounding is Math.round on a non-negative
// magnitude — i.e. round-half-up. All values here are non-negative (rent, fee %,
// cap, SST %), so half-up on magnitude == half-up.
//
// Nothing is hardcoded: the cap is the per-owner `capAmount`, and SST is whatever
// `sstPercent` the row carries. There is no 250 / 2500 / fixed-rate anywhere.

import type { FeeType } from "../schemas/owner-billing";
import { centsToString, toCents } from "../utils/money-cents";

export interface ManagementFeeConfig {
  /** "percent" → feeValue% of rent; "fixed" → feeValue flat RM; "cap" → min(feeValue% of rent, capAmount). */
  feeType: FeeType;
  /** Decimal string: a percent when feeType is percent/cap, a flat RM amount when fixed. */
  feeValue: string;
  /** Decimal string (RM). Required by domain when feeType is "cap"; ignored otherwise. */
  capAmount: string | null;
  /** Decimal string percent read PER ROW — never assume a fixed national rate. */
  sstPercent: string;
}

export interface ManagementFeeResult {
  /** Fee before SST, 2dp string. */
  base: string;
  /** SST on the base, 2dp string. */
  sst: string;
  /** base + sst, 2dp string. */
  total: string;
  /**
   * Human label. For percent/cap: the combined effective percent
   * feeValue × (1 + sstPercent/100), trimmed (e.g. "10.8%", "7.56%").
   * For fixed: "<sstPercent>% SST" (a flat fee has no meaningful percent).
   */
  effectivePercentLabel: string;
}

/** Parse a non-negative decimal-string percent. Rejects > 2 dp and negatives. */
function parsePercent(p: string): number {
  const s = p.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) {
    throw new Error(`computeManagementFee: invalid percent "${p}" (non-negative, max 2 decimal places)`);
  }
  return Number(s);
}

/** Trim trailing zeros from a fixed-decimal string: "10.80" → "10.8", "7.00" → "7". */
function trimDecimal(s: string): string {
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

export function computeManagementFee(cfg: ManagementFeeConfig, monthlyRent: string): ManagementFeeResult {
  const sstPct = parsePercent(cfg.sstPercent);

  let baseCents: number;
  if (cfg.feeType === "fixed") {
    baseCents = toCents(cfg.feeValue, "computeManagementFee");
  } else {
    const rentCents = toCents(monthlyRent, "computeManagementFee");
    const feePct = parsePercent(cfg.feeValue);
    // half-up on a non-negative magnitude
    const percentCents = Math.round((rentCents * feePct) / 100);
    if (cfg.feeType === "cap") {
      if (cfg.capAmount == null) {
        throw new Error('computeManagementFee: capAmount is required when feeType is "cap"');
      }
      baseCents = Math.min(percentCents, toCents(cfg.capAmount, "computeManagementFee"));
    } else {
      baseCents = percentCents;
    }
  }

  const sstCents = Math.round((baseCents * sstPct) / 100);
  const totalCents = baseCents + sstCents;

  let effectivePercentLabel: string;
  if (cfg.feeType === "fixed") {
    effectivePercentLabel = `${trimDecimal(cfg.sstPercent.trim())}% SST`;
  } else {
    const feePct = parsePercent(cfg.feeValue);
    // combined effective percent; up to 4 dp is enough for 2dp×2dp inputs, then trim.
    const combined = feePct * (1 + sstPct / 100);
    effectivePercentLabel = `${trimDecimal(combined.toFixed(4))}%`;
  }

  return {
    base: centsToString(baseCents),
    sst: centsToString(sstCents),
    total: centsToString(totalCents),
    effectivePercentLabel,
  };
}

/** Per-owner free-period bounds (ISO datetime strings, or null when unset). */
export interface FreePeriodConfig {
  freePeriodStart: string | null;
  freePeriodEnd: string | null;
}

/**
 * True iff the first-of-month (UTC) for `billingMonth` ("YYYY-MM") falls within
 * [freePeriodStart, freePeriodEnd] inclusive. Returns false if either bound is
 * null/absent (an open-ended or unset window is treated as "no free period").
 */
export function isInFreePeriod(billingMonth: string, cfg: FreePeriodConfig): boolean {
  if (cfg.freePeriodStart == null || cfg.freePeriodEnd == null) return false;

  const m = /^(\d{4})-(\d{2})$/.exec(billingMonth.trim());
  if (!m) {
    throw new Error(`isInFreePeriod: invalid billingMonth "${billingMonth}" (expected "YYYY-MM")`);
  }
  const firstOfMonth = Date.UTC(Number(m[1]), Number(m[2]) - 1, 1);
  const start = Date.parse(cfg.freePeriodStart);
  const end = Date.parse(cfg.freePeriodEnd);

  return firstOfMonth >= start && firstOfMonth <= end;
}

/**
 * Vacancy-based no-income gate: charge the management fee only when there is an
 * active tenancy AND the billing month is not inside the owner's free period.
 */
export function shouldChargeMgmtFee(args: { hasActiveTenancy: boolean; inFreePeriod: boolean }): boolean {
  return args.hasActiveTenancy && !args.inFreePeriod;
}
