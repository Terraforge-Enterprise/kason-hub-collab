import { isPhase2FlagEnabled } from "../lib/feature-flags";
import { runFpxRequerySweep, type FpxRequerySweepResult } from "../modules/payments/fpx-requery.service";

/**
 * FPX requery sweep cron — asks the gateway about payments still in flight.
 *
 * Until this job existed the system could only ever be TOLD what happened to a
 * payment. Fiuu delivers a callback 3 times at 15-minute intervals and then stops
 * permanently, so any notification lost to a deploy window, an outage, or a
 * misconfigured portal URL was lost for good — the payer debited, and nothing on
 * our side that could find it again. Fiuu's own guidance is to poll pending
 * transactions every half hour rather than time them out locally.
 *
 * Structure mirrors freeze-owner-statements.ts: flag guard BEFORE any DB work,
 * resilient per row, self-invoking under `npm run cron:fpx-requery`.
 *
 * Money-path automation, so: idempotent (results route through the same
 * `applyVerifiedFpxOutcome` an inbound callback uses, which settles exactly
 * once), conservative (only a checksum-verified gateway answer changes anything —
 * a transport failure or unreadable reply leaves the payment untouched), and
 * rate-limited (Fiuu blocks offending IPs without notice). The GitHub schedule
 * ships DISARMED — see .github/workflows/cron-fpx-requery.yml.
 *
 * Unlike the crons around it, this one is SAFE to arm early and costly to leave
 * off: with it off, a lost callback is permanent; with it on, the worst case is a
 * few queries that tell us nothing.
 */
export async function runFpxRequeryCron(): Promise<FpxRequerySweepResult> {
  const empty: FpxRequerySweepResult = {
    checked: 0,
    settled: 0,
    failed: 0,
    parked: 0,
    stillPending: 0,
    unresolved: 0,
  };

  // Flag guard BEFORE any DB or gateway work (matches the sibling crons): dark ⇒
  // no connection, no queries, not even a connectivity check.
  if (!isPhase2FlagEnabled("ENABLE_PHASE2_FPX")) {
    // eslint-disable-next-line no-console
    console.log("[fpx-requery] flag off — no-op");
    return empty;
  }

  return runFpxRequerySweep();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runFpxRequeryCron()
    .then((r) => {
      // eslint-disable-next-line no-console
      console.log(
        // `parked` MUST appear here. It was added to the result and then never
        // printed — and this line is the job's only output, so a bucket that
        // never reaches the log is invisible. `parked` is the one that matters
        // most operationally: money the bank took that our books do not yet show.
        `[fpx-requery] checked ${r.checked}; settled ${r.settled}, failed ${r.failed}, parked ${r.parked}, stillPending ${r.stillPending}, unresolved ${r.unresolved}`,
      );
      process.exit(0);
    })
    .catch((e) => {
      // A thrown sweep means we could not even enumerate candidates. Exit non-zero
      // so the scheduler surfaces it rather than reporting a silent success.
      // eslint-disable-next-line no-console
      console.error("[fpx-requery] sweep failed —", (e as Error).message);
      process.exit(1);
    });
}
