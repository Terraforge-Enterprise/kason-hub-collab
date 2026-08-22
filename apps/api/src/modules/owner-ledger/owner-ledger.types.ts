import type { Prisma } from "@kason/db";
import type { OwnerLedgerLine } from "@kason/shared";

// ─── Forward / adjustment source-types (canonical, shared) ───────────────────
//
// Ledger sourceTypes that are NOT a charge's "normal" booked frozen-month row. A
// FORWARD row (a post-freeze collection/adjustment, or a holdback reversal) carries
// the same sourceChargeId but is posted into a LATER (then-open) month; once THAT
// month later freezes it becomes an active, non-"reversal" row sitting in a frozen
// statementMonth. Every "find the charge's true frozen NORMAL row" lookup MUST
// exclude this COMPLETE set — else an aged forward row is mistaken for the normal
// row and its cash is double-counted (final-review Finding 1: owner-payout money).
// This is the single canonical list — do not re-declare a partial copy per module.
export const FORWARD_SOURCE_TYPES = [
  "prior_period_collection",
  "prior_period_collection_reversal",
  "reversal",
  "reversal_forward_adjustment",
  "prior_period_adjustment",
];

// ─── DB row type ─────────────────────────────────────────────────────────────

/** Full OwnerLedgerEntry row as returned by Prisma. */
export type DbOwnerLedgerEntry = Prisma.OwnerLedgerEntryGetPayload<Record<string, never>>;

// ─── Actor context ────────────────────────────────────────────────────────────

/**
 * Caller identity threaded into every write. The service stamps
 * `createdById`/`updatedById` on the row from this before passing
 * the prepared data to the repository.
 */
export interface OwnerLedgerActorCtx {
  orgId: string;
  actorUserId: string;
  actorRole: "admin" | "director" | "manager" | "editor" | "owner";
  ip?: string;
  userAgent?: string;
}

// ─── Filters + pagination ────────────────────────────────────────────────────

/** All optional filters accepted by listEntries. */
export interface OwnerLedgerListFilters {
  ownerPartyId?: string;
  propertyId?: string;
  /** P4 unit-first ledger: narrow to one apartment (additive). */
  apartmentId?: string;
  /** Exact month match (ISO YYYY-MM or first-of-month Date). */
  month?: string;
  /** Inclusive start of month range (YYYY-MM). */
  fromMonth?: string;
  /** Inclusive end of month range (YYYY-MM). */
  toMonth?: string;
  direction?: string;
  category?: string;
  paidBy?: string;
  paymentStatus?: string;
  taxCategory?: string;
  /** Filter rows that have (true) or lack (false) at least one attachment key. */
  hasAttachment?: boolean;
}

export interface OwnerLedgerPagination {
  limit: number;
  offset: number;
}

// ─── Period query args ────────────────────────────────────────────────────────

export interface OwnerLedgerPeriodArgs {
  ownerPartyId?: string;
  propertyId?: string;
  /** Inclusive start month (YYYY-MM). Omit for open lower bound (all-time). */
  fromMonth?: string;
  /** Inclusive end month (YYYY-MM). Omit for open upper bound (all-time). */
  toMonth?: string;
}

// ─── Row → OwnerLedgerLine mapper ────────────────────────────────────────────

/**
 * Map a DB row's fields into the pure-calc `OwnerLedgerLine` shape consumed by
 * `summarizeOwnerPeriod` / `summarizeTax` in packages/shared. Decimal columns
 * come from Prisma as Decimal-like objects; `.toString()` gives the 2dp string.
 */
export function rowToLedgerLine(row: DbOwnerLedgerEntry): OwnerLedgerLine {
  return {
    direction: row.direction as "income" | "expense" | "payout",
    category: row.category,
    amount: row.amount.toString(),
    sstAmount: row.sstAmount != null ? row.sstAmount.toString() : null,
    includeInPayout: row.includeInPayout,
    taxCategory: row.taxCategory,
    reversalOfEntryId: row.reversalOfEntryId ?? null,
  };
}
