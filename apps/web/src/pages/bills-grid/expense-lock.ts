// Single source of truth for the expense dialog's PER-LINE edit lock.
//
// ── Why this file exists ─────────────────────────────────────────────────────
// The row lock next door (row-lock.ts) answers "is this unit-month row frozen?".
// It cannot answer "is THIS expense line frozen?", because the settlement DTO's
// `expenses{Owner,Tenant}` bucket collapses every expense on the month into one
// state. So the dialog had no per-line signal at all and rendered a live
// <input> over every line — including ones the server had already frozen. The
// admin edited a paid line, hit Save, and got a `409 ENTRY_LOCKED` with nothing
// on screen that could have predicted it.
//
// `GridSettlementDto.expenseLines` (keyed by GridExpense.id) supplies the missing
// grain; this file is the ONE place that turns it into a lock decision, so the
// render, the void control and the attachment gate cannot drift apart the way
// the three hand-copied row-lock literals did before row-lock.ts existed.
//
// ── Fail-closed, unlike row-lock.ts — and why ────────────────────────────────
// row-lock.ts maps an ABSENT settlement to "none" ⇒ editable, deliberately, so
// payloads predating that DTO keep their old behaviour. This file inverts that
// for a persisted line: absent ⇒ LOCKED.
//
// The asymmetry is intentional. row-lock guards a row whose server-side freeze
// is a SUPERSET of what it renders, so a wrong-open row still fails safe at the
// server with a clear rejection. Here the whole point is that the server
// rejection is the bad outcome we are removing — rendering an editable line we
// cannot prove is unpaid recreates exactly the bug. Wrong-closed costs a
// refresh; wrong-open costs the admin their typing and shows a 409.
//
// Two kinds of line are editable WITHOUT consulting settlement at all, because no
// payment can physically exist against them yet:
//
//   • never persisted (`id === null`) — no charge was ever minted from it;
//   • created THIS session (`seeded === false`) — it may have gained an id moments ago
//     via the attach-to-persist path, but it has not been billed, so nothing can have
//     been paid against it. Its `settlement` is absent because no server read has
//     returned it yet, NOT because the payload is stale — so the fail-closed rule below
//     must not catch it. (This is the case the attach-then-edit-amount test caught: a
//     freshly auto-created row rendered read-only and swallowed the admin's edit.)
import type { SettlementState } from "@kason/shared";

/**
 * What the dialog should do with one expense line.
 * `unknown` is the fail-closed bucket: locked, but labelled neutrally, because
 * claiming "Paid" for a line we have no settlement fact about would be a lie.
 */
export type ExpenseLockState = "editable" | "part-paid" | "paid" | "unknown";

/**
 * Settlement state → lock state.
 *
 * A `Record` over the full union rather than a bare comparison: an array or an
 * `includes` check accepts a newly-added SettlementState with ZERO type errors and
 * silently classifies it as editable, which for money is the dangerous default.
 * The Record makes a new state a build failure that has to be answered here.
 */
const LOCK_BY_SETTLEMENT: Record<SettlementState, ExpenseLockState> = {
  // Never billed — no charge exists, so there is nothing to freeze.
  none: "editable",
  // Billed, no money in. Amend + re-Bill is the whole point of the billed-but-unpaid
  // unlock (2026-08-17 spec); this line must stay editable.
  unpaid: "editable",
  // Some money against this line. For an SST-bearing line this is also the state when
  // the base charge settled but its `-SST` sibling has not — still frozen, correctly.
  partial: "part-paid",
  // Every charge minted from this line is settled.
  paid: "paid",
};

/** The fields the lock reads. Structural, so callers can pass a fuller row object. */
export type ExpenseLockInput = {
  /** Existing GridExpense id, or null for a row not yet persisted. */
  id: string | null;
  /** True when the row was seeded from server truth on mount. False for a row added
   *  this session — including one that gained an id mid-session via attach-to-persist.
   *  Absent is treated as seeded (the conservative reading) so a caller that omits it
   *  still gets the fail-closed settlement check rather than a free pass. */
  seeded?: boolean;
  settlement?: SettlementState;
};

/** What this line's edit affordances should be. See the fail-closed note above. */
export function expenseLockState(row: ExpenseLockInput): ExpenseLockState {
  if (row.id === null) return "editable";
  // Created this session ⇒ never billed ⇒ nothing can be paid against it. Checked BEFORE
  // the absent-settlement rule, which would otherwise lock a row the admin just made.
  if (row.seeded === false) return "editable";
  if (row.settlement === undefined) return "unknown";
  return LOCK_BY_SETTLEMENT[row.settlement] ?? "unknown";
}

/** TRUE when this line must render read-only. */
export function isExpenseLineLocked(row: ExpenseLockInput): boolean {
  return expenseLockState(row) !== "editable";
}

/** The pill text for a locked line; null when the line is editable. */
export function expenseLockLabel(row: ExpenseLockInput): string | null {
  const state = expenseLockState(row);
  if (state === "editable") return null;
  return state === "paid" ? "Paid" : state === "part-paid" ? "Part paid" : "Locked";
}
