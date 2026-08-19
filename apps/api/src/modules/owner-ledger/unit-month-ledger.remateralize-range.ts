import { materializeOwnerUnitMonths } from "./unit-month-ledger.materialize";
import { isPhase2FlagEnabled } from "../../lib/feature-flags";
import type { OwnerBillingActorCtx } from "../owner-billing/owner-billing.types";

export async function rematerializeOwnerRecentMonths(
  ctx: OwnerBillingActorCtx,
  ownerPartyId: string,
  anchor: Date,
  monthsBack = 12,
): Promise<void> {
  // Fan-out trigger — gated on the read flag so it's a no-op while dark (no
  // stale rows accrue before go-live; backfill seeds them at flip time).
  if (!isPhase2FlagEnabled("ENABLE_UNIT_MONTH_LEDGER")) return;
  for (let i = 0; i <= monthsBack; i++) {
    const d = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() - i, 1));
    const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    try { await materializeOwnerUnitMonths(ctx, ownerPartyId, month); }
    catch (e) { /* eslint-disable-next-line no-console */ console.error("[unit-month-ledger] rematerialize failed (swallowed):", month, e); }
  }
}
