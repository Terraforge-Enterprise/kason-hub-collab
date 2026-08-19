import Decimal from "decimal.js";

/**
 * Pure commission + TA nett-payout calculator.
 *
 * Field semantics (must match Excel template
 * `docs/templates/commission-claim-template.xlsx`, columns L=AgentTier %,
 * M=Commission %, N=Nett Payout):
 *
 * - `tierPercentage` ∈ [0, 100] — the agent's tier rate, server-resolved
 *   from their agent level via CommissionRule.
 * - `commissionPercentage` ∈ [0, 100] — the AGENT'S SHARE of the deal's
 *   commission. 100 means solo (or this agent's full share). < 100 when the
 *   deal is jointly handled and the agents have negotiated a split (e.g.
 *   50/50, 70/30). NOT a separate "rate" field — the rate is implicit in
 *   tier × commission.
 * - `taSharePercent` ∈ [0, 100] — cobroke TA-only split. 100 when solo
 *   (default), <100 when cobroke is checked and the TA profit is split
 *   between two agents. INDEPENDENT from `commissionPercentage`.
 * - `totalCommissionPctOnKey` >= `commissionPercentage` (Rule C invariant).
 *
 * Calc:
 *   commission       = adjRental × tierPct% × commissionPct%
 *   agentTaIncome    = max(0, chargesByAgent − chargesByKaen) × taSharePct%
 *   shortfallApplied = max(0, chargesByKaen − chargesByAgent)
 *                    × (commissionPct / totalCommissionPctOnKey)
 *   nettPayout       = max(0, commission + agentTaIncome − shortfallApplied)
 *
 * TA profit splits by `taSharePercent` (independent lane).
 * Shortfall splits by `commissionPercentage / totalCommissionPctOnKey`.
 * These two ratios can differ (e.g. commission 70/30 + TA 50/50).
 *
 * Caller MUST validate BEFORE calling:
 *   - pax >= 0
 *   - paxDeductionAmount === null OR (pax * paxDeductionAmount <= monthlyRental)
 *   - tierPercentage ∈ [0, 100]
 *   - commissionPercentage ∈ [0, 100]
 *   - taSharePercent ∈ [0, 100] (use 100 when solo; never null)
 *   - totalCommissionPctOnKey >= commissionPercentage
 */
export type ComputeNettPayoutInput = {
  monthlyRental: Decimal;
  pax: number;
  paxDeductionAmount: Decimal | null;
  tierPercentage: Decimal;
  commissionPercentage: Decimal;
  chargesByAgent: Decimal;
  chargesByKaen: Decimal;
  taSharePercent: Decimal;
  totalCommissionPctOnKey: Decimal;
};

export type ComputeNettPayoutOutput = {
  nettPayout: Decimal;
  shortfallApplied: Decimal;
  outstandingBalance: Decimal;
};

const ZERO = new Decimal(0);
const HUNDRED = new Decimal(100);
const ONE = new Decimal(1);

export function computeNettPayout(i: ComputeNettPayoutInput): ComputeNettPayoutOutput {
  const adjRental = i.paxDeductionAmount
    ? i.monthlyRental.minus(i.paxDeductionAmount.times(i.pax))
    : i.monthlyRental;

  const commission = adjRental
    .times(i.tierPercentage)
    .dividedBy(HUNDRED)
    .times(i.commissionPercentage)
    .dividedBy(HUNDRED);

  const profit = Decimal.max(ZERO, i.chargesByAgent.minus(i.chargesByKaen));
  const agentTaIncome = profit.times(i.taSharePercent).dividedBy(HUNDRED);

  const shortfall = Decimal.max(ZERO, i.chargesByKaen.minus(i.chargesByAgent));
  const shortfallRatio = i.totalCommissionPctOnKey.greaterThan(ZERO)
    ? i.commissionPercentage.dividedBy(i.totalCommissionPctOnKey)
    : ONE;
  const shortfallApplied = shortfall.times(shortfallRatio);

  const rawNett = commission.plus(agentTaIncome).minus(shortfallApplied);

  const nettPayout = Decimal.max(ZERO, rawNett).toDecimalPlaces(2);
  const outstandingBalance = Decimal.max(ZERO, rawNett.negated()).toDecimalPlaces(2);

  return {
    nettPayout,
    shortfallApplied: shortfallApplied.toDecimalPlaces(2),
    outstandingBalance,
  };
}
