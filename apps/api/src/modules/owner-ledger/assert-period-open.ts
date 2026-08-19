// apps/api/src/modules/owner-ledger/assert-period-open.ts
// R1 — the shared closed-period write guard. Runs IN-TRANSACTION, before an
// owner-impacting write, at every creation/edit site. Throws ClosedPeriodError
// when the target owner-statement month is frozen (routes → 409). No-op when the
// live-ledger flag is off, the period is open/absent, or the caller passes the
// authorised prior-period-adjustment intent.
import type { Prisma } from "@kason/db";
import { isPhase2FlagEnabled } from "../../lib/feature-flags";
import { ClosedPeriodError } from "./closed-period";

/** First-of-current-UTC-month. */
function currentOpenMonthStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** First-of-month (UTC) of an arbitrary date — the OwnerStatementPeriod key. */
function firstOfUtcMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

const monthKey = (d: Date): string =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

/**
 * Reject an owner-impacting write whose statement month is frozen.
 *
 * @param tx           the caller's transaction — the period is read here so a
 *                     throw rolls the write back (and a lookup DB error, which
 *                     poisons the tx, fails closed).
 * @param orgId        organization scope.
 * @param ownerPartyId the owner whose combined-scope period gates the write.
 * @param targetMonth  the write's billing/statement month (any day; normalized).
 * @param opts.intent  "prior_period_adjustment" is the ONLY authorised bypass —
 *                     passed solely by the PPA service (plan Task 11).
 */
export async function assertPeriodOpen(
  tx: Prisma.TransactionClient,
  orgId: string,
  ownerPartyId: string,
  targetMonth: Date,
  opts?: { intent?: "prior_period_adjustment" },
): Promise<void> {
  // Flag off ⇒ byte-identical no-op for existing money paths (spec R10).
  if (!isPhase2FlagEnabled("ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER")) return;
  // Authorised forward-adjustment intent bypass (spec R4) — never reads the period.
  if (opts?.intent === "prior_period_adjustment") return;

  const periodMonth = firstOfUtcMonth(targetMonth);
  // Combined-scope period (apartmentId: null) is the freeze unit — matches the
  // freeze cron + the sync-hook's frozen-month check.
  const period = await tx.ownerStatementPeriod.findFirst({
    where: { organizationId: orgId, ownerPartyId, apartmentId: null, periodMonth },
    select: { status: true },
  });
  if (period?.status !== "frozen") return; // open, or no period yet ⇒ allowed

  throw new ClosedPeriodError({
    originalBillingMonth: monthKey(periodMonth),
    currentOpenMonth: monthKey(currentOpenMonthStart()),
  });
}
