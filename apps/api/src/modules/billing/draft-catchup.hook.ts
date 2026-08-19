/**
 * Draft catch-up for late-created tenancies (post-commit hook).
 *
 * The auto-draft run bills a period's cohort ONCE, on the org's run day. A
 * tenancy created AFTER that run — admin assigns a tenant on the 5th, backdated
 * move-in on the 1st — missed the bus: no rent draft exists, nothing reaches the
 * approval queue, and the tenant portal has nothing payable. This hook drafts
 * that tenancy's rent on assignment, through the same idempotency keys the run
 * uses (draftRentInvoiceForTenancy). The draft lands in the SAME approval
 * queue — the human money-gate is untouched.
 *
 * TWO period rules, for two different questions:
 *  • the CURRENT month is ALWAYS drafted when the tenancy occupies it. Under
 *    advance billing the run day drafts NEXT month, so the month an admin is
 *    standing in is never a run cohort — waiting for one meant a 12 Aug move-in
 *    was billed nothing for August. Prorated to occupied days, like any run.
 *  • a FUTURE month is drafted only if its cohort demonstrably exists (a
 *    completed InvoiceDraftRun AND ≥1 tenant_rental Invoice for it), so a late
 *    tenancy joins a cohort but never becomes one.
 * Months BEFORE this one stay manual — backdated drafting can land in frozen
 * owner-statement months.
 *
 * ⚠️ That past-month cut is a REAL, UNBACKED GAP, not a covered case. A tenancy
 * created today with a move-in two months ago is never drafted for those months
 * by any automated path, and nothing reports it: findBillingGapsService is
 * PERIOD-level (it flags months with no completed run at all), so a month whose
 * run predates the tenancy reads as covered. Recovery is an explicit
 * POST /billing/draft-runs for the month, by a human who noticed.
 *
 * After drafting, it re-prorates the unit-month's OTHER unapproved drafts
 * (reprorate-rent-drafts.ts) so a handover cannot leave the outgoing tenant on
 * a full month while the incoming one is billed prorated — the two used to sum
 * past the unit's own monthly rent. Approved/posted money is never rewritten:
 * "never revise a draft" still holds for anything that has gone live.
 *
 * Contract mirrors owner-ledger.sync-hook.ts: callers fire AFTER their creating
 * transaction commits; every error is swallowed (a billing catch-up failure must
 * never fail a move-in) and leaves a durable `billing.draftcatchup.failed`
 * AuditLog marker instead of only a console line.
 */
import { getDb, Prisma } from "@kason/db";
import { ymOfUtc } from "@kason/shared";
import { recordAudit } from "../../lib/audit";
import { isPhase2FlagEnabled } from "../../lib/feature-flags";
import { isBillableStatus, tenancyOverlapsPeriod } from "../../lib/tenancy-period";
import type { AutoDraftActorCtx } from "./auto-draft.types";
import { getDraftConfig } from "./auto-draft.repository";
import { draftRentInvoiceForTenancy } from "./auto-draft.service";
import { reprorateRentDraftsForUnit } from "./reprorate-rent-drafts";

export const DRAFT_CATCHUP_TRIGGERED_BY = "system:draft-catchup";

/** The session shape every creator service already holds. */
export type DraftCatchupCtx = { orgId: string; userId: string; role: string };

function actorCtx(ctx: DraftCatchupCtx): AutoDraftActorCtx & { triggeredBy: string } {
  // role originates from the authenticated session (typed `string`); at runtime it
  // is always an AdminRole for these admin-only creator routes — assert at this
  // single boundary, same as owner-ledger.sync-hook.ts.
  return {
    orgId: ctx.orgId,
    actorUserId: ctx.userId,
    actorRole: ctx.role as AutoDraftActorCtx["actorRole"],
    triggeredBy: DRAFT_CATCHUP_TRIGGERED_BY,
  };
}

function firstOfCurrentMonthUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * Durable, queryable marker for a swallowed catch-up failure — the queue's
 * "Generate drafts" button remains the idempotent manual repair, and this row is
 * how the miss stays findable. Best-effort: its own try/catch so an audit-write
 * failure can never re-throw into the creator that fired the hook.
 */
async function recordCatchupFailure(
  ctx: DraftCatchupCtx,
  entityId: string,
  meta: Prisma.InputJsonObject,
  entityType: "Tenancy" | "Listing" = "Tenancy",
): Promise<void> {
  try {
    await getDb().$transaction((tx) =>
      recordAudit(tx, {
        organizationId: ctx.orgId,
        actorUserId: ctx.userId,
        actorRole: ctx.role,
        action: "billing.draftcatchup.failed",
        entityType,
        entityId,
        meta,
      }),
    );
  } catch (auditErr) {
    console.error("[draft-catchup] failed to record failure audit (swallowed):", auditErr);
  }
}

/**
 * Re-prorate a unit's unapproved rent drafts, swallowing every failure into the
 * same durable marker the drafting half uses. Correction is best-effort by
 * contract: it must never fail the move-in (or move-out) that triggered it.
 */
async function reprorateForUnitSafely(
  ctx: DraftCatchupCtx,
  unitId: string,
  now: Date,
  /** Present when a specific tenancy triggered this; absent on the vacate path. */
  tenancyId?: string,
): Promise<void> {
  try {
    await reprorateRentDraftsForUnit(actorCtx(ctx), unitId, now);
  } catch (err) {
    console.error(`[draft-catchup] reprorate unit ${unitId} failed (swallowed):`, err);
    // Recorded against whichever entity actually triggered it — a unit id filed
    // under entityType "Tenancy" would be a false fact in the audit trail.
    await recordCatchupFailure(
      ctx,
      tenancyId ?? unitId,
      { unitId, error: (err as Error).message, stage: "reprorate" },
      tenancyId ? "Tenancy" : "Listing",
    );
  }
}

/**
 * Catch a just-created (or just re-dated) tenancy up with every already-drafted
 * period it occupies, and bring its unit's existing drafts level with current
 * facts. Never throws. Returns the periods it DRAFTED ("YYYY-MM") so tests and
 * callers can observe what happened; corrections are reported via audit rows.
 */
export async function draftCatchupForTenancy(
  ctx: DraftCatchupCtx,
  tenancyId: string,
  now: Date = new Date(),
): Promise<{ drafted: string[] }> {
  const drafted: string[] = [];
  // Same gate as the cron: while the flag is dark this whole feature is inert.
  if (!isPhase2FlagEnabled("ENABLE_PHASE2_AUTODRAFT")) return { drafted };
  try {
    const config = await getDraftConfig(ctx.orgId);
    // Parity with runAutoDraftInvoices: an inactive config drafts nothing, and
    // the rent step is gated on includeRent.
    if (!config || !config.isActive || !config.includeRent) return { drafted };

    const db = getDb();
    const tenancy = await db.tenancy.findFirst({
      where: { id: tenancyId, organizationId: ctx.orgId },
      select: {
        id: true, unitId: true, tenantPartyId: true, propertyId: true,
        startDate: true, endDate: true, firstMonthIsCommission: true, status: true,
      },
    });
    if (!tenancy) return { drafted };

    // ── Draft first, then correct ONCE ───────────────────────────────────────
    // The correction has to observe the final state of the unit-month, which
    // includes any draft this call just created (the handover pair only exists
    // once the incoming draft does). It also has to run when the drafting half
    // is skipped entirely — demoting a tenancy to `draft` is precisely when its
    // already-drafted month must be corrected. So drafting is the conditional
    // part and correction is the unconditional tail, rather than a pass on each
    // side: two passes reported the same locked-stale invoice twice, which is
    // duplicate noise in the money audit trail.
    if (isBillableStatus(tenancy.status)) {
      drafted.push(...(await draftPeriodsForTenancy(ctx, config, tenancy, now)));
    }
    // Unit-scoped and window-scoped rather than tied to the periods drafted
    // above: the event that invalidates a draft (a move-out being recorded)
    // routinely lands in a LATER month than the draft it invalidates, and the
    // drafting scope deliberately never reaches back.
    await reprorateForUnitSafely(ctx, tenancy.unitId, now, tenancyId);
    return { drafted };
  } catch (e) {
    console.error("[draft-catchup] failed (swallowed):", e);
    await recordCatchupFailure(ctx, tenancyId, { error: (e as Error).message });
    return { drafted };
  }
}

/**
 * The drafting half: every period this tenancy should be drafted into, drafted
 * through the run's own keys. Returns the periods it CREATED. Per-period errors
 * are swallowed into durable markers, exactly as before.
 */
async function draftPeriodsForTenancy(
  ctx: DraftCatchupCtx,
  config: { dueDayOffset: number | null },
  tenancy: {
    id: string; unitId: string; tenantPartyId: string; propertyId: string;
    startDate: Date; endDate: Date | null; firstMonthIsCommission: boolean; status: string;
  },
  now: Date,
): Promise<string[]> {
  const drafted: string[] = [];
  const db = getDb();
  const tenancyId = tenancy.id;
  {
    // Periods whose RENT COHORT was demonstrably drafted, current month onward.
    //
    // A completed InvoiceDraftRun alone is NOT sufficient evidence. A run that
    // executed while `includeRent` was off — or with no active config at all —
    // completes normally and drafts zero rent invoices, and InvoiceDraftRun
    // stores no toggle history to tell that apart afterwards. Treating those as
    // covered would let a late tenancy become the ONLY tenant with a rent draft
    // that month, in an org that deliberately bills rent by hand.
    //
    // So coverage requires BOTH: a completed run for the period, AND at least
    // one tenant_rental Invoice actually produced for it. The failure direction
    // is deliberate — an org whose run legitimately drafted nothing (no
    // tenancies yet) simply gets no catch-up, which is the pre-existing
    // behaviour and is one "Generate drafts" click away.
    const monthStart = firstOfCurrentMonthUtc(now);
    const [runs, drafted_periods] = await Promise.all([
      db.invoiceDraftRun.findMany({
        where: { organizationId: ctx.orgId, status: "completed", periodMonth: { gte: monthStart } },
        select: { periodMonth: true },
        distinct: ["periodMonth"],
      }),
      db.invoice.findMany({
        where: {
          organizationId: ctx.orgId,
          invoiceType: "tenant_rental",
          periodMonth: { gte: monthStart },
        },
        select: { periodMonth: true },
        distinct: ["periodMonth"],
      }),
    ]);
    const rentDrafted = new Set(
      drafted_periods.flatMap((i) => (i.periodMonth ? [ymOfUtc(i.periodMonth)] : [])),
    );
    const covered = runs
      .map((r) => ymOfUtc(r.periodMonth))
      .filter((ym) => rentDrafted.has(ym));

    // ── The CURRENT month is always in scope, covered or not ─────────────────
    //
    // The cohort-coverage rule above answers "did a run already bill this
    // period", which is the right question for a FUTURE month — those exist
    // only because a run created them. It is the wrong question for the month
    // the admin is standing in: under advance billing (billPeriodOffset 1) the
    // run day drafts NEXT month, so the current month is never a cohort at all.
    // A tenant who moves in on 12 Aug therefore matched no covered period, got
    // no draft, and had nothing payable in the portal — while the schedule
    // cheerfully drafted them September.
    //
    // So a move-in whose month is the month we are in is drafted on assignment,
    // prorated to its occupied days by resolveMonthlyRentAmount, exactly as a
    // run would have priced it. `includeRent` above is still the org's opt-out;
    // this only removes the requirement that some earlier run had to go first.
    //
    // `tenancyOverlapsPeriod` pre-checks occupancy so a move-in dated NEXT month
    // does not open a transaction only for the drafter to price it at 0 and skip.
    // Months BEFORE this one stay out of scope — see the header note: backdated
    // drafting can land in a frozen owner-statement period.
    const currentPeriod = ymOfUtc(monthStart);
    const periods = [
      ...new Set([
        ...(tenancyOverlapsPeriod(tenancy, monthStart) ? [currentPeriod] : []),
        ...covered,
      ]),
    ].sort();

    for (const ym of periods) {
      try {
        const outcome = await draftRentInvoiceForTenancy(actorCtx(ctx), tenancy, ym, config.dueDayOffset);
        if (outcome === "created") drafted.push(ym);
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          // WHICH unique fired decides whether this is benign. The idempotency
          // key or the rent chargeNumber means the draft (or the tracker-posted
          // rent) already exists — the goal, reached by someone else. Anything
          // else means this tenancy silently got NO draft, so it must leave the
          // durable marker rather than vanish: `invoiceNumber` is
          // TR-{YYYYMM}-{tenancyId.slice(0,8)}, a 32-bit key that two tenancies
          // in one org-month can collide on.
          const target = String((err.meta as { target?: unknown } | undefined)?.target ?? "");
          const benign = target.includes("idempotencyKey") || target.includes("chargeNumber");
          console.warn(
            `[draft-catchup] tenancy ${tenancyId} period ${ym}: P2002 on [${target}] — ${benign ? "already drafted/posted elsewhere" : "NOT DRAFTED"}`,
          );
          if (!benign) {
            await recordCatchupFailure(ctx, tenancyId, { periodMonth: ym, error: `P2002 on ${target}`, drafted: false });
          }
          continue;
        }
        console.error(`[draft-catchup] tenancy ${tenancyId} period ${ym} failed (swallowed):`, err);
        await recordCatchupFailure(ctx, tenancyId, { periodMonth: ym, error: (err as Error).message });
      }
    }
    return drafted;
  }
}

/**
 * Unit-keyed variant for the inventory flows (edit-unit / create-unit /
 * batch-create), which materialise the tenancy inside syncOccupancyTenancy and
 * never see its id: resolve the unit's active tenancies post-commit, then catch
 * each up. Never throws.
 *
 * Catches up EVERY active tenancy on the unit, in a deterministic order, rather
 * than one arbitrary row. `assertNoActiveTenancyTx` makes two concurrently-active
 * tenancies rare, not impossible, and the run itself bills every tenancy that
 * overlaps the period ("possibly MORE THAN ONE for a unit when a handover
 * happened mid-month" — auto-draft.repository.ts). A `findFirst` with no
 * `orderBy` let Postgres physical order decide which one got billed and left the
 * other silently unbilled; each is idempotent, so doing all of them is strictly
 * safer than picking.
 *
 * ⚠️ The correction pass runs even when the unit has NO active tenancy. Marking
 * a unit vacant is how an admin records a move-out from Inventory, and
 * syncOccupancyTenancy's not-occupied branch sets the tenancy `ended` with
 * today's endDate — which is exactly the edit that invalidates that month's
 * draft. Keying the whole hook off the active-tenancy list meant the one path
 * that CREATES the staleness was also the one path that never corrected it.
 */
export async function draftCatchupForUnit(
  ctx: DraftCatchupCtx,
  unitId: string,
  now: Date = new Date(),
): Promise<{ drafted: string[] }> {
  if (!isPhase2FlagEnabled("ENABLE_PHASE2_AUTODRAFT")) return { drafted: [] };
  try {
    const active = await getDb().tenancy.findMany({
      where: { organizationId: ctx.orgId, unitId, status: "active" },
      select: { id: true },
      orderBy: [{ startDate: "desc" }, { id: "asc" }],
    });
    const drafted: string[] = [];
    for (const t of active) {
      const res = await draftCatchupForTenancy(ctx, t.id, now);
      drafted.push(...res.drafted);
    }
    // No active tenancy ⇒ nothing to draft, but the unit's EXISTING drafts still
    // need levelling (the vacate case above). draftCatchupForTenancy already ran
    // this per tenancy; it is idempotent, and skipping it here would reintroduce
    // the gap for the empty list.
    if (active.length === 0) {
      await reprorateForUnitSafely(ctx, unitId, now);
    }
    return { drafted };
  } catch (e) {
    console.error("[draft-catchup] unit lookup failed (swallowed):", e);
    return { drafted: [] };
  }
}
