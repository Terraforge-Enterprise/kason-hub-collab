/**
 * Scheduled auto-BILLING — the second half of the billing schedule.
 *
 * Drafting and billing are two different acts, and until now only the first one
 * had a schedule:
 *   • DRAFT (runDayOfMonth)      — the invoice exists; nobody owes anything, and
 *                                  the tenant cannot see it.
 *   • BILL  (autoBillDayOfMonth) — the invoice is approved: its charges post as
 *                                  live receivables, its documents are issued,
 *                                  the owner ledger picks up the rental income,
 *                                  and the tenant sees an amount payable.
 *
 * This module does the second one on a schedule. It does NOT reimplement
 * approval: it selects which drafts are due and hands them to
 * `approveBulkService`, the same function the queue's "Issue all" button calls.
 * One approval path, one set of money rules, one audit shape — a second
 * implementation of "post a charge" is exactly the drift this repo keeps paying
 * for elsewhere.
 *
 * ── WHY THIS IS OPT-IN, AND STAYS OPT-IN ─────────────────────────────────────
 * `autoBillDayOfMonth` is NULL by default and NULL means off. An org that never
 * touches the setting keeps the human approval gate exactly as it is today. That
 * default direction is deliberate: the opposite would turn every existing org's
 * next cron fire into unattended live billing.
 *
 * ⚠️ Do NOT confuse this with `DraftConfig.autoApprove`, which is dead and always
 * false. That flag would have meant "approve a draft the instant it is created",
 * which removes the gate entirely with no schedule and no admin-visible date.
 * This feature is the opposite: a date the admin chooses and can see.
 *
 * ── SCOPE, BOUNDED ON BOTH ENDS ──────────────────────────────────────────────
 * Only `tenant_rental` invoices, and only periods from the CURRENT month through
 * the org's draft target month (autoBillPeriodRange).
 *  • Owner statements are excluded — they have their own month-end pipeline with
 *    its own issue/send flags, and sweeping them up here would bypass it.
 *  • Past months are excluded — the mirror of the drafting side, which never
 *    reaches back into a period an owner statement may already have frozen. It
 *    also means an old draft an admin parked on purpose is never silently billed.
 */
import { getDb } from "@kason/db";
import { autoBillPeriodRange } from "@kason/shared";
import { recordAudit } from "../../lib/audit";
import { firstOfMonthUtc, getDraftConfig } from "./auto-draft.repository";
import { approveBulkService } from "./auto-draft.service";
import type { AutoDraftActorCtx } from "./auto-draft.types";

export const AUTO_BILL_TRIGGERED_BY = "system:auto-bill";

export type AutoBillSummary = {
  /** Invoices that moved draft → approved (charges now live). */
  billed: number;
  /**
   * Selected but not billed — approveBulkService reports these when the row was
   * no longer `draft` by the time it ran (a human issued or voided it first).
   * Never an error: a concurrent human action winning a race is correct.
   */
  skipped: number;
  /** The period band actually considered, for the log line and the audit row. */
  from: string;
  to: string;
};

/**
 * Bill every draft rental invoice that is due, for ONE org.
 *
 * Returns a zero summary (never throws) when the org has no config, the schedule
 * is paused, or auto-billing is off — the caller treats all three the same way.
 * `isAutoBillDueOn` is the CALLER's gate, not this function's: the manual "bill
 * now" path (if one is ever added) must be able to reach this without pretending
 * it is the right day, exactly as runAutoDraftInvoices takes its period from its
 * callers rather than resolving one itself.
 */
export async function runAutoBillInvoices(
  ctx: AutoDraftActorCtx & { triggeredBy: string },
  now: Date,
): Promise<AutoBillSummary> {
  const config = await getDraftConfig(ctx.orgId);
  const empty = (from: string, to: string): AutoBillSummary => ({ billed: 0, skipped: 0, from, to });

  if (!config || !config.isActive || config.autoBillDayOfMonth == null) {
    const range = autoBillPeriodRange(now, config?.billPeriodOffset ?? 0);
    return empty(range.from, range.to);
  }

  const { from, to } = autoBillPeriodRange(now, config.billPeriodOffset);
  const db = getDb();

  // `periodMonth` is stored as a first-of-month Date, so the band is a closed
  // interval on that column — gte(first of `from`) .. lte(first of `to`). Using
  // lt(first of to+1) would be equivalent but reads as an off-by-one waiting to
  // happen when someone later widens the band.
  const due = await db.invoice.findMany({
    where: {
      organizationId: ctx.orgId,
      invoiceType: "tenant_rental",
      status: "draft",
      periodMonth: { gte: firstOfMonthUtc(from), lte: firstOfMonthUtc(to) },
    },
    select: { id: true },
    // Deterministic order so a partial failure mid-batch is reproducible, and so
    // the audit row's invoice list is stable between dry runs and real ones.
    orderBy: [{ periodMonth: "asc" }, { invoiceNumber: "asc" }],
  });

  if (due.length === 0) return empty(from, to);

  // Reuse the queue's own approval path — see the header note on why this does
  // not reimplement approval. approveBulkService is per-id transactional: one
  // bad row cannot abort the batch, and it syncs the owner ledger post-commit.
  const res = await approveBulkService(ctx, due.map((i) => i.id));
  if (!res.ok) {
    // approveBulkService returns ok:true even when every id is skipped, so this
    // branch is a genuine service failure, not "nothing to do".
    throw new Error(`auto-bill: approveBulkService failed: ${res.error}`);
  }

  const summary: AutoBillSummary = {
    billed: res.data.approved.length,
    skipped: res.data.skipped.length,
    from,
    to,
  };

  // Run-level audit. Each invoice already gets its own `billing.invoice.approved`
  // row from approveBulkService; this one answers the different question "what
  // did the unattended schedule do on this day, and under which settings" —
  // which is the question asked when a tenant disputes being billed without a
  // human involved.
  if (summary.billed > 0) {
    await db.$transaction((tx) =>
      recordAudit(tx, {
        organizationId: ctx.orgId,
        actorUserId: ctx.actorUserId,
        actorRole: ctx.actorRole,
        action: "billing.autobill.completed",
        entityType: "DraftConfig",
        entityId: config.id,
        meta: {
          billed: summary.billed,
          skipped: summary.skipped,
          periodFrom: from,
          periodTo: to,
          autoBillDayOfMonth: config.autoBillDayOfMonth,
          billPeriodOffset: config.billPeriodOffset,
          triggeredBy: ctx.triggeredBy,
          invoiceIds: res.data.approved,
        },
      }),
    );
  }

  return summary;
}
