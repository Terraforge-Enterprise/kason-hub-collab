import { getDb, type OwnerStatementPeriod, type Prisma } from "@kason/db";
import { resolveOwnerBalance, signedToCents } from "../owner-ledger/owner-ledger.repository";
import { upsertFrozenPeriod } from "./owner-statement-period.repository";
import {
  buildOwnerStatementInvoiceKey,
  findInvoiceByIdempotencyKey,
} from "./owner-billing.repository";
import { renderCleanStatementPdfBytes } from "./owner-billing.service";
import { putObject } from "../../lib/storage";
import type { OwnerBillingActorCtx } from "./owner-billing.types";

/**
 * Freeze eligibility-ruleset version stamped into the write-once manifest header
 * (OwnerStatementPeriod.freezeRulesetVersion) at first freeze. Bump when the set of
 * rows the manifest captures (currently: every ACTIVE row, any paymentStatus) or the
 * recorded-balance rules change, so a later reconciliation (R6) interprets an older
 * manifest under the rules in force when it was minted.
 */
const FREEZE_RULESET_VERSION = 1;

/**
 * owner-statement-period.service — computes and persists an owner statement
 * period's IMMUTABLE frozen snapshot (Task 4 of the live-ledger feature).
 * Consumed by the PDF (Task 5), the freeze cron (Task 6), and the portal reads
 * (Task 8). This module only READS the ledger and WRITES the period row; it
 * never mutates ledger data, so a wrong snapshot is corrected by a later
 * recompute carrying a newer sourceMaxUpdatedAt (see upsertFrozenPeriod).
 */

/**
 * Parse "YYYY-MM" to the first-of-month UTC Date the @db.Date grouping keys use
 * (OwnerLedgerEntry.statementMonth / OwnerStatementPeriod.periodMonth).
 */
function firstOfMonth(billingMonth: string): Date {
  const [year, month] = billingMonth.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, 1));
}

/** The calendar month BEFORE billingMonth, as "YYYY-MM" (UTC, year-rollover safe). */
function prevMonth(billingMonth: string): string {
  const [year, month] = billingMonth.split("-").map(Number);
  const d = new Date(Date.UTC(year!, month! - 2, 1)); // month is 1-based → −2 = prev month index
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * The ONE deterministic idempotency-key builder for a frozen owner-statement
 * period — LOAD-BEARING. For a combined-scope row (apartmentId = NULL) the
 * composite unique (org, owner, apartmentId, periodMonth) is NULLs-DISTINCT in
 * Postgres, so the (org, idempotencyKey) unique is the SOLE guard against a
 * duplicate combined statement for one owner-month. A key VARIANT for the same
 * owner-month would therefore mint a second combined statement → double payout.
 * There is exactly one key shape per scope; never a variant / alternate prefix.
 *
 *   combined (apartmentId null): ownerstmt:<owner>:<YYYY-MM>
 *   per-unit (apartmentId set):  ownerstmt:<owner>:<YYYY-MM>:<apartmentId>
 */
export function buildStatementPeriodKey(
  ownerPartyId: string,
  billingMonth: string,
  apartmentId: string | null,
): string {
  return apartmentId
    ? `ownerstmt:${ownerPartyId}:${billingMonth}:${apartmentId}`
    : `ownerstmt:${ownerPartyId}:${billingMonth}`;
}

/**
 * Compute and persist the frozen snapshot for one owner-statement period.
 *
 * Balances (integer cents, sign-aware — a running balance can be negative when
 * KAEN has fronted cash) come from resolveOwnerBalance, scoped to the unit when
 * `apartmentId` is set and owner-wide when it is null:
 *   - opening = prior month's carriedForward (resolveOwnerBalance …, prevMonth)
 *   - closing = this month's carriedForward
 *   - net     = this month's netThisPeriod
 *
 * snapshotJson is CASH-BASIS: only SETTLED (paymentStatus="paid") ACTIVE rows for
 * this month + scope, ordered by transactionDate. Unpaid/accrual rows are
 * excluded from the line items (a bank statement shows cash movements) even
 * though they DO move the accrual balances above.
 *
 * Idempotent + monotonic via upsertFrozenPeriod on (org, idempotencyKey). A
 * concurrent duplicate create surfaces as P2002 and is intentionally NOT caught
 * — the caller (cron/route) treats it as a retryable conflict.
 */
export async function freezeStatementPeriod(
  ctx: OwnerBillingActorCtx,
  scope: { ownerPartyId: string; apartmentId: string | null; billingMonth: string },
): Promise<OwnerStatementPeriod> {
  const { orgId } = ctx;
  const { ownerPartyId, billingMonth } = scope;

  // GUARD — only CLOSED (past) months become immutable statements. The current
  // (in-progress) month is LIVE "transaction history" and must NEVER be frozen, nor may
  // a future month. If the current month were freezable, a later forward-reversal
  // (Task 7) that claws back a voided paid charge posts its reversing entry into
  // `curMonth` (the current calendar month) — which would EQUAL the just-frozen month
  // (curMonth === frozenStart). That writes an ACTIVE row INTO a frozen month (an
  // immutability breach) and strands the clawback inside a statement instead of an open
  // month. Intended callers only ever pass PAST months (Task 6 cron = the just-ended
  // month via endedMonth(); Task 8 lazy = prior months), so this guard defends the
  // invariant without constraining them. Compared against the REAL wall clock.
  const now = new Date();
  const currentMonthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  if (firstOfMonth(billingMonth).getTime() >= currentMonthStart) {
    throw new Error(
      `Cannot freeze month ${billingMonth}: only closed (past) months become statements; the current month is live transaction history`,
    );
  }

  // Normalize a falsy apartmentId ("" → null) so the idempotency-key builder AND the
  // persisted apartmentId BOTH treat it as combined-scope. A ""-vs-null split would
  // dedupe two combined statements for one owner-month apart → double payout (LOW-4b).
  const apartmentId = scope.apartmentId || null;
  const periodMonth = firstOfMonth(billingMonth);
  // resolveOwnerBalance takes `string | undefined`; null (combined) → undefined = owner-wide.
  const aptScope = apartmentId ?? undefined;

  // ONE consistent read for BOTH the cash-basis snapshot AND the monotonic-write
  // guard's max(updatedAt): ALL current-period rows for this scope — ANY status, ANY
  // paymentStatus — ordered by transactionDate. Deriving the snapshot AND the max from
  // the SAME set is the fix for the wave-1 read-divergence regression: previously the
  // max came from a SEPARATE, LATER query, so a row inserted between the two reads
  // landed in the max but NOT in the snapshot; the persisted (snapshot, max) pair was
  // self-inconsistent, and a FAITHFUL recompute reproduced the SAME max → the strict
  // `>=` guard (upsertFrozenPeriod) rejected it FOREVER, permanently dropping the row
  // from the frozen statement. From one read, snapshot and max can never diverge: a
  // faithful recompute reproduces the same (or newer) max and is never permanently
  // rejected. Read BEFORE resolveOwnerBalance (below) so the max can only UNDER-count
  // relative to the balance (self-heals via a later freeze), never over-count (the
  // over-count is what pinned the guard).
  const allPeriodRows = await getDb().ownerLedgerEntry.findMany({
    where: {
      organizationId: orgId,
      ownerPartyId,
      statementMonth: periodMonth,
      ...(apartmentId ? { apartmentId } : {}),
    },
    orderBy: { transactionDate: "asc" },
  });

  // opening = prior period's close; closing/net = this period. Unit-scoped when
  // apartmentId is set — resolveOwnerBalance owns the ledger + deposit scoping so
  // combined and per-unit figures come from ONE code path. Read AFTER allPeriodRows
  // (max source first) so the guard max never over-counts relative to the balance.
  //
  // RESIDUAL (Task 6 owns the concurrency-serialization hardening): a row committed
  // between allPeriodRows above and these resolveOwnerBalance reads can make the
  // persisted `closing` include a row the snapshot omits. This SELF-HEALS — a later
  // freeze carries a newer max and IS accepted (the max only under-counted, never
  // over-counted), and resolveOwnerBalance stays authoritative for the payout; only
  // the snapshot line list transiently lags. Full elimination needs a single
  // RepeatableRead transaction spanning resolveOwnerBalance + the row read (threading
  // a tx client through resolveOwnerBalance) and/or Task 6 serializing freezes per
  // owner-scope.
  const prior = await resolveOwnerBalance(orgId, ownerPartyId, undefined, prevMonth(billingMonth), aptScope);
  const current = await resolveOwnerBalance(orgId, ownerPartyId, billingMonth, billingMonth, aptScope);

  // Cash-basis line items derived IN MEMORY from the single read: settled (paid) +
  // active rows only, same transactionDate ordering (preserved by the query orderBy
  // through the filter) and same fields as before — byte-identical snapshot content
  // for unchanged data. Keep it cash-basis (do NOT widen this filter).
  const snapshotJson: Prisma.InputJsonValue = allPeriodRows
    .filter((r) => r.status === "active" && r.paymentStatus === "paid")
    .map((r) => ({
      id: r.id,
      date: r.transactionDate.toISOString(),
      direction: r.direction,
      category: r.category,
      description: r.description,
      // 2dp string (not Decimal.toString(), which drops trailing zeros: "800") so
      // the frozen money line matches the codebase's 2dp convention exactly.
      amount: r.amount.toFixed(2),
      paymentStatus: r.paymentStatus,
    }));

  // Monotonic-write guard input — max(updatedAt) over the SAME all-status/all-payment
  // read that drives the snapshot, so the two can never diverge. The persisted balances
  // depend on EVERY active row regardless of paymentStatus, and a void BUMPS a row's
  // updatedAt, so this all-status max advances on the corrective cases a settled-only
  // max would miss: a new UNPAID-active expense that lowers closing (HIGH-Row1), and a
  // void of the last settled income (HIGH-Row5). Epoch is seeded only for a genuinely
  // row-less period. Deposits move the balance but carry only createdAt (no updatedAt)
  // and no reusable scope-max helper; a deposit added post-freeze is a known remaining
  // minor (see report).
  const sourceMaxUpdatedAt = allPeriodRows.reduce<Date>(
    (max, r) => (r.updatedAt > max ? r.updatedAt : max),
    new Date(0),
  );

  const idempotencyKey = buildStatementPeriodKey(ownerPartyId, billingMonth, apartmentId);
  const openingBalanceC = signedToCents(prior.carriedForward, "freezeStatementPeriod.opening");
  const closingBalanceC = signedToCents(current.carriedForward, "freezeStatementPeriod.closing");
  const netPayoutC = signedToCents(current.netThisPeriod, "freezeStatementPeriod.net");

  const period = await getDb().$transaction(async (tx) => {
    // WRITE-ONCE decision — read the existing period's firstFrozenAt BEFORE upserting.
    // The gate is firstFrozenAt (NOT existence): a period frozen BEFORE this feature
    // shipped has a row but firstFrozenAt = null, so its FIRST post-deploy re-freeze is
    // the remediation that mints the manifest (spec R7 / Open-Questions "no backfill").
    const existing = await tx.ownerStatementPeriod.findFirst({
      where: { organizationId: orgId, idempotencyKey },
    });
    const isFirstFreeze = !existing?.firstFrozenAt;

    const p = await upsertFrozenPeriod(tx, orgId, {
      ownerPartyId,
      apartmentId,
      periodMonth,
      status: "frozen",
      issuedAt: now,
      openingBalanceC,
      closingBalanceC,
      netPayoutC,
      snapshotJson,
      idempotencyKey,
      sourceMaxUpdatedAt,
    });

    // Re-freeze of an already-manifested scope: the snapshot/balances above may have
    // updated (monotonic guard), but the manifest + firstFrozen* header are IMMUTABLE —
    // never re-touched. `p` (from upsertFrozenPeriod) already carries the persisted
    // firstFrozen* set at the first freeze.
    if (!isFirstFreeze) return p;

    // R7 — IMMUTABLE write-once freeze manifest, captured on FIRST freeze ATOMICALLY in
    // the SAME tx as the freeze upsert so a frozen period can never exist without its
    // manifest (no window). The paid-only snapshotJson above is insufficient (it omits
    // includeInPayout/sstAmount and every unpaid-active row); this manifest is the
    // baseline a later reconciliation (R6) diffs the live ledger against.
    await tx.ownerStatementPeriod.update({
      where: { id: p.id },
      data: {
        firstFrozenAt: now,
        // R6 baseline integrity — source the write-once header from the PERSISTED
        // period row `p` (upsertFrozenPeriod), NOT the local recompute consts
        // (openingBalanceC/closingBalanceC/netPayoutC). Those equal the persisted
        // balances ONLY when the monotonic guard ACCEPTS the write. On a remediation
        // re-freeze of a pre-manifest period where the guard REJECTS (persisted balances
        // stay old — see the sourceMaxUpdatedAt/deposit note above), the recompute
        // diverges from the persisted balances. Sourcing from `p` guarantees
        // firstFrozen{Opening,Closing,Net}C == p.{opening,closing,net} at mint time,
        // consistent whether accepted (p == recompute) or rejected (p == old persisted),
        // so the R6 frozen-integrity check never sees a FALSE frozen_balance_drift.
        firstFrozenOpeningC: p.openingBalanceC,
        firstFrozenClosingC: p.closingBalanceC,
        firstFrozenNetC: p.netPayoutC,
        freezeRulesetVersion: FREEZE_RULESET_VERSION,
      },
    });
    const manifestRows = allPeriodRows
      .filter((r) => r.status === "active")
      .map((r) => ({
        organizationId: orgId,
        ownerStatementPeriodId: p.id,
        ownerPartyId,
        apartmentId,
        periodMonth,
        ledgerEntryId: r.id,
        // Plain 2dp→cents magnitude (sign lives in `direction`); string-based via the
        // ledger's own signedToCents so there is NO float drift.
        amountC: signedToCents(r.amount.toFixed(2), "freezeManifest.amount"),
        direction: r.direction,
        category: r.category,
        paidBy: r.paidBy,
        includeInPayout: r.includeInPayout,
        paymentStatus: r.paymentStatus,
        sstAmountC: r.sstAmount == null ? null : signedToCents(r.sstAmount.toFixed(2), "freezeManifest.sst"),
        statementMonth: r.statementMonth,
        sourceType: r.sourceType,
        sourceChargeId: r.sourceChargeId,
        ledgerUpdatedAtAtFreeze: r.updatedAt,
      }));
    if (manifestRows.length > 0) {
      await tx.ownerStatementFreezeManifestRow.createMany({ data: manifestRows });
    }
    return tx.ownerStatementPeriod.findFirstOrThrow({ where: { id: p.id } });
  });

  // Task 5 — POST-COMMIT, BEST-EFFORT statement-PDF attach. Runs ONLY after the freeze
  // $transaction above has committed, so the persisted balances/snapshot are already
  // authoritative and CANNOT be affected by anything here. The whole block is wrapped
  // in try/catch: on ANY failure (no matching Invoice, Chromium absent, render/store
  // error) we LOG and leave pdfKey=null — we NEVER throw out of freezeStatementPeriod
  // and never fail the freeze. A later re-freeze re-attempts the render and overwrites
  // the same deterministic key (putObject upsert), so a transient PDF failure self-heals.
  try {
    // The frozen period is an OwnerStatementPeriod, not an Invoice — look the matching
    // `owner_statement` Invoice up by ITS OWN `owner:` idempotency key (the SHARED
    // buildOwnerStatementInvoiceKey, Task 6 C — the SAME builder generateStatement
    // Service mints with), which differs from this period's `ownerstmt:` key.
    const invoiceKey = buildOwnerStatementInvoiceKey(ownerPartyId, billingMonth, apartmentId);
    const inv = await findInvoiceByIdempotencyKey(orgId, invoiceKey);
    if (inv) {
      // Reuse the SINGLE source of statement-PDF bytes (assemble → buildYanniePdfHtml →
      // htmlToPdf) — no bespoke PDF logic here.
      const bytes = await renderCleanStatementPdfBytes(ctx, inv.id);
      const seg = apartmentId ? apartmentId.slice(0, 8) : "combined";
      const key = `owner-statement-periods/${ownerPartyId}/${billingMonth.replace("-", "")}-${seg}.pdf`;
      await putObject(key, bytes, "application/pdf");
      await getDb().ownerStatementPeriod.update({ where: { id: period.id }, data: { pdfKey: key } });
      period.pdfKey = key;
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[freeze] pdf render skipped:", (e as Error).message);
  }

  return period;
}
