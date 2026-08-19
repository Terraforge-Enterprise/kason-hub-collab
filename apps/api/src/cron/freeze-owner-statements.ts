import { getDb } from "@kason/db";
import { isPhase2FlagEnabled } from "../lib/feature-flags";
import { resolveSystemActor } from "../modules/billing/auto-draft.repository";
import { freezeStatementPeriod } from "../modules/owner-billing/owner-statement-period.service";
import {
  generateStatementService,
  approveStatementService,
} from "../modules/owner-billing/owner-billing.service";
import type { OwnerBillingActorCtx } from "../modules/owner-billing/owner-billing.types";

/**
 * Month-end owner-statement freeze cron (Task 6 of the live-ledger feature).
 *
 * On the 1st of a month the JUST-ENDED calendar month's owner statements are frozen
 * into immutable OwnerStatementPeriod snapshots (Task 4). Mirrors the structure of
 * auto-draft-invoices.ts exactly: flag-guarded BEFORE getDb(), org-by-org, a system
 * actor resolved per org, and per-freeze resilience (one failure never aborts the
 * batch). The freeze itself is idempotent + monotonic (upsertFrozenPeriod), so a
 * re-run — or a run over a month already frozen — is a no-op.
 *
 * Money-path automation: flag-gated (dark until ENABLE_PHASE2_OWNER_STATEMENT_LIVE_
 * LEDGER is set), idempotent, resilient. The GitHub schedule is DISARMED (see
 * .github/workflows/cron-freeze-owner-statements.yml).
 *
 * 2026-08-01 — AUTO-APPROVE + the SYNC-FAILURE GATE. Two changes that together make
 * this cron the whole month-end pipeline rather than just a freeze:
 *
 *   1. Auto-approve. An auto-issued statement lands as `draft`, and draft reaches
 *      nobody — the owner portal excludes it and sendStatementService refuses it.
 *      So each auto-issued combined statement is now approved immediately after
 *      issuing (which also renders Invoice.pdfKey via regenerateStatementPdf), while
 *      the period is still open. There is no manual approve step anywhere any more.
 *
 *   2. Sync-failure gate. generateStatementService's post-commit owner-ledger sync
 *      SWALLOWS its errors, so a transient failure used to be frozen in as an
 *      over-stated payout — permanently, since freezing is terminal and a frozen
 *      month refuses rebuild. An owner whose sync failed during this run is now
 *      skipped instead (see findSyncFailedOwnersSince). This was pre-enablement
 *      blocker #1 for ENABLE_OWNER_STATEMENT_AUTO_ISSUE.
 *
 * Sending is a SEPARATE cron on its own schedule — see send-owner-statements.ts.
 *
 * Task 2 (2026-07-24) — auto-issue. When the SEPARATE, independently-gated
 * ENABLE_OWNER_STATEMENT_AUTO_ISSUE flag is also ON, each owner's COMBINED scope
 * (apartmentId=null) calls generateStatementService immediately BEFORE its
 * freezeStatementPeriod call, so the statement Invoice + mgmt/cleaning Charges + PDF
 * are minted automatically at month-end (byte-identical to "admin clicked Issue, then
 * the freeze cron ran"). generateStatementService is idempotent and self-syncs the
 * owner ledger, and a generate failure is additive-only — it is isolated in its own
 * try/catch and never blocks the freeze that follows it. PER-UNIT scopes are
 * intentionally NEVER auto-issued (see the per-unit loop below, post-panel-review
 * fix): a per-unit statement is a strict subset of the combined one, so it would both
 * mint an empty 0.00 Invoice and deterministically ClosedPeriodError against the
 * already-frozen combined period — the per-unit FREEZE still runs and snapshots the
 * ledger correctly on its own. Auto-issue is also gated to a STRICTLY-PAST billing
 * month (checked against the real wall clock) so a misused/replayed `now` can never
 * auto-issue into a still-open, live month. Flag OFF (the default) ⇒
 * generateStatementService is never called — freeze-only, byte-identical to
 * pre-Task-2 behavior.
 */

/**
 * The calendar month that just ended = the month BEFORE `now`, as "YYYY-MM" (UTC,
 * year-rollover safe). now=2026-07-01 → "2026-06"; now=2026-01-15 → "2025-12".
 */
function endedMonth(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** First-of-month UTC Date for a "YYYY-MM" — the @db.Date grouping key ledger rows use. */
function firstOfMonth(billingMonth: string): Date {
  return new Date(Date.UTC(+billingMonth.slice(0, 4), +billingMonth.slice(5) - 1, 1));
}

/**
 * Owners whose owner-ledger sync FAILED during this run — they must not be frozen.
 *
 * WHY THIS EXISTS (pre-enablement blocker #1). `generateStatementService` re-syncs
 * the owner ledger after its write tx commits, and that hook SWALLOWS every error,
 * leaving only a durable `owner_ledger.sync_failed` AuditLog marker
 * (owner-ledger.sync-hook.ts). Before this gate, auto-issue → sync → freeze all
 * happened in ONE cron iteration, so a single transient sync failure froze an
 * OVER-STATED payout (the mgmt-fee/utility deductions never materialised as ledger
 * rows) — and froze it PERMANENTLY: freezing is terminal, the idempotent generate
 * never re-syncs, and a frozen month refuses to be rebuilt. Silent, unrecoverable,
 * money-wrong.
 *
 * So: if the sync for an owner failed this run, we SKIP that owner's freeze. An
 * unfrozen month is a benign, self-healing state — the next run freezes it once the
 * transient failure clears. A wrongly-frozen month is not recoverable at all.
 *
 * FAIL-CLOSED on attribution. A marker whose `meta.ownerPartyId` is null means the
 * sync died before it could resolve an owner (e.g. the charge lookup itself threw),
 * so we cannot tell WHICH owner is affected. In that case every owner in the org is
 * treated as suspect and the whole org's freezes are skipped this run. Freezing
 * wrong figures is worse than freezing later.
 *
 * Scoped to `createdAt >= since` (this run) so a stale marker from a previous run —
 * or from ordinary app traffic days ago — can never wedge the freeze forever.
 * AuditLog is indexed on (organizationId, createdAt), so this stays cheap.
 */
async function findSyncFailedOwnersSince(
  orgId: string,
  since: Date,
): Promise<{ owners: Set<string>; unattributed: boolean }> {
  const markers = await getDb().auditLog.findMany({
    where: {
      organizationId: orgId,
      action: "owner_ledger.sync_failed",
      createdAt: { gte: since },
    },
    select: { entityId: true, meta: true },
  });

  const owners = new Set<string>();
  let unattributed = false;
  for (const m of markers) {
    // `meta.ownerPartyId` is the authoritative attribution; recordSyncFailure sets it
    // to null when no owner was resolved. `entityId` mirrors it when known but falls
    // back to a chargeId, so it is NOT trustworthy on its own.
    const metaOwner =
      m.meta && typeof m.meta === "object" && !Array.isArray(m.meta)
        ? (m.meta as Record<string, unknown>).ownerPartyId
        : undefined;
    if (typeof metaOwner === "string" && metaOwner.length > 0) owners.add(metaOwner);
    else unattributed = true;
  }
  return { owners, unattributed };
}

export async function runFreezeOwnerStatementsCron(
  now: Date = new Date(),
): Promise<{
  ranOrgs: number;
  frozen: number;
  skipped: number;
  issued: number;
  issueFailed: number;
  approved: number;
  approveFailed: number;
  /** Freezes withheld because this run's owner-ledger sync failed — see findSyncFailedOwnersSince. */
  syncBlocked: number;
}> {
  // Flag guard returns BEFORE getDb() (matches auto-draft-invoices.ts): dark ⇒ no DB
  // connection, no freeze — not even a connectivity check.
  if (!isPhase2FlagEnabled("ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER")) {
    // eslint-disable-next-line no-console
    console.log("[freeze-owner-statements] flag off — no-op");
    return {
      ranOrgs: 0, frozen: 0, skipped: 0, issued: 0, issueFailed: 0,
      approved: 0, approveFailed: 0, syncBlocked: 0,
    };
  }

  // Watermark for the sync-failure gate below. Taken from the REAL wall clock, not
  // the injected `now`, because it is compared against AuditLog.createdAt (also real
  // wall clock) — a replayed/injected `now` must not widen or narrow the window.
  const runStartedAt = new Date();

  const db = getDb();
  const billingMonth = endedMonth(now);
  const monthStart = firstOfMonth(billingMonth);

  // Task 2 (auto-issue) — read ONCE per run, mirrors the top-of-function flag-read
  // style. OFF ⇒ the per-scope loop below never calls generateStatementService at
  // all (not even a no-op check per scope) — byte-identical to pre-Task-2 behavior.
  // ALSO gated to a STRICTLY-PAST billing month, checked against the REAL wall clock
  // (mirrors freezeStatementPeriod's own guard, owner-statement-period.service.ts:104-
  // 110) — not the injected `now` param. This stops a misused/replayed `now` (e.g. a
  // manual runFreezeOwnerStatementsCron(futureDate) whose endedMonth happens to equal
  // the REAL current month) from auto-issuing mgmt/cleaning charges into a still-open,
  // live month; the freeze guard below would then reject that month outright anyway.
  const nowReal = new Date();
  const curMonthStart = Date.UTC(nowReal.getUTCFullYear(), nowReal.getUTCMonth(), 1);
  const billingMonthPast = monthStart.getTime() < curMonthStart;
  const autoIssueEnabled = isPhase2FlagEnabled("ENABLE_OWNER_STATEMENT_AUTO_ISSUE") && billingMonthPast;

  const orgs = await db.organization.findMany({ select: { id: true } });

  let ranOrgs = 0;
  let frozen = 0;
  let skipped = 0;
  let issued = 0;
  let issueFailed = 0;
  let approved = 0;
  let approveFailed = 0;
  let syncBlocked = 0;

  for (const org of orgs) {
    // Per-ORG isolation: a transient DB/infra throw in this org's setup
    // (resolveSystemActor or the owner-enumeration findMany) must NEVER propagate out
    // of the sweep and abort every later org's month-end freeze. Catch it here, count
    // the org as skipped, and continue to the next org. The per-FREEZE try/catch below
    // stays NESTED so a single freeze failure is still isolated at scope granularity.
    try {
      const actor = await resolveSystemActor(org.id);
      if (!actor) {
        // No admin User to attribute the freeze audit to — skip the whole org.
        // eslint-disable-next-line no-console
        console.error(`[freeze-owner-statements] org ${org.id}: no admin actor, skipping`);
        skipped += 1;
        continue;
      }
      ranOrgs += 1;

      // Distinct (owner, apartment) pairs with ACTIVE ledger activity in the ended
      // month. Each owner is frozen COMBINED (apartmentId=null) plus once per distinct
      // per-unit apartmentId. A null apartmentId row (property-level) contributes to the
      // owner's combined scope only.
      const rows = await db.ownerLedgerEntry.findMany({
        where: { organizationId: org.id, status: "active", statementMonth: monthStart },
        select: { ownerPartyId: true, apartmentId: true },
        distinct: ["ownerPartyId", "apartmentId"],
      });

      const owners = new Set(rows.map((r) => r.ownerPartyId));
      const ctx: OwnerBillingActorCtx = {
        orgId: org.id,
        actorUserId: actor.actorUserId,
        actorRole: actor.actorRole,
      };

      // Deliverable B — SERIAL per-scope iteration (Task-4 residual mitigation). Freeze
      // scopes SEQUENTIALLY (nested for + await), never in parallel / Promise.all: a
      // serial cron guarantees no two concurrent freezes of the SAME (owner, scope),
      // which is Task 4's documented concurrency residual (a row committed between the
      // freeze's row-read and its resolveOwnerBalance read). Serializing here is that
      // residual's mitigation — do NOT parallelize this loop.
      for (const ownerPartyId of owners) {
        // Each distinct per-unit apartmentId this owner had activity on.
        const apartmentIds = new Set(
          rows
            .filter((r) => r.ownerPartyId === ownerPartyId && r.apartmentId)
            .map((r) => r.apartmentId as string),
        );

        // Combined scope (apartmentId = null) — the owner-wide statement — FIRST. The
        // per-unit freezes proceed ONLY if this succeeds, restoring the "per-unit frozen ⇒
        // combined frozen" invariant the closed-period guard + R5/R6 reconciliation (all
        // combined-scope) assume. If the combined freeze fails we DO NOT touch this owner's
        // per-unit periods — a per-unit frozen without its combined sibling would be neither
        // guarded against post-freeze writes nor scanned for drift.
        let combinedFrozen = false;

        // Task 2 (auto-issue) — mint the statement Invoice BEFORE the freeze so the
        // freeze's post-commit PDF-attach step finds it (byte-identical to "admin
        // clicked Issue, then the freeze cron ran"). generateStatementService is
        // idempotent (an existing non-void statement is returned as-is) and self-syncs
        // the owner ledger. A generate failure is additive-only: it must NEVER skip or
        // abort the freeze below (the freeze is the immutability guarantee and today
        // runs regardless of whether an Invoice exists) — own try/catch, own counter.
        //
        // COMBINED SCOPE ONLY — per-unit scopes are intentionally NOT auto-issued (see
        // the per-unit freeze loop below). A per-unit statement is a strict subset of
        // this combined one, so a per-unit generateStatementService call would find
        // every charge already minted here and return an empty 0.00 Invoice — and
        // because assertPeriodOpen checks ONLY the combined-scope period for {owner,
        // month}, and this combined freeze commits before any per-unit scope is
        // reached, that call would also deterministically throw ClosedPeriodError on
        // EVERY per-unit scope, EVERY run (an issueFailed++ + console.error flood with
        // no diagnostic value). The per-unit FREEZE below still snapshots the ledger
        // correctly on its own, so combined-only auto-issue loses nothing.
        if (autoIssueEnabled) {
          try {
            const res = await generateStatementService(ctx, {
              ownerPartyId,
              billingMonth,
              apartmentId: undefined, // combined scope
            });
            if (res.ok) {
              issued += 1;

              // AUTO-APPROVE (2026-08-01) — the statement must reach the owner with
              // no human in the loop, and `draft` reaches nobody: the owner portal
              // shows sent/approved/paid/partial and excludes draft
              // (portal.owner-statements.routes), and sendStatementService refuses
              // anything not `approved` WITH a pdfKey. approveStatementService does
              // both halves — it transitions draft→approved and then calls
              // regenerateStatementPdf, which writes Invoice.pdfKey.
              //
              // Runs BEFORE the freeze, while the period is still open, so nothing
              // here can trip assertPeriodOpen. It mints no dated charges — it moves
              // a status and renders bytes — so it is not a money-path write.
              //
              // Idempotent by status: a re-run finds the statement already
              // `approved` and gets a 409 STATEMENT_NOT_APPROVABLE, which is the
              // expected steady state, NOT a failure — hence the 409 is not counted
              // as approveFailed. Additive-only: like the generate above, a failure
              // here must never skip or abort the freeze.
              try {
                const appr = await approveStatementService(ctx, res.data.id);
                if (appr.ok) {
                  approved += 1;
                } else if (appr.status !== 409) {
                  approveFailed += 1;
                  // eslint-disable-next-line no-console
                  console.error(
                    `[freeze-owner-statements] org ${org.id} owner ${ownerPartyId} combined ${billingMonth}: approve failed —`,
                    appr.error,
                  );
                }
              } catch (e) {
                approveFailed += 1;
                // eslint-disable-next-line no-console
                console.error(
                  `[freeze-owner-statements] org ${org.id} owner ${ownerPartyId} combined ${billingMonth}: approve failed —`,
                  (e as Error).message,
                );
              }
            } else {
              issueFailed += 1;
              // eslint-disable-next-line no-console
              console.error(
                `[freeze-owner-statements] org ${org.id} owner ${ownerPartyId} combined ${billingMonth}: issue failed —`,
                res.error,
              );
            }
          } catch (e) {
            issueFailed += 1;
            // eslint-disable-next-line no-console
            console.error(
              `[freeze-owner-statements] org ${org.id} owner ${ownerPartyId} combined ${billingMonth}: issue failed —`,
              (e as Error).message,
            );
          }
        }

        // ── Sync-failure gate (pre-enablement blocker #1) ─────────────────────
        // The generate above re-syncs the owner ledger through a hook that SWALLOWS
        // its errors. If that sync failed for this owner during THIS run, the ledger
        // is missing the mgmt-fee/utility deductions — freezing now would make an
        // OVER-STATED payout permanent and unrecoverable. Skip the freeze instead;
        // the next run picks it up once the transient failure clears.
        const { owners: syncFailedOwners, unattributed } = await findSyncFailedOwnersSince(
          org.id,
          runStartedAt,
        );
        if (unattributed || syncFailedOwners.has(ownerPartyId)) {
          // +1 combined scope, +N per-unit scopes — every scope that ends the run
          // unfrozen is counted, never silently dropped.
          const withheld = 1 + apartmentIds.size;
          syncBlocked += withheld;
          // eslint-disable-next-line no-console
          console.error(
            `[freeze-owner-statements] org ${org.id} owner ${ownerPartyId} ${billingMonth}: owner-ledger sync FAILED this run${
              unattributed ? " (unattributed marker — failing closed for every owner in this org)" : ""
            } — withholding ${withheld} freeze(s) so an over-stated payout is never made immutable`,
          );
          continue;
        }

        try {
          await freezeStatementPeriod(ctx, { ownerPartyId, apartmentId: null, billingMonth });
          frozen += 1;
          combinedFrozen = true;
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error(
            `[freeze-owner-statements] org ${org.id} owner ${ownerPartyId} combined ${billingMonth}: freeze failed —`,
            (e as Error).message,
          );
          skipped += 1;
        }

        if (!combinedFrozen) {
          // Combined freeze failed — SKIP this owner's per-unit freezes to preserve the
          // invariant. Count them as skipped (they are scopes that end the run not frozen),
          // never silently dropped. Per-owner isolation is unchanged: continue the sweep.
          if (apartmentIds.size > 0) {
            skipped += apartmentIds.size;
            // eslint-disable-next-line no-console
            console.error(
              `[freeze-owner-statements] org ${org.id} owner ${ownerPartyId} ${billingMonth}: combined freeze failed — skipping ${apartmentIds.size} per-unit freeze(s) to preserve the per-unit⇒combined invariant`,
            );
          }
          continue;
        }

        for (const apartmentId of apartmentIds) {
          // Task 2 (auto-issue) — per-unit scopes are intentionally NOT auto-issued.
          // See the combined-scope comment above: a per-unit statement is a strict
          // subset of the combined one (would mint an empty 0.00 Invoice) and would
          // deterministically hit ClosedPeriodError once the combined freeze above has
          // committed (assertPeriodOpen checks only the combined-scope period). The
          // per-unit FREEZE below still snapshots the ledger correctly on its own.
          try {
            await freezeStatementPeriod(ctx, { ownerPartyId, apartmentId, billingMonth });
            frozen += 1;
          } catch (e) {
            // eslint-disable-next-line no-console
            console.error(
              `[freeze-owner-statements] org ${org.id} owner ${ownerPartyId} apt ${apartmentId} ${billingMonth}: freeze failed —`,
              (e as Error).message,
            );
            skipped += 1;
          }
        }
      }
    } catch (e) {
      // Org-level failure (resolveSystemActor or owner-enumeration threw) — isolate it:
      // one org's error must not abort the sweep. Mirror the per-freeze log style.
      // eslint-disable-next-line no-console
      console.error(
        `[freeze-owner-statements] org ${org.id}: org-level failure, skipping —`,
        (e as Error).message,
      );
      skipped += 1;
      continue;
    }
  }

  return { ranOrgs, frozen, skipped, issued, issueFailed, approved, approveFailed, syncBlocked };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runFreezeOwnerStatementsCron().then((r) => {
    // eslint-disable-next-line no-console
    console.log(
      `[freeze-owner-statements] ran ${r.ranOrgs} org(s); frozen ${r.frozen}, skipped ${r.skipped}, issued ${r.issued}, issueFailed ${r.issueFailed}, approved ${r.approved}, approveFailed ${r.approveFailed}, syncBlocked ${r.syncBlocked}`,
    );
    process.exit(0);
  });
}
