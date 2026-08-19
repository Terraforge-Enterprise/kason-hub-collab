/**
 * Portal owner LIVE transactions + FROZEN statements (Task 8) — OWN-DATA-ONLY.
 *
 * Two owner-portal read surfaces for the owner-statement live-ledger feature:
 *   GET /transactions            — the LIVE running transaction history (settled
 *                                  cash rows + running balance); the CURRENT open
 *                                  month is INCLUDED. Not a document.
 *   GET /statements              — the FROZEN statement documents ONLY; the current
 *                                  open month is NEVER listed. Fires lazy
 *                                  freeze-on-read for any PAST month with activity
 *                                  but no frozen row (spec R5).
 *   GET /statements/:id          — the frozen snapshot (snapshotJson); a non-frozen
 *                                  period id → 409 STATEMENT_NOT_ISSUED.
 *   GET /statements/:id/pdf      — a signed download URL for the frozen period's
 *                                  pdfKey; non-frozen / no pdf → 409.
 *   GET /reconciliation          — Phase-3 (rent-reclassification) READ-ONLY R15
 *                                  owner-payable waterfall for one month (opening/
 *                                  collections/offsets/pass-through-expenses/gross-
 *                                  remittances/reversals/closing + balanced/
 *                                  discrepancyC + R18 frozen/live payable snapshot).
 *                                  Pure aggregation, no mutation.
 *                                  CONTRACT NOTE — scopeIncompleteForSettlements:
 *                                  the settlement split (remittances/offsets/
 *                                  reversals) is always OWNER-WIDE, so a per-unit
 *                                  (apartmentId) request can carry settlement money
 *                                  the unit-scoped closing cannot see. When this
 *                                  flag is TRUE, `balanced`/`discrepancyC` are NOT
 *                                  authoritative — the client MUST NOT raise an
 *                                  "unbalanced ledger" / integrity warning from
 *                                  them (show the component values for visibility,
 *                                  but indicate the settlement scope is incomplete).
 *                                  When FALSE, `balanced:false` is a REAL gap.
 *                                  `balanced`/`discrepancyC` are never fudged — the
 *                                  flag only qualifies their authority.
 *
 * SECURITY (owner-privacy / money boundary):
 *   - portalUserTypeGuard("owner") (applied in portal/index.ts) restricts the
 *     surface to owner sessions; agents/tenants get 403.
 *   - FLAG GATE: 404 while ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER is dark (no
 *     shape leak) — mirrors the sibling ownerLedgerFlagGate precedent, but gated on
 *     THIS feature's own flag so availability is never coupled to another module.
 *   - OWN-DATA-ONLY: EVERY query filters organizationId === session.orgId AND
 *     ownerPartyId === session.partyId. The :id handlers load the period scoped to
 *     (org, owner); a period belonging to a different owner/org — or that does not
 *     exist — yields the IDENTICAL { error: "not_found" } 404 (no 403-vs-404
 *     existence leak, never another owner's payload). This IS the ownership assert.
 *   - CASH-BASIS: transaction rows are active + paid only. Unpaid/accrual/void rows
 *     are NEVER exposed (even though unpaid-active rows DO move the accrual balance).
 *   - Read-only: no mutation endpoints. The lazy freeze-on-read PERSISTS a frozen
 *     snapshot but never mutates ledger data.
 *
 * MOUNT NOTE: this router is mounted at the DISTINCT prefix /owner-live (NOT /owner).
 * The existing portalOwnerStatementsRoutes at /owner carries a `use("*")`
 * ownerLedgerFlagGate keyed on ENABLE_PHASE2_OWNER_BILLING; Hono applies that
 * wildcard middleware to EVERY route sharing the /owner prefix, so mounting here at
 * /owner would 404 these endpoints whenever owner-billing is dark — regardless of
 * this feature's own flag. A distinct sibling prefix keeps the gate self-contained.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { getDb, type OwnerStatementPeriod } from "@kason/db";
import type { PortalEnv, PortalSessionPayload } from "../auth/portal.auth.types";
import { isPhase2FlagEnabled } from "../../../lib/feature-flags";
import { resolveOwnerBalance } from "../../owner-ledger/owner-ledger.repository";
import { listFrozenPeriodsForOwner } from "../../owner-billing/owner-statement-period.repository";
import { freezeStatementPeriod } from "../../owner-billing/owner-statement-period.service";
import { getOwnerPayableReconciliationService } from "../../owner-remittance/owner-payable-reconciliation.service";
import { createSignedDownloadUrl } from "../../../lib/storage";
import type { OwnerBillingActorCtx } from "../../owner-billing/owner-billing.types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A "YYYY-MM" month key — the only accepted shape for the from/to bounds. */
const YEAR_MONTH_RE = /^\d{4}-\d{2}$/;
/**
 * A "YYYY-MM" month key with a REAL month component (01-12). Stricter than
 * YEAR_MONTH_RE, which accepts an impossible "2026-13"/"2026-00" that
 * firstOfMonth() would then silently roll into an adjacent month — showing the
 * owner a DIFFERENT month's figures under the label they requested. Scoped to the
 * /reconciliation handler (which takes a single authoritative `month`); the
 * from/to bounds on /transactions keep the looser regex (their out-of-range value
 * degrades to an unfiltered bound, not a mislabeled result).
 */
const STRICT_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

const portalOwnerStatementsV2Routes = new Hono<PortalEnv>();

// Flag gate: every route 404s while ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER is
// dark (no shape leak) — mirrors the sibling ownerLedgerFlagGate precedent.
portalOwnerStatementsV2Routes.use("*", async (c, next) => {
  if (!isPhase2FlagEnabled("ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER")) {
    return c.json({ error: "not_found" }, 404);
  }
  await next();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/** "YYYY-MM" from a @db.Date first-of-month UTC value. */
function monthKey(d: Date): string {
  return d.toISOString().slice(0, 7);
}

/** First-of-month UTC for the CURRENT wall-clock month (the freeze cutoff). */
function currentMonthFirstUtc(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** "YYYY-MM" → first-of-month UTC Date (matches the @db.Date grouping keys). */
function firstOfMonth(ym: string): Date {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, 1));
}

/** "YYYY-MM" → last-of-month UTC Date (inclusive upper bound for a @db.Date lte). */
function lastOfMonth(ym: string): Date {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y!, m!, 0));
}

/**
 * Build the owner-billing ctx from the SESSION (never client input). The freeze
 * service uses only ctx.orgId + ctx.actorUserId; actorRole is a least-privilege
 * placeholder (a portal owner is never an admin) — mirrors the sibling
 * portalOwnerStatementsRoutes precedent.
 */
function portalCtx(session: PortalSessionPayload): OwnerBillingActorCtx {
  return { orgId: session.orgId, actorUserId: session.userId, actorRole: "editor" };
}

/** Read DTO for a frozen period (list + detail). */
function toPeriodDto(p: OwnerStatementPeriod) {
  return {
    id: p.id,
    month: monthKey(p.periodMonth),
    apartmentId: p.apartmentId,
    issuedAt: p.issuedAt ? p.issuedAt.toISOString() : null,
    openingBalanceC: p.openingBalanceC,
    closingBalanceC: p.closingBalanceC,
    netPayoutC: p.netPayoutC,
    pdfKey: p.pdfKey,
  };
}

/**
 * Shared OWN-DATA-ONLY ownership load for BOTH /statements/:id surfaces — the
 * single money/auth boundary for the frozen-period id handlers. Reproduces the
 * behavior both handlers previously had inline, BYTE-FOR-BYTE:
 *   1. UUID-format pre-check on :id — a non-UUID id → identical 404 BEFORE any
 *      query (no existence leak, and no Postgres uuid-parse 500).
 *   2. findFirst scoped to (org AND owner) — NEVER by id alone.
 *   3. null (cross-owner / cross-org / unknown) → identical 404 {error:"not_found"}
 *      (never 403, never a payload).
 * Returns the loaded period on success, or a ready-to-return 404 Response. ONE
 * source so the two handlers can never silently diverge (e.g. a soft-delete
 * filter added to one but not the other).
 */
async function loadOwnedPeriodOr404(
  c: Context<PortalEnv>,
  session: PortalSessionPayload,
): Promise<OwnerStatementPeriod | Response> {
  const id = c.req.param("id");
  // Non-UUID id → identical 404 (no existence leak, and no Postgres uuid-parse 500).
  if (!UUID_RE.test(id)) return c.json({ error: "not_found" }, 404);

  // OWN-DATA-ONLY ownership assert: load scoped to (org, owner). A cross-owner /
  // cross-org / unknown id all resolve to null → identical 404 (no 403, no leak).
  const period = await getDb().ownerStatementPeriod.findFirst({
    where: { id, organizationId: session.orgId, ownerPartyId: session.partyId },
  });
  if (!period) return c.json({ error: "not_found" }, 404);
  return period;
}

// ── GET /transactions — LIVE running history (cash-basis, current month incl.) ─

portalOwnerStatementsV2Routes.get("/transactions", async (c) => {
  const s = c.get("session");
  const scope = c.req.query("scope") === "unit" ? "unit" : "combined";
  // Per-unit scope narrows to a single apartment; combined is owner-wide (null).
  const apartmentId = scope === "unit" ? c.req.query("apartmentId") || null : null;
  // Graceful-degrade the month bounds: an absent OR malformed from/to is treated
  // as NO filter for that bound (all-time), never an Invalid-Date 500 — same
  // philosophy as year's regex-guard in listFrozenPeriodsForOwner. Own-data
  // scoping is independent of these, so a bad bound never widens the owner scope.
  const fromRaw = c.req.query("from");
  const toRaw = c.req.query("to");
  const from = fromRaw && YEAR_MONTH_RE.test(fromRaw) ? fromRaw : undefined;
  const to = toRaw && YEAR_MONTH_RE.test(toRaw) ? toRaw : undefined;

  // OWN-DATA-ONLY + CASH-BASIS: active + paid only, scoped to (org, owner). No
  // upper cutoff unless the caller bounds it via `to`, so the CURRENT open month
  // is included by default.
  const statementMonth: { gte?: Date; lte?: Date } = {};
  if (from) statementMonth.gte = firstOfMonth(from);
  if (to) statementMonth.lte = lastOfMonth(to);

  const rows = await getDb().ownerLedgerEntry.findMany({
    where: {
      organizationId: s.orgId,
      ownerPartyId: s.partyId,
      status: "active",
      paymentStatus: "paid",
      ...(apartmentId ? { apartmentId } : {}),
      ...(Object.keys(statementMonth).length > 0 ? { statementMonth } : {}),
    },
    orderBy: [{ statementMonth: "asc" }, { transactionDate: "asc" }],
  });

  // Running-balance figures (accrual-aware, deposit-aware, sign-aware) for the same
  // owner + scope + window. resolveOwnerBalance already filters org + owner.
  const balance = await resolveOwnerBalance(s.orgId, s.partyId, from, to, apartmentId);

  return c.json({
    data: {
      scope,
      apartmentId,
      balance,
      rows: rows.map((r) => ({
        id: r.id,
        statementMonth: monthKey(r.statementMonth),
        transactionDate: r.transactionDate.toISOString(),
        direction: r.direction,
        category: r.category,
        description: r.description,
        amount: r.amount.toFixed(2), // Prisma.Decimal → 2dp string (never leak Decimal)
        paymentStatus: r.paymentStatus,
        apartmentId: r.apartmentId,
      })),
    },
  });
});

// ── GET /reconciliation — R15 owner-payable waterfall for one month (Phase-3) ──

portalOwnerStatementsV2Routes.get("/reconciliation", async (c) => {
  const s = c.get("session");

  // `month` is the primary required parameter (which period to reconcile) — unlike
  // /transactions' optional from/to bounds, there is no sensible default here, so a
  // missing/malformed value is a 400, not a graceful-degrade-to-unfiltered.
  const month = c.req.query("month");
  if (!month || !STRICT_MONTH_RE.test(month)) {
    return c.json({ error: "month query parameter is required (YYYY-MM)" }, 400);
  }

  // apartmentId is optional (combined-scope when absent). Format-checked BEFORE
  // it ever reaches a @db.Uuid Prisma filter — a malformed value would otherwise
  // raw-throw a Postgres "invalid input syntax for type uuid" 500.
  const apartmentIdRaw = c.req.query("apartmentId");
  if (apartmentIdRaw && !UUID_RE.test(apartmentIdRaw)) {
    return c.json({ error: "INVALID_APARTMENT_ID" }, 400);
  }
  const apartmentId = apartmentIdRaw || null;

  // OWN-DATA-ONLY: ownerPartyId is ALWAYS s.partyId (the session) — never a query
  // param. getOwnerPayableReconciliationService itself org+owner(+apartment)-scopes
  // every query, so a foreign/unknown apartmentId simply matches no rows (never a
  // cross-owner leak) rather than needing an explicit ownership pre-check.
  const data = await getOwnerPayableReconciliationService(s.orgId, s.partyId, month, apartmentId);
  return c.json({ data });
});

// ── GET /statements — FROZEN documents only (lazy freeze-on-read for past months) ─

portalOwnerStatementsV2Routes.get("/statements", async (c) => {
  const s = c.get("session");
  const scope = c.req.query("scope") === "unit" ? "unit" : "combined";
  const apartmentId = scope === "unit" ? c.req.query("apartmentId") || null : null;
  const year = c.req.query("year") || undefined;

  // ── Lazy freeze-on-read (spec R5) ──────────────────────────────────────────
  // For any PAST month (< current) with owner activity but no frozen period row,
  // freeze it inline and PERSIST. NEVER the current/future month —
  // freezeStatementPeriod THROWS for those (it is live transaction history). Each
  // month's freeze is isolated in try/catch so one failure can't fail the request.
  const currentFirst = currentMonthFirstUtc();

  // Distinct PAST months (< current) with owner activity in this scope.
  const activityMonths = await getDb().ownerLedgerEntry.findMany({
    where: {
      organizationId: s.orgId,
      ownerPartyId: s.partyId,
      status: "active",
      ...(apartmentId ? { apartmentId } : {}),
      statementMonth: { lt: currentFirst },
    },
    select: { statementMonth: true },
    distinct: ["statementMonth"],
    orderBy: { statementMonth: "asc" },
  });

  // Months already frozen for this scope — skip (never re-freeze on read).
  const alreadyFrozen = await listFrozenPeriodsForOwner(s.orgId, s.partyId, apartmentId);
  const frozenMonths = new Set(alreadyFrozen.map((p) => monthKey(p.periodMonth)));

  for (const row of activityMonths) {
    const billingMonth = monthKey(row.statementMonth);
    if (frozenMonths.has(billingMonth)) continue;
    try {
      // Restore the "per-unit frozen ⇒ combined frozen" invariant: when a PER-UNIT read
      // (apartmentId set) would lazily freeze a per-unit past-month period, freeze the
      // COMBINED sibling (apartmentId null) for the same owner-month FIRST. Both are the
      // SAME closed past month (freezeStatementPeriod throws for the current/future month),
      // so freezing the combined here is correct, never premature. Placed inside the SAME
      // try so a failed combined freeze skips the per-unit freeze below — never orphaning a
      // per-unit frozen period without its combined sibling (which the combined-scope guard
      // + R5/R6 reconciliation cannot see). freezeStatementPeriod is idempotent, so a
      // combined month already frozen (e.g. by a prior combined read) is a monotonic no-op.
      if (apartmentId) {
        await freezeStatementPeriod(portalCtx(s), {
          ownerPartyId: s.partyId,
          apartmentId: null,
          billingMonth,
        });
      }
      await freezeStatementPeriod(portalCtx(s), {
        ownerPartyId: s.partyId,
        apartmentId,
        billingMonth,
      });
    } catch (e) {
      // A freeze failure for ONE month must not fail the whole read — log + skip.
      // eslint-disable-next-line no-console
      console.error(`[owner-live/statements] lazy freeze skipped ${billingMonth}:`, (e as Error).message);
    }
  }

  // Serve FROZEN rows only (optionally year-filtered). The current open month is
  // never here — it lives under /transactions.
  const periods = await listFrozenPeriodsForOwner(s.orgId, s.partyId, apartmentId, year);
  return c.json({ data: { items: periods.map(toPeriodDto) } });
});

// ── GET /statements/:id — frozen snapshot; non-frozen → 409 ───────────────────

portalOwnerStatementsV2Routes.get("/statements/:id", async (c) => {
  const s = c.get("session");
  // Shared OWN-DATA-ONLY ownership assert (UUID pre-check + org/owner-scoped load).
  const owned = await loadOwnedPeriodOr404(c, s);
  if (owned instanceof Response) return owned;
  const period = owned;

  // Only a FROZEN period is an issued statement; an open/non-frozen row → 409.
  if (period.status !== "frozen") {
    return c.json({ error: "STATEMENT_NOT_ISSUED" }, 409);
  }

  return c.json({
    data: {
      ...toPeriodDto(period),
      status: period.status,
      snapshot: period.snapshotJson ?? [],
    },
  });
});

// ── GET /statements/:id/pdf — signed URL for the frozen period's pdfKey ───────

portalOwnerStatementsV2Routes.get("/statements/:id/pdf", async (c) => {
  const s = c.get("session");
  // Same shared OWN-DATA-ONLY ownership assert as /statements/:id — the signed URL
  // is only ever minted AFTER this load succeeds (never for a cross-owner id).
  const owned = await loadOwnedPeriodOr404(c, s);
  if (owned instanceof Response) return owned;
  const period = owned;

  // A signed PDF exists only for a FROZEN period with a rendered pdfKey.
  if (period.status !== "frozen" || !period.pdfKey) {
    return c.json({ error: "STATEMENT_NOT_ISSUED" }, 409);
  }

  const url = await createSignedDownloadUrl(period.pdfKey, {
    filename: `owner-statement-${monthKey(period.periodMonth)}.pdf`,
  });
  return c.json({ data: { url } });
});

export { portalOwnerStatementsV2Routes };
