/**
 * Nightly scheduled auto-BILLING.
 *
 * Companion to auto-draft-invoices.ts: that cron CREATES drafts on
 * `runDayOfMonth`, this one BILLS them on `autoBillDayOfMonth` (approve →
 * charges post → tenant owes money). Both are gated by the same
 * ENABLE_PHASE2_AUTODRAFT flag, because they are two halves of one feature and
 * an env where drafts appear but never bill is worse than one where neither runs.
 *
 * Ordering note: the workflow runs auto-draft FIRST, then this. With
 * runDayOfMonth === autoBillDayOfMonth (the common "draft and bill on the 1st"
 * setup) that ordering is what lets a single nightly fire do both in sequence.
 * Reversing them would bill yesterday's drafts and leave today's for tomorrow.
 */
import { getDb } from "@kason/db";
import { isAutoBillDueOn } from "@kason/shared";
import { isPhase2FlagEnabled } from "../lib/feature-flags";
import { resolveSystemActor } from "../modules/billing/auto-draft.repository";
import { AUTO_BILL_TRIGGERED_BY, runAutoBillInvoices } from "../modules/billing/auto-bill.service";

export async function runAutoBillInvoicesCron(
  now: Date = new Date(),
): Promise<{ ranOrgs: number; billed: number; skipped: number }> {
  if (!isPhase2FlagEnabled("ENABLE_PHASE2_AUTODRAFT")) {
    // eslint-disable-next-line no-console
    console.log("[auto-bill] flag off — no-op");
    return { ranOrgs: 0, billed: 0, skipped: 0 };
  }

  const db = getDb();

  // Select every org that has auto-billing configured at all, then apply the
  // day rule in JS via the SHARED helper. The rule could be pushed into the
  // query (`autoBillDayOfMonth: { lte: now.getUTCDate() }` excludes NULLs by SQL
  // three-valued logic), but then the cron and the admin UI would each own a
  // copy of "is billing due today" and could drift — the UI would promise a date
  // the cron does not honour. DraftConfig is a per-org SINGLETON, so this reads
  // one row per organisation; there is no scale argument for duplicating it.
  const configs = await db.draftConfig.findMany({
    where: { isActive: true, autoBillDayOfMonth: { not: null } },
    select: { organizationId: true, autoBillDayOfMonth: true },
  });

  let ranOrgs = 0, billed = 0, skipped = 0;

  for (const cfg of configs) {
    if (!isAutoBillDueOn(now, cfg.autoBillDayOfMonth)) continue;

    const actor = await resolveSystemActor(cfg.organizationId);
    if (!actor) {
      // eslint-disable-next-line no-console
      console.error(`[auto-bill] org ${cfg.organizationId}: no admin actor, skipping`);
      continue;
    }

    const ctx = {
      orgId: cfg.organizationId,
      actorUserId: actor.actorUserId,
      actorRole: actor.actorRole,
      triggeredBy: AUTO_BILL_TRIGGERED_BY,
    };

    // Per-org try/catch: one org's failure must not stop every later org from
    // being billed. The draft cron takes the same stance for its gap check.
    try {
      const r = await runAutoBillInvoices(ctx, now);
      ranOrgs += 1;
      billed += r.billed;
      skipped += r.skipped;
      if (r.billed > 0) {
        // eslint-disable-next-line no-console
        console.log(
          `[auto-bill] org ${cfg.organizationId}: billed ${r.billed} invoice(s) for ${r.from}..${r.to}` +
            (r.skipped > 0 ? ` (${r.skipped} skipped — no longer draft)` : ""),
        );
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[auto-bill] org ${cfg.organizationId}: FAILED: ${(err as Error).message}`);
    }
  }

  return { ranOrgs, billed, skipped };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runAutoBillInvoicesCron().then((r) => {
    // eslint-disable-next-line no-console
    console.log(`[auto-bill] ran ${r.ranOrgs} org(s); billed ${r.billed}, skipped ${r.skipped}`);
    process.exit(0);
  });
}
