import { getDb } from "@kason/db";
import { resolveSystemActor } from "../modules/billing/auto-draft.repository";
import { runReconciliation } from "../modules/owner-ledger/reconciliation/runs";
import type { OwnerLedgerActorCtx } from "../modules/owner-ledger/owner-ledger.types";

/**
 * Nightly owner closed-period reconciliation cron (R8).
 *
 * For every org it runs a FULL-SCOPE reconciliation of BOTH checks (source-to-ledger +
 * frozen-integrity) as a `cron`-triggered OwnerLedgerReconciliationRun, so the R9
 * enablement preflight always has a fresh completed run of each type to gate on. Mirrors
 * freeze-owner-statements.ts: org-by-org, a system actor resolved per org, per-ORG
 * try/catch isolation (one org's setup failure never aborts the sweep). runReconciliation
 * itself isolates per-type AND per-period, so a single check/period failure marks only its
 * own run `failed` — never throws out.
 *
 * FLAG-INDEPENDENT (spec R10): unlike the freeze cron, this cron has NO
 * ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER guard — the reconciliation net is read-only
 * w.r.t. money (writes only reconciliation rows) and MUST run BEFORE the live-ledger flag
 * is enabled so the preflight can decide whether enabling is safe. With no frozen periods
 * the checks are trivially clean, so an ungated nightly run is safe.
 *
 * The GitHub schedule is DISARMED (see .github/workflows/cron-reconcile-owner-closed-period.yml).
 */
export async function runReconcileOwnerClosedPeriodCron(): Promise<{
  ranOrgs: number;
  runsCompleted: number;
  runsFailed: number;
  skipped: number;
}> {
  const db = getDb();
  const orgs = await db.organization.findMany({ select: { id: true } });

  let ranOrgs = 0;
  let runsCompleted = 0;
  let runsFailed = 0;
  let skipped = 0;

  for (const org of orgs) {
    // Per-ORG isolation: a transient throw in this org's setup (resolveSystemActor) must
    // NEVER abort the sweep. Catch, count skipped, continue to the next org.
    try {
      const actor = await resolveSystemActor(org.id);
      if (!actor) {
        // No admin User to attribute the run to — skip the whole org.
        // eslint-disable-next-line no-console
        console.error(`[reconcile-owner-closed-period] org ${org.id}: no admin actor, skipping`);
        skipped += 1;
        continue;
      }
      ranOrgs += 1;

      const ctx: OwnerLedgerActorCtx = {
        orgId: org.id,
        actorUserId: actor.actorUserId,
        actorRole: actor.actorRole,
      };

      // Full scope (no owner/month filter) → both checks. runReconciliation persists the
      // run rows and never throws (per-type / per-period isolation), so we tally the
      // durable statuses rather than a return code.
      const { runIds } = await runReconciliation(ctx, {
        reconciliationType: "both",
        triggerType: "cron",
        triggeredById: actor.actorUserId,
      });
      const runs = await db.ownerLedgerReconciliationRun.findMany({
        where: { id: { in: runIds } },
        select: { status: true },
      });
      runsCompleted += runs.filter((r) => r.status === "completed").length;
      runsFailed += runs.filter((r) => r.status === "failed").length;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(
        `[reconcile-owner-closed-period] org ${org.id}: org-level failure, skipping —`,
        (e as Error).message,
      );
      skipped += 1;
      continue;
    }
  }

  return { ranOrgs, runsCompleted, runsFailed, skipped };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runReconcileOwnerClosedPeriodCron().then((r) => {
    // eslint-disable-next-line no-console
    console.log(
      `[reconcile-owner-closed-period] ran ${r.ranOrgs} org(s); runs completed ${r.runsCompleted}, failed ${r.runsFailed}, skipped ${r.skipped}`,
    );
    process.exit(0);
  });
}
