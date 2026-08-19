// Phase-3 (rent-reclassification) READ-ONLY owner-payable reconciliation — the
// R15 waterfall + R18 live/frozen payable snapshot. Pure aggregation of EXISTING
// Phase-2 data (owner ledger + remittance/offset/reversal settlements + frozen
// statement periods); NO write path, NO money mutation.
//
// NOT to be confused with apps/api/src/modules/owner-ledger/reconciliation/ (the
// ADMIN-facing R5/R6 frozen-period drift/integrity audit — findings-repo,
// frozen-integrity, preflight). This module is a per-OWNER "how was my closing
// payable for this month reached" read, exposed on the owner portal.
//
// Plan: docs/superpowers/plans/HANDOFF-2026-07-20-phase2-owner-remittance.md (Phase-3).
//
// R15 identity (computed, NEVER fudged to force balance — an out-of-balance
// result MUST surface via `balanced:false` + the real `discrepancyC`, not be
// hidden or rounded away):
//   openingPayableC + collectionsC − offsetDeductionsC − passThroughExpensesC
//     − grossRemittancesC + reversalsC === closingPayableC
import { getDb } from "@kason/db";
import { toCents, REMITTANCE_SETTLEMENT_KINDS } from "@kason/shared";
import { resolveOwnerBalance } from "../owner-ledger/owner-ledger.repository";
import { periodRemainingPayableC } from "./owner-remittance.repository";

/** The canonical remittance settlementKinds as a Set for O(1) membership. Tied to
 *  the shared REMITTANCE_SETTLEMENT_KINDS enum so the classification below tracks
 *  the source-of-truth list rather than a hand-copied literal. */
const REMITTANCE_KINDS = new Set<string>(REMITTANCE_SETTLEMENT_KINDS);
const OWNER_RECEIVABLE_OFFSET = "OWNER_RECEIVABLE_OFFSET";

const LABEL = "getOwnerPayableReconciliationService";

/** "YYYY-MM" → first-of-month UTC Date (matches the @db.Date grouping keys). */
function firstOfMonth(ym: string): Date {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, 1));
}

export interface OwnerPayableReconciliation {
  ownerPartyId: string;
  apartmentId: string | null;
  periodMonth: string; // "YYYY-MM"
  openingPayableC: number;
  collectionsC: number;
  offsetDeductionsC: number;
  passThroughExpensesC: number;
  grossRemittancesC: number;
  reversalsC: number;
  closingPayableC: number;
  balanced: boolean;
  discrepancyC: number;
  periodStatus: "open" | "frozen";
  frozenNetPayableAtCloseC: number | null;
  remainingPayableNowC: number;
  /**
   * Scope-integrity qualifier for `balanced`/`discrepancyC` (R15). The settlement
   * split (grossRemittancesC / offsetDeductionsC / reversalsC) is ALWAYS owner-wide
   * — a settlement event is attributed at the owner level and often has no single
   * apartment (see OwnerLedgerEntry.propertyId's schema doc) — while opening /
   * collections / closing / pass-through are apartment-scoped when `apartmentId`
   * is set. So a per-unit request can carry owner-wide settlement money the
   * unit-scoped closing does not see, making `discrepancyC` a SCOPE ARTIFACT, not
   * an integrity failure.
   *
   * - `false` — owner-wide request (apartmentId=null), OR a per-unit request whose
   *   settlements are all genuinely attributable to that apartment. In this case
   *   `balanced`/`discrepancyC` ARE authoritative: `balanced:false` means a REAL
   *   reconciliation gap that should be surfaced.
   * - `true`  — `apartmentId` is set AND at least one settlement row this month is
   *   NOT attributable to that apartment (combined-scope or another unit). Here
   *   `balanced`/`discrepancyC` MUST NOT be presented as an authoritative integrity
   *   result: the frontend MUST NOT raise an "unbalanced ledger" / financial-
   *   integrity warning based solely on those fields. The component values may
   *   still be shown for visibility, but the UI must indicate the settlement scope
   *   is incomplete for this apartment view.
   *
   * NOTE: `balanced`/`discrepancyC` themselves are NEVER fudged by this flag —
   * they always compute the honest R15 identity; the flag only qualifies their
   * AUTHORITY, it never rewrites the numbers.
   */
  scopeIncompleteForSettlements: boolean;
}

/**
 * Build the R15 owner-payable reconciliation waterfall for one (owner, month,
 * apartment-or-combined) scope. Callers MUST pre-validate `periodMonth`
 * (YYYY-MM) and `apartmentId` (UUID shape, or null) — this function assumes
 * valid input, mirroring resolveOwnerBalance's own contract.
 */
export async function getOwnerPayableReconciliationService(
  orgId: string,
  ownerPartyId: string,
  periodMonth: string,
  apartmentId: string | null = null,
): Promise<OwnerPayableReconciliation> {
  const db = getDb();
  const monthStart = firstOfMonth(periodMonth);

  // ── Opening / closing / collections — ONE resolveOwnerBalance(month,month)
  // call gives BOTH the pre-month balance (broughtForward = opening) and the
  // post-month balance (carriedForward = closing) in a single pass, sharing
  // the SAME apartmentId scope (owner-wide when null, else this unit only).
  const balance = await resolveOwnerBalance(orgId, ownerPartyId, periodMonth, periodMonth, apartmentId);
  const openingPayableC = toCents(balance.broughtForward, LABEL);
  const closingPayableC = toCents(balance.carriedForward, LABEL);
  // collectionsC = rental income (periodGross) PLUS the period's deposit cash-in.
  // resolveOwnerBalance folds deposits collected in-month into carriedForward
  // (closingPayableC) as a NON-INCOME owner cash-in but deliberately keeps them
  // OUT of periodGross (which is rental income only). A security deposit IS
  // "owner money collected this period" (this field's own contract), and the
  // closing payable already reflects it — so it MUST be on the collections side
  // of the R15 identity, or a perfectly healthy deposit-month would read
  // balanced:false (discrepancyC = −periodDepositC). `balance.depositCollected`
  // is already computed by resolveOwnerBalance under the SAME apartmentId scope,
  // so this stays scope-consistent with openingPayableC/closingPayableC.
  const collectionsC = toCents(balance.periodGross, LABEL) + toCents(balance.depositCollected, LABEL);

  // ── passThroughExpensesC — the `payoutExpenseC` subtotal computed INSIDE
  // packages/shared/src/finance/owner-net-payout.ts#summarizeOwnerPeriod is a
  // local variable there, never returned. Recomputed here independently, over
  // the SAME apartment-scoped period resolveOwnerBalance itself would read:
  // Σ (amount + sstAmount) for active expense lines with includeInPayout=true.
  // A non-pass-through expense (includeInPayout=false, e.g. an owner-paid-direct
  // statutory bill) and a void row are BOTH excluded — neither reduces the cash
  // payout to the owner, matching computeOwnerRunningBalance's own treatment.
  const expenseRows = await db.ownerLedgerEntry.findMany({
    where: {
      organizationId: orgId,
      ownerPartyId,
      status: "active",
      direction: "expense",
      includeInPayout: true,
      statementMonth: monthStart,
      ...(apartmentId ? { apartmentId } : {}),
    },
    select: { amount: true, sstAmount: true },
  });
  const passThroughExpensesC = expenseRows.reduce(
    (sum, r) => sum + toCents(r.amount.toString(), LABEL) + (r.sstAmount ? toCents(r.sstAmount.toString(), LABEL) : 0),
    0,
  );

  // ── Remittance / offset / reversal split — the NEW aggregation. Deliberately
  // org+owner scoped ONLY, NEVER apartmentId-filtered — a settlement EVENT
  // (remittance/offset/reversal) is attributed at the OWNER level, not a single
  // unit (see OwnerLedgerEntry.propertyId's schema doc: "a combined-scope
  // Phase-2 remittance payout has no single meaningful propertyId"). A per-unit
  // reconciliation request can therefore legitimately show a nonzero
  // discrepancyC when the owner has cross-unit settlement activity that month —
  // R15 says surface it via balanced:false, never hide it by narrowing this
  // query to match. `amount` is always a positive magnitude on both an original
  // settlement row and its reversal (sign is structural — which bucket a row
  // lands in — never encoded in the stored value); a reversal row copies its
  // original's settlementKind verbatim, so `reversalOfEntryId` is checked
  // BEFORE settlementKind below (branch order matters: checking settlementKind
  // first would double-bucket a reversed offset as a fresh offset deduction).
  //
  // KNOWN LIMITATION (accepted, matches this router's existing sibling
  // /transactions endpoint precedent which ALSO calls resolveOwnerBalance
  // non-transactionally): these three reads plus resolveOwnerBalance's own
  // internal queries are NOT wrapped in one snapshot transaction. A write
  // committing mid-request could in principle produce a spurious nonzero
  // discrepancyC on a torn read. This is a read-only reporting endpoint with no
  // write path of its own; full cross-query snapshot isolation is out of scope
  // for this additive pass.
  const settlementRows = await db.ownerLedgerEntry.findMany({
    where: {
      organizationId: orgId,
      ownerPartyId,
      direction: "payout",
      settlementKind: { not: null },
      statementMonth: monthStart,
      status: "active",
    },
    select: { amount: true, settlementKind: true, reversalOfEntryId: true, apartmentId: true },
  });

  // Scope-integrity qualifier (see OwnerPayableReconciliation.scopeIncompleteForSettlements):
  // only meaningful for a per-unit request. TRUE iff apartmentId is set AND at
  // least one of this month's owner-wide settlement rows is NOT attributable to
  // that apartment (its apartmentId is null/combined or a different unit) — i.e.
  // the owner-wide split includes money the unit-scoped closing cannot see, so any
  // resulting discrepancyC is a scope artifact, not an integrity failure. A
  // per-unit request whose settlements ALL carry this apartmentId, or that has no
  // settlements at all, keeps balanced/discrepancyC authoritative (flag false).
  const scopeIncompleteForSettlements =
    apartmentId != null && settlementRows.some((r) => r.apartmentId !== apartmentId);

  let grossRemittancesC = 0;
  let offsetDeductionsC = 0;
  let reversalsC = 0;
  for (const row of settlementRows) {
    const cents = toCents(row.amount.toString(), LABEL);
    if (row.reversalOfEntryId != null) {
      reversalsC += cents;
    } else if (row.settlementKind === OWNER_RECEIVABLE_OFFSET) {
      offsetDeductionsC += cents;
    } else if (row.settlementKind != null && REMITTANCE_KINDS.has(row.settlementKind)) {
      grossRemittancesC += cents;
    } else {
      // Defensive: a non-null settlementKind that is neither the offset kind nor a
      // known remittance kind is unexpected — today's enum is exactly
      // {OWNER_REMITTANCE, PRE_STATEMENT_REMITTANCE, OWNER_RECEIVABLE_OFFSET}. It is
      // still a real active payout that closingPayableC (computeOwnerRunningBalance)
      // counts, so it MUST appear in the waterfall or the R15 identity would show a
      // FALSE discrepancy. Default it to the remittance bucket (its most likely
      // class) so the identity stays honest; a future kind with genuinely different
      // payout semantics must revisit this classification (the explicit allow-list
      // above makes that review point obvious rather than a silent catch-all).
      grossRemittancesC += cents;
    }
  }

  // ── R15 identity — computed, NEVER fudged.
  const lhs =
    openingPayableC + collectionsC - offsetDeductionsC - passThroughExpensesC - grossRemittancesC + reversalsC;
  const discrepancyC = lhs - closingPayableC;
  const balanced = discrepancyC === 0;

  // ── R18 — period status + frozen/live payable snapshot. A period row may not
  // exist yet (periods are created lazily elsewhere — freeze/remittance flows —
  // never by this read-only endpoint): treat that as "open, nothing remitted
  // against it yet" rather than propagating periodRemainingPayableC's throw.
  const period = await db.ownerStatementPeriod.findFirst({
    where: { organizationId: orgId, ownerPartyId, apartmentId, periodMonth: monthStart },
    select: { id: true, status: true, firstFrozenAt: true, firstFrozenNetC: true },
  });

  let periodStatus: "open" | "frozen" = "open";
  let frozenNetPayableAtCloseC: number | null = null;
  // remainingPayableNowC has TWO deliberately-different bases across the two arms
  // below (an inherent consequence of R18's live/frozen duality, not an
  // inconsistency): with NO period row it is the live closing payable
  // (ledger + deposits); once a period row exists it becomes
  // `netPayoutC − active allocations` (the remittance-allocation basis). The value
  // can therefore step when a period row first materializes for a month — expected,
  // documented here so a future reader does not "reconcile" the two bases away.
  let remainingPayableNowC = closingPayableC;

  if (period) {
    periodStatus = period.status === "frozen" ? "frozen" : "open";
    frozenNetPayableAtCloseC = period.firstFrozenAt != null ? period.firstFrozenNetC : null;
    // periodRemainingPayableC requires a Prisma.TransactionClient (module GC3
    // convention); a short single-read $transaction satisfies that contract — the
    // identical wrapper getOwnerAccountService uses for this same call.
    remainingPayableNowC = await db.$transaction((tx) => periodRemainingPayableC(tx, orgId, period.id));
  }

  return {
    ownerPartyId,
    apartmentId,
    periodMonth,
    openingPayableC,
    collectionsC,
    offsetDeductionsC,
    passThroughExpensesC,
    grossRemittancesC,
    reversalsC,
    closingPayableC,
    balanced,
    discrepancyC,
    periodStatus,
    frozenNetPayableAtCloseC,
    remainingPayableNowC,
    scopeIncompleteForSettlements,
  };
}
