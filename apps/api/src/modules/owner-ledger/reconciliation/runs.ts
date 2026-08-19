/**
 * R8 — reconciliation run orchestration.
 *
 * Wraps the two check functions (runSourceToLedger / runFrozenIntegrity) in a durable
 * `OwnerLedgerReconciliationRun`: opens the run `running` BEFORE the scan, invokes the
 * check, tallies sourcesScanned/findingsOpened/findingsResolved, marks it `completed`.
 * A THROWN check marks THAT run `failed` with `failureInfo` and NEVER aborts the sweep —
 * the other type's run (and, in the cron, every other org) still executes (per-type /
 * per-org isolation, spec Error Handling R5/R6). The checks themselves already isolate
 * per-period internally; this layer isolates a whole-check throw.
 *
 * Money-read-only: writes ONLY the run row (findings are written by the checks). Runs
 * INDEPENDENT of ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER (spec R10) so the enablement
 * preflight can gate the flag before it is turned on.
 */
import { getDb, type Prisma } from "@kason/db";
import type { OwnerLedgerActorCtx } from "../owner-ledger.types";
import { runSourceToLedger, type RunReconResult } from "./source-to-ledger";
import { runFrozenIntegrity } from "./frozen-integrity";

export type ReconciliationType = "source_to_ledger" | "frozen_integrity" | "both";
type CheckType = "source_to_ledger" | "frozen_integrity";

export interface RunReconciliationOpts {
  reconciliationType?: ReconciliationType;
  ownerPartyId?: string;
  month?: string;
  triggerType: "cron" | "manual";
  triggeredById?: string;
}

const CHECKS: Record<
  CheckType,
  (ctx: OwnerLedgerActorCtx, filter: { ownerPartyId?: string; month?: string }) => Promise<RunReconResult>
> = {
  source_to_ledger: runSourceToLedger,
  frozen_integrity: runFrozenIntegrity,
};

export async function runReconciliation(
  ctx: OwnerLedgerActorCtx,
  opts: RunReconciliationOpts,
): Promise<{ runIds: string[] }> {
  const db = getDb();

  const requested = opts.reconciliationType ?? "both";
  const types: CheckType[] = requested === "both" ? ["source_to_ledger", "frozen_integrity"] : [requested];

  // Full scope = no owner and no month filter (spec: omitting filters = full scope).
  const isFullScope = !opts.ownerPartyId && !opts.month;
  const scopeJson: Prisma.InputJsonValue = isFullScope
    ? { full: true }
    : {
        ...(opts.ownerPartyId ? { ownerPartyId: opts.ownerPartyId } : {}),
        ...(opts.month ? { month: opts.month } : {}),
      };
  const filter = { ownerPartyId: opts.ownerPartyId, month: opts.month };

  const runIds: string[] = [];

  for (const reconciliationType of types) {
    // Open the run `running` BEFORE the scan so a crash mid-scan leaves a durable
    // `running` row (which the R9 preflight treats as not-passable), never a silent gap.
    const run = await db.ownerLedgerReconciliationRun.create({
      data: {
        organizationId: ctx.orgId,
        reconciliationType,
        scopeJson,
        isFullScope,
        status: "running",
        triggerType: opts.triggerType,
        triggeredById: opts.triggeredById ?? null,
      },
    });
    runIds.push(run.id);

    try {
      const res = await CHECKS[reconciliationType](ctx, filter);
      await db.ownerLedgerReconciliationRun.update({
        where: { id: run.id },
        data: {
          status: "completed",
          completedAt: new Date(),
          sourcesScanned: res.sourcesScanned,
          findingsOpened: res.findingsOpened,
          findingsResolved: res.findingsResolved,
        },
      });
    } catch (e) {
      // Per-type isolation: a thrown check marks THIS run failed and continues to the
      // next type — one check's failure never aborts the sweep, and no existing finding
      // is resolved (the check's auto-resolve never ran).
      await db.ownerLedgerReconciliationRun.update({
        where: { id: run.id },
        data: {
          status: "failed",
          completedAt: new Date(),
          failureInfo: e instanceof Error ? e.message : String(e),
        },
      });
    }
  }

  return { runIds };
}
