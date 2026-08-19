// Reconfirm reminder cron — hourly, idempotent, catch-up safe.
//
// Spec: docs/superpowers/specs/2026-05-05-agent-e-namecard-design.md §11.2
//   - Cadence: hourly.
//   - Idempotency: a reminder of a given kind (T-30 / T-7 / T-1) for a given
//     active card version is sent AT MOST once during that version's
//     approved lifetime. Re-runs of the cron within the same hour, and
//     re-runs after a missed hour, both produce zero duplicates.
//   - Catch-up: if the cron skips an hour, the next firing picks up
//     everything still inside any reminder window that hasn't been
//     notified yet. An agent who missed T-30 still gets T-7 and T-1.
//   - Heartbeat: each successful run emits a structured `[cron:heartbeat]`
//     console line. CloudWatch alarm matches on absence-of-pattern over
//     >25h. We do NOT write a DB heartbeat row because:
//       (a) `AuditLog.actorUserId` and `AuditLog.organizationId` are
//           NOT NULL — heartbeat is a system, cross-org event with no
//           valid value to fill either field.
//       (b) Adding a synthetic system user / cron-run table is broader
//           scope than spec §11.2 asks for.
//       (c) Console-based monitoring is the existing pattern (the audit
//           purge job logs to console; see audit-purge.job.ts).
//
// Idempotency keying — given the existing `Notification` schema lacks
// `kind` / `entityId` fields, we key on the tuple
//   (userId, domain="agent-card", title, createdAt > version.approvedAt)
// where `title` is the per-window literal set by the Phase 7 helpers
// (`notifications.ts`):
//   T-30 → "E-namecard expires in 30 days"
//   T-7  → "E-namecard expires in 7 days"
//   T-1  → "E-namecard expires tomorrow"
// `createdAt > approvedAt` scopes to THIS version's current approved
// lifetime — a brand-new approval reset starts a fresh reminder cycle.
// (If the agent re-submits, gets re-approved, the new version has a
// later approvedAt and prior reminders no longer satisfy the gate.)
//
// Window definition — for each reminder kind we accept ANY approved
// version whose `expiresAt` is in `(now, now + windowDays]` AND has not
// already received that reminder. The "still in window" upper bound is
// `now + windowDays`; the catch-up lower bound is simply `now` (any
// not-yet-expired card). This means:
//   - A version 28 days from expiry will be picked up by the T-30 query
//     even though strictly it's past the "T-30 hour" — the agent just
//     gets the T-30 reminder a couple of days late, which is the spec's
//     intended catch-up behaviour.
//   - A version 7 days from expiry is in BOTH T-30's window (because
//     7 < 30) AND T-7's window. To avoid the T-30 ALSO firing late for
//     a version that's already inside T-7, we narrow each window's
//     LOWER bound to the next-tighter window's upper bound. So:
//       T-30 window: (now + 7d, now + 30d]
//       T-7  window: (now + 1d, now + 7d]
//       T-1  window: (now,      now + 1d]
//     Versions strictly INSIDE a single window get exactly one reminder
//     of that kind. A version that aged through windows without the
//     cron firing receives the LATEST applicable reminder (which is the
//     correct "this is most urgent" message).
//
// Pacing safety: each window queries at most 200 candidates per run.
// Re-running fixes any backlog over multiple firings.
//
// To schedule: configure the deployment environment to run
//   `npm run cron:reconfirm-reminders`
// hourly. On AWS Lightsail this can be done via systemd timer or via an
// external EventBridge → Lambda invocation hitting an HTTP endpoint
// that calls `runReconfirmRemindersOnce()`.

import { fileURLToPath } from "node:url";

import { getDb } from "@kason/db";

import {
  notifyAgentReconfirmT1,
  notifyAgentReconfirmT30,
  notifyAgentReconfirmT7,
} from "../modules/agent-cards/notifications";

type ReminderKind = "T30" | "T7" | "T1";

interface ReminderWindow {
  kind: ReminderKind;
  /** Upper bound: expiresAt <= now + upperDays */
  upperDays: number;
  /** Lower bound: expiresAt > now + lowerDays. Set so windows do not overlap. */
  lowerDays: number;
  /** Exact `Notification.title` set by the Phase 7 dispatch helper. */
  notificationTitle: string;
}

const WINDOWS: ReminderWindow[] = [
  {
    kind: "T30",
    upperDays: 30,
    lowerDays: 7,
    notificationTitle: "E-namecard expires in 30 days",
  },
  {
    kind: "T7",
    upperDays: 7,
    lowerDays: 1,
    notificationTitle: "E-namecard expires in 7 days",
  },
  {
    kind: "T1",
    upperDays: 1,
    lowerDays: 0,
    notificationTitle: "E-namecard expires tomorrow",
  },
];

export interface ReconfirmReminderRunResult {
  startedAt: string;
  finishedAt: string;
  windows: {
    kind: ReminderKind;
    candidatesFound: number;
    notificationsSent: number;
    skippedAlreadyNotified: number;
    skippedNoUserAccount: number;
    errors: number;
  }[];
}

function addDays(base: Date, days: number): Date {
  const out = new Date(base);
  out.setTime(out.getTime() + days * 24 * 60 * 60 * 1000);
  return out;
}

/**
 * Run one pass of the reconfirm-reminder cron.
 *
 * Re-entrant and safe to invoke at any cadence — at-most-once delivery
 * is enforced by the per-window `Notification` lookup before each send.
 */
export async function runReconfirmRemindersOnce(): Promise<ReconfirmReminderRunResult> {
  const startedAt = new Date();
  const db = getDb();
  const stats: ReconfirmReminderRunResult["windows"] = [];

  for (const win of WINDOWS) {
    const stat = {
      kind: win.kind,
      candidatesFound: 0,
      notificationsSent: 0,
      skippedAlreadyNotified: 0,
      skippedNoUserAccount: 0,
      errors: 0,
    };

    try {
      const now = new Date();
      const upper = addDays(now, win.upperDays);
      const lower = addDays(now, win.lowerDays);

      // Approved versions that:
      //   1. are the active version for their party (activeForParty.is set
      //      means the Party.activeCardVersionId points at this row);
      //   2. have an expiresAt strictly inside the window (lower, upper];
      //   3. belong to the agent's Party.
      // We pull the agent's userAccount.id so the Notification idempotency
      // lookup has a userId to match on. If the agent has no portal
      // account yet, we skip the in-app idempotency lookup (the helper
      // would still create a userId=null org-wide row — but without a
      // user we cannot reliably dedup, so we skip outright to avoid
      // duplicate org-noise).
      const candidates = await db.agentCardVersion.findMany({
        where: {
          status: "approved",
          activeForParty: { is: {} }, // pointer from Party.activeCardVersionId IS set to this row
          expiresAt: { gt: lower, lte: upper },
        },
        select: {
          id: true,
          organizationId: true,
          partyId: true,
          approvedAt: true,
          party: {
            select: {
              userAccount: { select: { id: true } },
            },
          },
        },
        take: 200,
      });

      stat.candidatesFound = candidates.length;

      // Look up cardExpiryMonths per org (T-30 body interpolates it). We
      // memoise per-run to avoid one query per candidate in the same org.
      const monthsByOrg = new Map<string, number>();
      const getMonths = async (orgId: string): Promise<number> => {
        const cached = monthsByOrg.get(orgId);
        if (cached !== undefined) return cached;
        const settings = await db.organizationCardSettings.findUnique({
          where: { organizationId: orgId },
          select: { cardExpiryMonths: true },
        });
        const months = settings?.cardExpiryMonths ?? 3;
        monthsByOrg.set(orgId, months);
        return months;
      };

      for (const v of candidates) {
        try {
          const userId = v.party.userAccount?.id ?? null;
          if (!userId) {
            // No portal user to dedup against — skip rather than risk
            // re-spamming an org-wide row every hour.
            stat.skippedNoUserAccount++;
            continue;
          }

          // Idempotency check: did this user already get THIS kind of
          // reminder during the current version's approved lifetime?
          const since = v.approvedAt ?? new Date(0);
          const existing = await db.notification.findFirst({
            where: {
              userId,
              domain: "agent-card",
              title: win.notificationTitle,
              createdAt: { gte: since },
            },
            select: { id: true },
          });
          if (existing) {
            stat.skippedAlreadyNotified++;
            continue;
          }

          if (win.kind === "T30") {
            const months = await getMonths(v.organizationId);
            await notifyAgentReconfirmT30({
              organizationId: v.organizationId,
              agentPartyId: v.partyId,
              cardExpiryMonths: months,
            });
          } else if (win.kind === "T7") {
            await notifyAgentReconfirmT7({
              organizationId: v.organizationId,
              agentPartyId: v.partyId,
            });
          } else {
            await notifyAgentReconfirmT1({
              organizationId: v.organizationId,
              agentPartyId: v.partyId,
            });
          }

          stat.notificationsSent++;
        } catch (err) {
          stat.errors++;
          console.error(
            `[cron:reconfirm-reminders] error sending ${win.kind} for version ${v.id}:`,
            err,
          );
        }
      }
    } catch (err) {
      stat.errors++;
      console.error(
        `[cron:reconfirm-reminders] error in ${win.kind} window:`,
        err,
      );
    }

    stats.push(stat);
  }

  const finishedAt = new Date();
  const result: ReconfirmReminderRunResult = {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    windows: stats,
  };

  // Heartbeat — structured log line. CloudWatch metric filter alarms on
  // absence over >25h per spec §11.2. Stored in stdout, not in DB; see
  // module header for rationale.
  console.log("[cron:heartbeat]", JSON.stringify(result));

  return result;
}

// CLI entry point — run via `npm run cron:reconfirm-reminders` or
// `tsx apps/api/src/cron/reconfirm-reminders.ts`.
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  runReconfirmRemindersOnce()
    .then(() => {
      process.exit(0);
    })
    .catch((err) => {
      console.error("[cron:reconfirm-reminders] FAIL", err);
      process.exit(1);
    });
}
