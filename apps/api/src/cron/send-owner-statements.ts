import { getDb } from "@kason/db";
import { isPhase2FlagEnabled } from "../lib/feature-flags";
import { resolveSystemActor } from "../modules/billing/auto-draft.repository";
import { sendStatementService } from "../modules/owner-billing/owner-billing.service";
import type { OwnerBillingActorCtx } from "../modules/owner-billing/owner-billing.types";

/**
 * Month-end owner-statement SEND cron.
 *
 * The last step of the month-end pipeline. freeze-owner-statements.ts issues,
 * approves, renders and freezes the just-ended month on the 1st; this cron then
 * releases those statements to owners on the day the org chose.
 *
 * ── WHAT "SEND" ACTUALLY DOES (read this before enabling) ────────────────────
 * It transitions the statement Invoice to `sent`. It does NOT email anyone.
 * `sendStatementService` has never sent an email — it flips the status and mints a
 * signed download URL. The email is a deliberate, marked seam: `emailOwnerStatement`
 * below. Wiring it up is the ONLY thing standing between this cron and owners
 * actually being notified.
 *
 * Owner PORTAL visibility does NOT depend on this cron. portal.owner-statements
 * gates on sent/approved/paid/partial, and the freeze cron already approves, so an
 * owner can see their frozen statement from the 1st regardless. What this cron adds
 * today is the `sent` bookkeeping transition and the hook point for notification.
 *
 * ── SCHEDULING ───────────────────────────────────────────────────────────────
 * Per-org, in the ORG'S OWN timezone (Organization.timezone), from
 * Organization.ownerStatementSendDay / .ownerStatementSendHour.
 *
 * The schedule is a THRESHOLD, not an exact match: a statement becomes due once the
 * org's local clock passes (sendDay, sendHour) of the month AFTER its billing month,
 * and stays due until it is sent. That is what makes "August's statement can go out
 * any time in September" literally true, and it means a missed, failed or late run
 * simply sends on the next run instead of dropping the month on the floor. An
 * exact-day match would silently lose a month whenever a run was skipped.
 *
 * Scoped to the JUST-ENDED month only, so arming this cron can never retro-blast a
 * backlog of historical statements at owners.
 *
 * ── CONTRACT (mirrors freeze-owner-statements.ts deliberately) ───────────────
 *   • flag-guarded BEFORE getDb() — dark ⇒ no DB connection at all
 *   • org-by-org, system actor resolved per org, per-org failure isolation
 *   • SERIAL per-statement, never Promise.all
 *   • idempotent — an already-`sent` statement is filtered out by the query
 *   • one statement's failure never aborts the batch
 */

/** The calendar month that just ended, as "YYYY-MM" (UTC, year-rollover safe). */
function endedMonth(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** First-of-month UTC Date for a "YYYY-MM". */
function firstOfMonth(billingMonth: string): Date {
  return new Date(Date.UTC(+billingMonth.slice(0, 4), +billingMonth.slice(5) - 1, 1));
}

/**
 * The org's LOCAL wall-clock day-of-month and hour at instant `now`.
 *
 * Uses Intl rather than a fixed offset so DST and any future tz change are handled
 * by the platform's tz database instead of by arithmetic here. An unknown or
 * malformed tz string would make Intl throw; the caller treats that as "not due"
 * rather than sending at the wrong local time.
 */
function orgLocalDayHour(now: Date, timezone: string): { day: number; hour: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    day: "numeric",
    hour: "numeric",
    hour12: false,
  }).formatToParts(now);
  const day = Number(parts.find((p) => p.type === "day")?.value);
  const hour = Number(parts.find((p) => p.type === "hour")?.value);
  return { day, hour };
}

/**
 * Has the org's local clock reached its send moment for the just-ended month?
 *
 * `now` must already be in the month AFTER `billingMonth` — the caller guarantees
 * that by deriving billingMonth from endedMonth(now). Given that, "due" is simply
 * local-day > sendDay, or local-day === sendDay and local-hour >= sendHour.
 */
function isSendDue(
  now: Date,
  timezone: string,
  sendDay: number,
  sendHour: number,
): boolean {
  let local: { day: number; hour: number };
  try {
    local = orgLocalDayHour(now, timezone);
  } catch {
    // Unresolvable timezone — refuse to guess. Not due; logged by the caller.
    return false;
  }
  if (!Number.isFinite(local.day) || !Number.isFinite(local.hour)) return false;
  if (local.day > sendDay) return true;
  return local.day === sendDay && local.hour >= sendHour;
}

/**
 * SEAM — notify the owner that their statement is ready.
 *
 * NOT IMPLEMENTED ON PURPOSE (2026-08-01, explicit product decision: portal now,
 * email later). Owners can already read the statement in the portal from the 1st;
 * this is the notification on top.
 *
 * To implement, this is the whole job:
 *   1. Resolve the owner's email. Party has no guaranteed email column — confirm
 *      where the owner's address actually lives before assuming one exists, and
 *      decide what a missing address should do (skip loudly, not silently).
 *   2. Build a template beside apps/api/src/lib/email-templates/password-reset.ts.
 *   3. Attach the PDF, or link `downloadUrl` (already returned by
 *      sendStatementService below). A signed URL expires — check its TTL against
 *      how long an owner might sit on the mail before deciding.
 *   4. Send via `sendEmail` (apps/api/src/lib/email.ts, SES).
 *   5. Decide the failure contract. Today a send that cannot notify STILL marks the
 *      statement `sent`, because `sent` means "released to the owner", and the
 *      portal genuinely has it. If email becomes the primary channel that is the
 *      wrong default — a bounce would leave a statement marked sent that nobody
 *      received. Revisit this line when the email goes in, don't inherit it.
 */
async function emailOwnerStatement(_args: {
  orgId: string;
  ownerPartyId: string;
  statementId: string;
  billingMonth: string;
  downloadUrl: string;
}): Promise<void> {
  // Intentionally a no-op. See the docstring above.
}

export async function runSendOwnerStatementsCron(
  now: Date = new Date(),
): Promise<{ ranOrgs: number; sent: number; skipped: number; sendFailed: number; notDue: number }> {
  // Flag guard BEFORE getDb() (matches freeze-owner-statements.ts): dark ⇒ no DB
  // connection, no status transition, nothing.
  if (!isPhase2FlagEnabled("ENABLE_OWNER_STATEMENT_AUTO_SEND")) {
    // eslint-disable-next-line no-console
    console.log("[send-owner-statements] flag off — no-op");
    return { ranOrgs: 0, sent: 0, skipped: 0, sendFailed: 0, notDue: 0 };
  }

  const db = getDb();
  const billingMonth = endedMonth(now);
  const monthStart = firstOfMonth(billingMonth);

  // Never send a month that has not actually ended, even if `now` was injected.
  // Checked against the REAL wall clock, mirroring the freeze cron's guard.
  const nowReal = new Date();
  const curMonthStart = Date.UTC(nowReal.getUTCFullYear(), nowReal.getUTCMonth(), 1);
  if (monthStart.getTime() >= curMonthStart) {
    // eslint-disable-next-line no-console
    console.log(
      `[send-owner-statements] ${billingMonth} is not a strictly-past month — no-op`,
    );
    return { ranOrgs: 0, sent: 0, skipped: 0, sendFailed: 0, notDue: 0 };
  }

  const orgs = await db.organization.findMany({
    select: {
      id: true,
      timezone: true,
      ownerStatementSendDay: true,
      ownerStatementSendHour: true,
    },
  });

  let ranOrgs = 0;
  let sent = 0;
  let skipped = 0;
  let sendFailed = 0;
  let notDue = 0;

  for (const org of orgs) {
    // Per-ORG isolation: one org's setup failure must never abort the sweep.
    try {
      if (!isSendDue(now, org.timezone, org.ownerStatementSendDay, org.ownerStatementSendHour)) {
        notDue += 1;
        continue;
      }

      const actor = await resolveSystemActor(org.id);
      if (!actor) {
        // eslint-disable-next-line no-console
        console.error(`[send-owner-statements] org ${org.id}: no admin actor, skipping`);
        skipped += 1;
        continue;
      }
      ranOrgs += 1;

      const ctx: OwnerBillingActorCtx = {
        orgId: org.id,
        actorUserId: actor.actorUserId,
        actorRole: actor.actorRole,
      };

      // Candidates: the just-ended month's owner statements that are approved and
      // carry a rendered PDF — exactly what sendStatementService accepts. Anything
      // already `sent`/`paid`/`void`, still `draft`, or missing its pdfKey is
      // excluded here, which is what makes re-runs idempotent and cheap.
      const candidates = await db.invoice.findMany({
        where: {
          organizationId: org.id,
          invoiceType: "owner_statement",
          periodMonth: monthStart,
          status: "approved",
          pdfKey: { not: null },
        },
        select: { id: true, ownerPartyId: true },
      });

      // SERIAL — mirrors the freeze cron. These are money-document transitions; a
      // parallel sweep buys nothing on a monthly job and costs isolation.
      for (const inv of candidates) {
        try {
          const res = await sendStatementService(ctx, inv.id);
          if (!res.ok) {
            sendFailed += 1;
            // eslint-disable-next-line no-console
            console.error(
              `[send-owner-statements] org ${org.id} statement ${inv.id} ${billingMonth}: send failed —`,
              res.error,
            );
            continue;
          }
          sent += 1;

          // Notification seam. Isolated in its own try/catch: the statement IS
          // released (status committed above) whether or not we can notify, so a
          // notification failure must not be reported as a send failure. Revisit if
          // email ever becomes the primary channel — see emailOwnerStatement.
          try {
            await emailOwnerStatement({
              orgId: org.id,
              ownerPartyId: inv.ownerPartyId ?? "",
              statementId: inv.id,
              billingMonth,
              downloadUrl: res.data.downloadUrl,
            });
          } catch (e) {
            // eslint-disable-next-line no-console
            console.error(
              `[send-owner-statements] org ${org.id} statement ${inv.id}: notification failed (statement IS sent) —`,
              (e as Error).message,
            );
          }
        } catch (e) {
          sendFailed += 1;
          // eslint-disable-next-line no-console
          console.error(
            `[send-owner-statements] org ${org.id} statement ${inv.id} ${billingMonth}: send failed —`,
            (e as Error).message,
          );
        }
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(
        `[send-owner-statements] org ${org.id}: org-level failure, skipping —`,
        (e as Error).message,
      );
      skipped += 1;
      continue;
    }
  }

  return { ranOrgs, sent, skipped, sendFailed, notDue };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSendOwnerStatementsCron().then((r) => {
    // eslint-disable-next-line no-console
    console.log(
      `[send-owner-statements] ran ${r.ranOrgs} org(s); sent ${r.sent}, skipped ${r.skipped}, sendFailed ${r.sendFailed}, notDue ${r.notDue}`,
    );
    process.exit(0);
  });
}
