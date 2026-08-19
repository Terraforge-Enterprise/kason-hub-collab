// Single source of truth for the bills-grid ROW EDIT LOCK.
//
// ── Why this file exists ─────────────────────────────────────────────────────
// This predicate used to be three hand-copied literals — grid-table.tsx,
// nav-cells.ts and bills-grid-page.tsx each carried its own `billedAt != null &&
// paymentStatus === "paid"`, under a comment on each begging the next editor to
// keep all three in step. That is the repo's lock-step drift shape: booleans
// that agree by convention, and that fail SILENTLY when one of them moves (no
// type error tells you the render locked a row the keyboard nav still thinks is
// editable). One exported function instead, so a change lands everywhere at once.
//
// ── What changed on 2026-08-03, and why ──────────────────────────────────────
// The old predicate read ONLY the manual `paymentStatus` column. That column is
// hand-set by an admin and is DELIBERATELY never advanced by a Bill or by a
// payment (bills-grid/service.ts R10, "billing is not payment"), so in practice
// a row almost never locked: a tenant could pay a line in full and the grid would
// still render a live <input> over frozen money. The admin edits it, hits Save,
// and the write is rejected — because the SERVER has frozen that entry the whole
// time. The backend paid-freeze (`anyChargePaid`, and its batched read-path twin
// `entriesWithPaidInvoice` in bills-grid/service.ts) freezes an entry on ANY
// net-positive payment against a live charge, partial included.
//
// So the frontend now reads the same fact the server enforces on: the read-time
// `settlement` roll-up. Any money in at all — "partial" or "paid" — locks the
// whole row, matching the server rather than arguing with it.
//
// ── Two properties worth keeping ─────────────────────────────────────────────
//  1. The manual column is kept as an OR, not replaced. An admin who marked a
//     row "paid" by hand still locks it exactly as before. That makes this a
//     strict SUPERSET of the old predicate: it can only ever WITHHOLD an edit the
//     server would have rejected anyway — it can never newly PERMIT one. A lock
//     that is wrong in this direction costs an admin a refresh; wrong in the
//     other direction it costs silently-dropped money edits.
//  2. Rows with no payment at all stay editable. `settlement` "unpaid"/"none"
//     does not lock, so amend-and-re-Bill on a billed-but-unpaid row (spec R7,
//     the reason the lock was loosened to `paymentStatus` in the first place)
//     keeps working untouched.
//
// This stays an ADVISORY gate: the server-side freeze remains authoritative, so
// a stale row here surfaces as a rejected save, never a silent money mutation.
import type { SettlementState } from "@kason/shared";
import type { GridRow } from "@/api/bills-grid";

/**
 * Which settlement states freeze the row.
 *
 * A `Record` over the full union rather than a bare `["partial","paid"].includes(...)`:
 * an array accepts a newly-added SettlementState with ZERO type errors and silently
 * classifies it as editable, which for a money grid is the dangerous default. The
 * Record makes a new state a build failure that has to be answered here.
 */
const LOCKING_SETTLEMENT: Record<SettlementState, boolean> = {
  // Nothing billed yet — the row has never produced a charge to pay.
  none: false,
  // Billed, no money in. Amend + re-Bill is the whole point of spec R7.
  unpaid: false,
  // ANY net-positive payment freezes the entry server-side (anyChargePaid) —
  // including a payment against just ONE cell of the row. Editing here is
  // exactly the case that used to look writable and then fail on Save.
  partial: true,
  // Fully settled.
  paid: true,
};

/** The fields the lock reads. Structural, so callers can pass a full GridRow. */
export type RowLockInput = Pick<GridRow, "billedAt" | "paymentStatus" | "settlement">;

/**
 * TRUE when this unit-month row must render read-only.
 *
 * An UNBILLED row is never locked, whatever its settlement says — there is no
 * issued document behind it to freeze, and a stray settlement roll-up must not
 * strand an editable row.
 */
export function isRowLocked(row: RowLockInput): boolean {
  if (row.billedAt == null) return false;
  // Manual admin column (legacy signal, preserved — see note 1 above).
  if (row.paymentStatus === "paid") return true;
  // Server-derived real payment state. Absent (older payload, or a test fixture
  // that predates the settlement DTO) ⇒ "none" ⇒ not locked, so those rows keep
  // their pre-existing behaviour.
  return LOCKING_SETTLEMENT[row.settlement?.status ?? "none"] ?? false;
}

// ── Per-CELL money lock (R6 write half, 2026-08-18) ──────────────────────────
//
// `isRowLocked` above freezes the WHOLE row on any settlement — documented at the time
// as an accepted trade-off, because the server froze the whole entry too and a re-Bill
// refused the month outright once any money landed.
//
// Partial re-Bill changed the underlying fact: paying the electricity no longer freezes
// the WiFi. So the row lock is now coarser than the money it represents, and an admin
// looking at a part-paid month sees every cell greyed when only one of them is settled.
//
// This narrows the render WITHOUT widening it. It starts from `isRowLocked` and can only
// ever UNLOCK a cell whose own settlement bucket carries no money — it never locks a cell
// the row lock left open. That direction matters: the server is authoritative, so a
// wrongly-open cell costs a rejected save, while a wrongly-locked cell costs an edit the
// admin is entitled to make.

import type { SettlementBucket } from "@kason/shared";
import { isPhase2FlagEnabled } from "@/lib/feature-flags";
import { SETTLEMENT_BUCKET_OF_COLUMN, type ColumnId } from "./columns";

/**
 * Which settlement bucket a column's LOCK reads.
 *
 * DERIVED from SETTLEMENT_BUCKET_OF_COLUMN (columns.ts) — the paint map — so the two
 * cannot silently drift, with exactly two deliberate overrides below. A review flagged an
 * earlier version of this file for carrying a full second copy that disagreed on 8 of 19
 * columns; spreading the paint map fixes that while keeping the one place they genuinely
 * must differ.
 *
 * They differ because they answer different questions. The paint asks "does this cell show
 * a green settled tick?" — a meter-reading input never does. The lock asks "does editing
 * this cell touch money that has already been paid?" — and editing a meter reading
 * RE-PRICES the tenant's electricity, so it must freeze exactly when that electricity is
 * settled. Mapping them to null would inherit the whole-row verdict and re-freeze the
 * meter cells on any part-paid month, which is the behaviour this work exists to remove.
 */
const CELL_BUCKET: Record<ColumnId, SettlementBucket | SettlementBucket[] | null> = {
  ...SETTLEMENT_BUCKET_OF_COLUMN,
  // Paint: null (not a money cell). Lock: editing either re-prices tenant electricity.
  previousKwh: "tnbTenant",
  currentKwh: "tnbTenant",
  // Paint: "tnbOwner". Lock: BOTH TNB buckets.
  //
  // The header says "Owner", but this cell does not write an owner-only figure — it writes
  // the SHARED `tnbTotal` (bills-grid-page.tsx `DIRECT_WIRE_FIELD`), the whole TNB bill.
  // Every occupied room's tenant share is derived from it (meter/compute.ts:
  // `leftoverTnb = tnbTotal - totalAircond`, then `tnbShare = leftoverTnb / totalPax * pax`),
  // and under an "absorbed" pattern it is ALSO the owner's own electricity charge
  // (bills-grid/service.ts `OWNER_AMOUNT_OF.electricity`). So it re-prices whichever side
  // has money against it, and must stay frozen while EITHER is settled.
  //
  // Keying it on `tnbOwner` alone left it editable over paid tenant electricity: that bucket
  // reads "none" unless the pattern is "absorbed", which is the ordinary case.
  tnbOwner: ["tnbOwner", "tnbTenant"],
};

/** The fields the cell lock reads — a superset of the row lock's. */
export type CellLockInput = RowLockInput;

/**
 * TRUE when THIS cell must render read-only.
 *
 * Strictly narrower than {@link isRowLocked}: an unlocked row leaves every cell unlocked,
 * and a locked row unlocks only the cells whose own bucket is unpaid.
 */
export function isCellLocked(row: CellLockInput, columnId: ColumnId): boolean {
  if (!isRowLocked(row)) return false;
  // FLAG-GATED, and this gate is the whole safety argument.
  //
  // The narrowing is only correct BECAUSE partial re-Bill exists: an edit to an unpaid
  // cell has a route onto a document. With ENABLE_PROFORMA_INVOICES off there is no such
  // route — the server's four ENTRY_LOCKED guards fall back to entry-wide, and re-Bill
  // refuses the whole month once any money lands. Unlocking a cell there would render a
  // live input over an edit the server rejects: exactly the 409-you-could-not-predict this
  // work set out to remove, reintroduced from the other side.
  //
  // So flag off ⇒ behave as isRowLocked, which returned `true` to reach this line.
  if (!isPhase2FlagEnabled("ENABLE_PROFORMA_INVOICES")) return true;
  const bucket = CELL_BUCKET[columnId];
  // No bucket of its own ⇒ inherit the row's verdict, which is `true` here.
  if (bucket === null) return true;
  // A cell that writes a field feeding SEVERAL buckets locks when ANY of them is settled —
  // editing it would re-price whichever one holds the money.
  const buckets = Array.isArray(bucket) ? bucket : [bucket];
  // Absent settlement ⇒ stay locked. The row lock already concluded money is present; with
  // no per-bucket detail we cannot say WHICH cell it belongs to, so we do not guess.
  return buckets.some((b) => LOCKING_SETTLEMENT[row.settlement?.cells?.[b] ?? "paid"] ?? true);
}

// ── Governed-scalar SETTINGS lock (2026-08-06) ───────────────────────────────
// Same drift shape as the row lock above: grid-table (render) and nav-cells
// (keyboard) must agree on which scalar cells an enabled recurring definition
// has flipped read-only, and they each carried their own cleaning/wifi ternary.
// When the Maintenance column joined the governed set, the predicate moved here
// so the third copy could never be born.

/** The scalar columns an enabled recurring definition can govern. */
export type GovernableScalarColumn =
  | "cleaningOwner" | "cleaningTenant" | "wifiOwner" | "wifiTenant" | "maintenanceFee";

/** The fields the settings lock reads. Structural, so callers pass a full GridRow. */
export type ScalarLockInput = Pick<
  GridRow,
  "cleaningRecurringLocked" | "wifiRecurringLocked" | "cleaningRecurringAmount" | "wifiRecurringAmount" | "scalarRecurring"
>;

/**
 * Whether the settings (an ENABLED recurring def) lock this scalar cell.
 * `false` = explicitly NOT governed → the cell is an editable per-month value.
 *
 * Absent-flag defaults DIFFER by column, on purpose:
 *  • cleaning/wifi keep the R6 contract — an OMITTED flag (undefined) renders
 *    read-only, the money-safe default for payloads/fixtures that predate R6.
 *  • maintenanceFee inverts it (absent ⇒ false ⇒ editable) — its legacy state is
 *    a plain manual column, so a fixture without `scalarRecurring` must stay
 *    editable; live payloads always carry `scalarRecurring` explicitly.
 */
export function scalarSettingsLock(row: ScalarLockInput, columnId: GovernableScalarColumn): boolean | undefined {
  if (columnId === "maintenanceFee") return row.scalarRecurring ? row.scalarRecurring.MAINTENANCE.governed : false;
  return columnId.startsWith("cleaning") ? row.cleaningRecurringLocked : row.wifiRecurringLocked;
}

/** The GENERATED (settings-controlled) amount a governed cell displays — present even
 * for an unopened month whose entry scalar is still null. null when ungoverned. */
export function scalarGeneratedAmount(row: ScalarLockInput, columnId: GovernableScalarColumn): string | null {
  if (columnId === "maintenanceFee") return row.scalarRecurring?.MAINTENANCE.amount ?? null;
  return (columnId.startsWith("cleaning") ? row.cleaningRecurringAmount : row.wifiRecurringAmount) ?? null;
}
