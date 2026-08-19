import { getDb, Prisma } from "@kason/db";
import { isPhase2FlagEnabled } from "../lib/feature-flags";
import { resolveSystemActor } from "../modules/billing/auto-draft.repository";
import { materializeOwnerUnitMonths } from "../modules/owner-ledger/unit-month-ledger.materialize";
import { recordAudit } from "../lib/audit";
import type { AdminRole } from "../lib/rbac";

/**
 * Reconciliation cron: recomputes the last 3 months of UnitMonthLedger figures
 * for every (org, owner, month) combination that has active ledger rows.
 *
 * If any apartment's incomeC / deductibleExpensesC / netPayoutC has drifted from
 * the live-computed value, the row is corrected by materializeOwnerUnitMonths
 * (which always upserts the freshly-computed figures) and a durable
 * `owner_ledger.figure_drift` AuditLog entry is written via recordAudit inside a
 * transaction. Because materialize always writes (no watermark skip), drift from
 * any cause — including input REMOVAL (voided rows, retired fee configs) — is
 * force-corrected on every run.
 *
 * Each (org, owner, month) partition is processed in its own try/catch, so one
 * partition's failure logs and is skipped without aborting the whole run.
 *
 * Flag-gated on ENABLE_UNIT_MONTH_LEDGER.
 */
export async function runReconcileUnitMonthLedgerCron(
  now: Date = new Date(),
): Promise<{ checked: number; fixed: number }> {
  if (!isPhase2FlagEnabled("ENABLE_UNIT_MONTH_LEDGER")) {
    // eslint-disable-next-line no-console
    console.log("[reconcile-unit-month-ledger] flag off — no-op");
    return { checked: 0, fixed: 0 };
  }

  const db = getDb();

  // Current month + trailing 2 months.
  const months = [0, 1, 2].map(
    (i) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)),
  );

  // All (org, owner, month) combinations with active ledger rows in scope.
  const pairs = await db.ownerLedgerEntry.groupBy({
    by: ["organizationId", "ownerPartyId", "statementMonth"],
    where: { status: "active", statementMonth: { in: months } },
  });

  let checked = 0;
  let fixed = 0;

  // Cache resolved system actors per org to avoid N+1 DB queries.
  const actorByOrg = new Map<
    string,
    { actorUserId: string; actorRole: AdminRole }
  >();

  for (const p of pairs) {
    // Each partition in its own try/catch: one failure logs + skips, never
    // aborts the whole run (M3) — including a throw from resolveSystemActor.
    try {
      let actor = actorByOrg.get(p.organizationId);
      if (!actor) {
        const r = await resolveSystemActor(p.organizationId);
        if (!r) {
          // eslint-disable-next-line no-console
          console.error(
            `[reconcile-unit-month-ledger] org ${p.organizationId}: no admin actor, skipping`,
          );
          continue;
        }
        actor = r;
        actorByOrg.set(p.organizationId, r);
      }

      const ctx = {
        orgId: p.organizationId,
        actorUserId: actor.actorUserId,
        actorRole: actor.actorRole,
      };

      const month = `${p.statementMonth.getUTCFullYear()}-${String(
        p.statementMonth.getUTCMonth() + 1,
      ).padStart(2, "0")}`;

      // Read BEFORE figures.
      const before = await db.unitMonthLedger.findMany({
        where: {
          organizationId: p.organizationId,
          ownerPartyId: p.ownerPartyId,
          periodMonth: p.statementMonth,
        },
        select: {
          apartmentId: true,
          netPayoutC: true,
          incomeC: true,
          deductibleExpensesC: true,
        },
      });
      checked += before.length;

      // Recompute + upsert (materialize always writes the current figures).
      await materializeOwnerUnitMonths(ctx, p.ownerPartyId, month);

      // Read AFTER figures.
      const after = await db.unitMonthLedger.findMany({
        where: {
          organizationId: p.organizationId,
          ownerPartyId: p.ownerPartyId,
          periodMonth: p.statementMonth,
        },
        select: {
          apartmentId: true,
          netPayoutC: true,
          incomeC: true,
          deductibleExpensesC: true,
        },
      });

      const beforeByApt = new Map(before.map((b) => [b.apartmentId, b]));

      for (const a of after) {
        const b = beforeByApt.get(a.apartmentId);
        if (
          b &&
          (b.netPayoutC !== a.netPayoutC ||
            b.incomeC !== a.incomeC ||
            b.deductibleExpensesC !== a.deductibleExpensesC)
        ) {
          fixed++;
          // eslint-disable-next-line no-console
          console.warn(
            `[reconcile-unit-month-ledger] drift fixed: org=${p.organizationId} apt=${a.apartmentId} month=${month}`,
          );
          await db.$transaction((tx) =>
            recordAudit(tx, {
              organizationId: p.organizationId,
              actorUserId: actor!.actorUserId,
              actorRole: actor!.actorRole,
              action: "owner_ledger.figure_drift",
              entityType: "UnitMonthLedger",
              entityId: a.apartmentId,
              meta: {
                month,
                before: b,
                after: a,
              } as unknown as Prisma.InputJsonValue,
            }),
          );
        }
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        `[reconcile-unit-month-ledger] partition failed (skipped): org=${p.organizationId} owner=${p.ownerPartyId}`,
        err,
      );
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `[reconcile-unit-month-ledger] checked=${checked} fixed=${fixed}`,
  );
  return { checked, fixed };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runReconcileUnitMonthLedgerCron()
    .then((r) => {
      // eslint-disable-next-line no-console
      console.log("[reconcile-unit-month-ledger]", r);
      process.exit(0);
    })
    .catch((e) => {
      // eslint-disable-next-line no-console
      console.error(e);
      process.exit(1);
    });
}
