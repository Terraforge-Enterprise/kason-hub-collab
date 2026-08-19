import { getDb } from "@kason/db";
import { resolveBillingPeriod } from "@kason/shared";
import { recordAudit } from "../lib/audit";
import { isPhase2FlagEnabled } from "../lib/feature-flags";
import type { AdminRole } from "../lib/rbac";
import { resolveSystemActor } from "../modules/billing/auto-draft.repository";
import { findBillingGapsService, runAutoDraftInvoices } from "../modules/billing/auto-draft.service";

export async function runAutoDraftInvoicesCron(
  now: Date = new Date(),
): Promise<{ ranOrgs: number; created: number; skipped: number; missingPeriods: number }> {
  if (!isPhase2FlagEnabled("ENABLE_PHASE2_AUTODRAFT")) {
    // eslint-disable-next-line no-console
    console.log("[auto-draft] flag off — no-op");
    return { ranOrgs: 0, created: 0, skipped: 0, missingPeriods: 0 };
  }

  const db = getDb();
  const today = now.getUTCDate();

  const configs = await db.draftConfig.findMany({
    where: { isActive: true, runDayOfMonth: today },
    select: { organizationId: true, billPeriodOffset: true },
  });

  let ranOrgs = 0, created = 0, skipped = 0, missingPeriods = 0;

  for (const cfg of configs) {
    const actor = await resolveSystemActor(cfg.organizationId);
    if (!actor) {
      // eslint-disable-next-line no-console
      console.error(`[auto-draft] org ${cfg.organizationId}: no admin actor, skipping`);
      continue;
    }
    // ADVANCE BILLING: the target period is per-ORG (billPeriodOffset is per-org
    // config), so it MUST be resolved inside the loop — hoisting it above the loop
    // is what made every org share one month and is why the 25th used to draft the
    // month that was already ending. Offset 1 ⇒ a 25 Jul run drafts Aug.
    const periodMonth = resolveBillingPeriod(now, cfg.billPeriodOffset);
    const ctx = {
      orgId: cfg.organizationId,
      actorUserId: actor.actorUserId,
      actorRole: actor.actorRole,
    };
    const r = await runAutoDraftInvoices({ ...ctx, triggeredBy: "system:auto-draft" }, periodMonth);
    ranOrgs += 1;
    created += r.draftsCreated;
    skipped += r.draftsSkipped;

    // Report months that were never drafted at all. This cron bills exactly ONE
    // month per fire and gates on runDayOfMonth, so a missed run — or a
    // billPeriodOffset change, which skips a month by construction — leaves a
    // permanent hole that nothing else would ever mention. Reporting only: see
    // findBillingGapsService for why recovery stays an explicit admin action.
    //
    // Best-effort in its own try/catch. A gap REPORT must never fail a run that
    // just drafted real invoices.
    try {
      const gaps = await findBillingGapsService(ctx, { now });
      const missing = gaps.ok ? gaps.data.missingPeriods : [];
      if (missing.length > 0) {
        missingPeriods += missing.length;
        // eslint-disable-next-line no-console
        console.warn(
          `[auto-draft] org ${cfg.organizationId}: ${missing.length} billing month(s) never drafted: ${missing.join(", ")}. ` +
            `Recover with POST /api/billing/draft-runs {"periodMonth":"${missing[0]}"}.`,
        );
        await recordBillingGapAudit(ctx, missing, periodMonth);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[auto-draft] org ${cfg.organizationId}: gap check failed: ${(err as Error).message}`);
    }
  }

  return { ranOrgs, created, skipped, missingPeriods };
}

/** Durable marker so a gap is recoverable from the audit trail, not just a log line. */
async function recordBillingGapAudit(
  ctx: { orgId: string; actorUserId: string; actorRole: AdminRole },
  missingPeriods: string[],
  targetPeriod: string,
): Promise<void> {
  await getDb().$transaction((tx) =>
    recordAudit(tx, {
      organizationId: ctx.orgId,
      actorUserId: ctx.actorUserId,
      actorRole: ctx.actorRole,
      action: "billing.draftrun.gap_detected",
      entityType: "InvoiceDraftRun",
      entityId: ctx.orgId,
      meta: { missingPeriods, targetPeriod, triggeredBy: "system:auto-draft" },
    }),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runAutoDraftInvoicesCron().then((r) => {
    // eslint-disable-next-line no-console
    console.log(
      `[auto-draft] ran ${r.ranOrgs} org(s); created ${r.created}, skipped ${r.skipped}, ` +
        `${r.missingPeriods} un-drafted month(s) detected`,
    );
    process.exit(0);
  });
}
