/**
 * Re-prorate UNAPPROVED rent drafts against current tenancy facts.
 *
 * ── The defect this exists to close ──────────────────────────────────────────
 * A rent draft is priced once, from the tenancy dates as they stood at drafting
 * time, and nothing revised it afterwards. That is fine until the unit changes
 * hands mid-month:
 *
 *   1 Aug   run drafts Tenant X a FULL August: RM1200 (X has no end date yet)
 *  15 Aug   X moves out — endDate set. X's draft still says RM1200.
 *  16 Aug   Y is assigned, and is correctly drafted 16/31 days: RM640.
 *           ── unit-month total RM1840 on a RM1200 unit ──
 *
 * Both halves are individually "correct"; the pair is not.
 *
 * ── Why rewriting a draft is safe here, when it is not in general ────────────
 * The "never rewrite an existing draft" stance protects LIVE money. This module
 * is scoped so it can only touch money that is not yet live:
 *   • the Invoice must be `draft` — approved/sent/paid is never touched;
 *   • the Charge must be `draft` — a posted charge is a real receivable, and a
 *     draft charge is by construction unpayable (drafts are excluded from the
 *     tenant's payable set — @kason/shared billing/tenant-visibility), so no
 *     allocation can exist against it;
 *   • only the rent line moves, matched by its DETERMINISTIC chargeNumber
 *     (`RENT-{YYYYMM}-{tenancyId}`) — the drafter's own key. Matching by
 *     chargeType instead would be an unordered pick between two `rent` rows
 *     whenever an editor has attached an extra one through attachChargeService,
 *     letting Postgres physical order decide which amount gets overwritten.
 * Anything failing those gates is REPORTED as `lockedStale`, never rewritten —
 * a live over-bill is a human's call (credit note), not this hook's.
 *
 * ── Why the reads are batched, and what that costs ───────────────────────────
 * The per-invoice shape (`resolveMonthlyRentAmount` inside its own transaction)
 * added 2 queries per unit plus a full transaction per draft invoice to EVERY
 * auto-draft run — for a few-hundred-unit org, hundreds of transactions whose
 * only finding is "nothing changed", bolted onto a synchronous
 * POST /billing/draft-runs that already loops per tenancy.
 *
 * So the amount is now computed from BATCHED reads through the SAME pure
 * functions the resolver uses — `pickBaseRent` (precedence) and
 * `computeProratedRent` (proration) from lib/rent-math, which are the single
 * source of truth for the math. Only the FETCH is duplicated, and the selects
 * below mirror `resolveMonthlyRentAmount`'s one-for-one; a test pins the two to
 * identical answers. A transaction is opened ONLY for a draft that actually
 * needs correcting, which is safe because the write is a guarded `updateMany`
 * (`status: "draft"`) that no-ops if the charge went live in between.
 */
import { getDb, Prisma } from "@kason/db";
import { ymOfUtc } from "@kason/shared";
import { recordAudit } from "../../lib/audit";
import { computeProratedRent, pickBaseRent } from "../../lib/rent-math";
import { isBillableStatus } from "../../lib/tenancy-period";
import type { AutoDraftActorCtx } from "./auto-draft.types";
import { firstOfMonthUtc, rentChargeNumber, recomputeInvoiceTotalTx } from "./auto-draft.repository";

/**
 * How far back a unit-scoped sweep looks for correctable drafts.
 *
 * NOT the same rule as drafting. CREATING a draft for a past month is forbidden
 * (it can land in a frozen owner-statement period), but CORRECTING an existing
 * unapproved one is the opposite act: it only ever reduces an over-bill on money
 * that is not live, and a draft charge is absent from the owner ledger entirely
 * (only POSTED charges sync), so it cannot disturb a frozen statement. Without a
 * past-month reach, a move-out recorded after the calendar rolled over left the
 * stale draft permanently uncorrectable — the original defect, one month later.
 */
export const REPRORATE_LOOKBACK_MONTHS = 6;

/** One draft whose rent line was corrected. Amounts are 2dp strings, as stored. */
export type ReproratedRentDraft = {
  invoiceId: string;
  tenancyId: string;
  chargeId: string;
  periodMonth: string;
  previousAmount: string;
  nextAmount: string;
};

/**
 * One draft whose rent is stale but could NOT be corrected here: the invoice or
 * its rent charge is already live, so putting it right means a credit note —
 * an explicit human action, not a silent edit.
 */
export type LockedStaleRentDraft = {
  invoiceId: string;
  tenancyId: string;
  periodMonth: string;
  invoiceStatus: string;
  chargeStatus: string;
  currentAmount: string;
  correctAmount: string;
};

export type ReprorateOutcome = {
  adjusted: ReproratedRentDraft[];
  lockedStale: LockedStaleRentDraft[];
};

const EMPTY: ReprorateOutcome = { adjusted: [], lockedStale: [] };

/** Cent-exact equality — Decimal strings must not be compared as floats. */
function sameMoney(a: string, b: string): boolean {
  return Math.round(Number(a) * 100) === Math.round(Number(b) * 100);
}

function toNum(v: { toString(): string } | null | undefined): number | null {
  return v == null ? null : Number(v.toString());
}

/**
 * Every unapproved rent draft this sweep can see, with everything needed to
 * price it — in a fixed number of queries regardless of how many there are.
 */
type Candidate = {
  invoiceId: string;
  invoiceStatus: string;
  tenancyId: string;
  periodMonth: string;
  firstOfMonth: Date;
  chargeId: string;
  chargeStatus: string;
  currentAmount: string;
  correctAmount: string;
};

async function loadCandidates(
  orgId: string,
  where: Prisma.InvoiceWhereInput,
): Promise<Candidate[]> {
  const db = getDb();
  const invoices = await db.invoice.findMany({
    where: {
      organizationId: orgId,
      invoiceType: "tenant_rental",
      // `approved` is loaded even though it can never be CORRECTED here, so the
      // stale amount is still detected and reported. Scoping the sweep to
      // `draft` alone would make an over-bill that slipped past approval
      // invisible to every surface — the loudest case, silently dropped.
      status: { in: ["draft", "approved"] },
      tenancyId: { not: null },
      ...where,
    },
    select: { id: true, status: true, tenancyId: true, periodMonth: true },
  });
  if (invoices.length === 0) return [];

  const tenancyIds = [...new Set(invoices.flatMap((i) => (i.tenancyId ? [i.tenancyId] : [])))];

  // Mirrors resolveMonthlyRentAmount's reads, batched. `status` rides along so a
  // tenancy demoted to a non-billable state (`draft` — a not-yet-real agreement)
  // prices to 0 rather than keeping the month it should never have been billed.
  const [tenancies, overrides, charges] = await Promise.all([
    db.tenancy.findMany({
      where: { id: { in: tenancyIds }, organizationId: orgId },
      select: {
        id: true, status: true, startDate: true, endDate: true, monthlyRentAmount: true,
        reservation: { select: { agreedMonthlyRent: true } },
      },
    }),
    db.recurringCharge.findMany({
      where: { organizationId: orgId, tenancyId: { in: tenancyIds }, chargeType: "rent", isActive: true },
      select: { tenancyId: true, amount: true },
    }),
    db.charge.findMany({
      where: {
        organizationId: orgId,
        invoiceId: { in: invoices.map((i) => i.id) },
        status: { not: "void" },
      },
      select: { id: true, invoiceId: true, chargeNumber: true, amount: true, status: true },
    }),
  ]);

  const tenancyById = new Map(tenancies.map((t) => [t.id, t]));
  const overrideByTenancy = new Map(overrides.flatMap((o) => (o.tenancyId ? [[o.tenancyId, o] as const] : [])));
  const chargeByNumber = new Map(charges.map((c) => [c.chargeNumber, c]));
  // A manager-approved manual amount is a period-specific exception. Later
  // tenancy date edits must not silently overwrite that explicit decision.
  const manualEvents = charges.length === 0 ? [] : await db.chargeEvent.findMany({
    where: {
      organizationId: orgId,
      chargeId: { in: charges.map((c) => c.id) },
      eventType: "draft.amount_manually_edited",
    },
    select: { chargeId: true },
  });
  const manuallyEditedChargeIds = new Set(manualEvents.map((event) => event.chargeId));

  const out: Candidate[] = [];
  for (const inv of invoices) {
    if (!inv.tenancyId || !inv.periodMonth) continue;
    const t = tenancyById.get(inv.tenancyId);
    if (!t) continue;
    const periodMonth = ymOfUtc(inv.periodMonth);
    const firstOfMonth = firstOfMonthUtc(periodMonth);

    // Matched by the drafter's own deterministic key, never by chargeType — see
    // the header note on attachChargeService and unordered picks.
    const charge = chargeByNumber.get(rentChargeNumber(periodMonth, inv.tenancyId));
    if (!charge || charge.invoiceId !== inv.id) continue;

    const correctAmount = manuallyEditedChargeIds.has(charge.id)
      ? charge.amount.toString()
      : !isBillableStatus(t.status)
      ? "0.00"
      : computeProratedRent(
          pickBaseRent(
            toNum(overrideByTenancy.get(t.id)?.amount),
            toNum(t.reservation?.agreedMonthlyRent),
            Number(t.monthlyRentAmount),
          ),
          t.startDate,
          t.endDate,
          firstOfMonth,
        ).toFixed(2);

    out.push({
      invoiceId: inv.id, invoiceStatus: inv.status, tenancyId: inv.tenancyId,
      periodMonth, firstOfMonth, chargeId: charge.id, chargeStatus: charge.status,
      currentAmount: charge.amount.toString(), correctAmount,
    });
  }
  return out;
}

/**
 * Correct the candidates whose stored amount disagrees with the recomputed one.
 * Opens a transaction ONLY for those; an unchanged draft costs nothing.
 */
async function correctDrafts(ctx: AutoDraftActorCtx, candidates: Candidate[]): Promise<ReprorateOutcome> {
  const db = getDb();
  const adjusted: ReproratedRentDraft[] = [];
  const lockedStale: LockedStaleRentDraft[] = [];

  for (const c of candidates) {
    if (sameMoney(c.currentAmount, c.correctAmount)) continue;

    // Live money is reported, never rewritten. BOTH gates are load-bearing and
    // neither implies the other: approval only posts charges when
    // ENABLE_PHASE2_BILLING_DOCS is on, so an APPROVED invoice can still carry
    // `draft` charges — and silently re-pricing one would change the total of a
    // document an admin has already signed off.
    if (c.invoiceStatus !== "draft" || c.chargeStatus !== "draft") {
      lockedStale.push({
        invoiceId: c.invoiceId, tenancyId: c.tenancyId, periodMonth: c.periodMonth,
        invoiceStatus: c.invoiceStatus, chargeStatus: c.chargeStatus,
        currentAmount: c.currentAmount, correctAmount: c.correctAmount,
      });
      continue;
    }

    try {
      // One transaction PER correction: a failing draft must not roll back a
      // correction already made to another tenant's, and one unreadable row must
      // not leave the rest of the unit-month uncorrected — which would preserve
      // exactly the over-draft this closes.
      const observed = await db.$transaction(async (tx) => {
        // Guarded WHERE so a charge posted between the batched read and this
        // write is a 0-row no-op rather than a rewritten live receivable.
        const written = await tx.charge.updateMany({
          where: { id: c.chargeId, organizationId: ctx.orgId, status: "draft" },
          data: { amount: c.correctAmount, outstandingAmount: c.correctAmount },
        });
        if (written.count === 0) {
          // Re-read rather than assume. This row is what a human consults to
          // answer "why is this unit billed twice", so it must state the status
          // actually observed — the charge may have been posted, voided, or
          // deleted in the window, and asserting "posted" for all three puts a
          // fact in the audit trail that was never read.
          const now = await tx.charge.findFirst({
            where: { id: c.chargeId, organizationId: ctx.orgId },
            select: { status: true },
          });
          return { written: false as const, chargeStatus: now?.status ?? "deleted" };
        }

        await tx.chargeEvent.create({
          data: {
            organizationId: ctx.orgId, chargeId: c.chargeId, eventType: "draft.reprorated",
            eventAt: new Date(), actorUserId: ctx.actorUserId,
            payloadJson: {
              invoiceId: c.invoiceId, periodMonth: c.periodMonth,
              previousAmount: c.currentAmount, nextAmount: c.correctAmount,
              source: "reprorate-rent-drafts",
            },
          },
        });
        await recomputeInvoiceTotalTx(tx, ctx.orgId, c.invoiceId);
        await recordAudit(tx, {
          organizationId: ctx.orgId, actorUserId: ctx.actorUserId, actorRole: ctx.actorRole,
          action: "billing.invoice.draft_reprorated", entityType: "Invoice", entityId: c.invoiceId,
          meta: {
            tenancyId: c.tenancyId, periodMonth: c.periodMonth,
            previousAmount: c.currentAmount, nextAmount: c.correctAmount,
          },
          ip: ctx.ip, userAgent: ctx.userAgent,
        });
        return { written: true as const, chargeStatus: "draft" };
      });

      if (observed.written) {
        adjusted.push({
          invoiceId: c.invoiceId, tenancyId: c.tenancyId, chargeId: c.chargeId,
          periodMonth: c.periodMonth, previousAmount: c.currentAmount, nextAmount: c.correctAmount,
        });
      } else {
        lockedStale.push({
          invoiceId: c.invoiceId, tenancyId: c.tenancyId, periodMonth: c.periodMonth,
          invoiceStatus: c.invoiceStatus, chargeStatus: observed.chargeStatus,
          currentAmount: c.currentAmount, correctAmount: c.correctAmount,
        });
      }
    } catch (err) {
      console.error(`[reprorate] invoice ${c.invoiceId} failed, continuing:`, err);
    }
  }

  // A stale draft that could NOT be corrected is the case a human must see, so
  // it gets its own durable audit row rather than only a console line.
  if (lockedStale.length > 0) {
    try {
      await db.$transaction((tx) =>
        recordAudit(tx, {
          organizationId: ctx.orgId, actorUserId: ctx.actorUserId, actorRole: ctx.actorRole,
          action: "billing.invoice.stale_rent_uncorrectable", entityType: "Invoice",
          entityId: lockedStale[0].invoiceId,
          meta: { rows: lockedStale as unknown as Prisma.InputJsonValue },
        }),
      );
    } catch (auditErr) {
      console.error("[reprorate] failed to record locked-stale audit (swallowed):", auditErr);
    }
  }

  return { adjusted, lockedStale };
}

/**
 * Correct every unapproved rent draft on ONE unit, across the recent window.
 *
 * Unit-scoped because that is the blast radius of a handover, and window-scoped
 * (not single-period) because the event that invalidates a draft — a move-out
 * being recorded — routinely happens in a LATER month than the draft it
 * invalidates. Never throws for a missing unit; returns an empty outcome.
 */
export async function reprorateRentDraftsForUnit(
  ctx: AutoDraftActorCtx,
  unitId: string,
  now: Date = new Date(),
): Promise<ReprorateOutcome> {
  const tenancies = await getDb().tenancy.findMany({
    // EVERY tenancy that has held this unit, not just the active one: the stale
    // draft belongs to the tenant who just moved OUT, whose status is now
    // `ended`, so filtering on status here would skip exactly the row we came for.
    where: { organizationId: ctx.orgId, unitId },
    select: { id: true },
  });
  if (tenancies.length === 0) return EMPTY;

  const floor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - REPRORATE_LOOKBACK_MONTHS, 1));
  const candidates = await loadCandidates(ctx.orgId, {
    tenancyId: { in: tenancies.map((t) => t.id) },
    periodMonth: { gte: floor },
  });
  return correctDrafts(ctx, candidates);
}

/**
 * Correct every unapproved rent draft in the org for ONE period — the auto-draft
 * run's sweep.
 *
 * Scoped by PERIOD rather than by the units the run happened to bill: the run
 * selects tenancies by period OVERLAP, so a tenancy whose endDate has since
 * moved before the period start is excluded from its own correction, and its
 * unit only enters a unit-derived sweep if some other tenancy on it overlaps.
 * Asking "which drafts exist for this month" instead has no such blind spot,
 * and costs a fixed handful of queries rather than two per unit.
 */
export async function reprorateRentDraftsForPeriod(
  ctx: AutoDraftActorCtx,
  periodMonth: string,
): Promise<ReprorateOutcome> {
  const candidates = await loadCandidates(ctx.orgId, { periodMonth: firstOfMonthUtc(periodMonth) });
  return correctDrafts(ctx, candidates);
}
