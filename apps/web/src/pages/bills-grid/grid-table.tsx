// Bills & Expenses Grid — wide period-row table with nested tenant sub-rows
// and grain discipline (UI Task 3). Pure + props-driven: no fetch, no store.
// The page shell (bills-grid-page.tsx, ui-10) owns data-fetching and wires the
// live staged-edit buffer + hidden-column state; this component only renders
// what it is given.
//
// invariant: `row.entry === null` means "apartment-month never Saved" — a
// legitimate empty state, NOT a regression (§16). `row.bearerConfig` is
// ALWAYS present (server sends defaults when no config row exists) — treating
// it as possibly-absent here would itself be a contract regression.
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Paperclip, Eye, History } from "lucide-react";
import type { GridRow, GridSubRow } from "@/api/bills-grid";
import { visibleSubRows } from "./occupancy";
import { DataTable, TableHead, StatusPill, EmptyRow } from "@/components/ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { PHASE2_STATUS_TONES } from "@kason/shared";
import type { StatusTone, SettlementState } from "@kason/shared";
import { isCellLocked, isRowLocked, scalarGeneratedAmount, scalarSettingsLock } from "./row-lock";
import { cn } from "@/lib/utils";
import type { ColumnId, GridColumn } from "./columns";
import { SETTLEMENT_BUCKET_OF_COLUMN } from "./columns";
import { parseAmountCell } from "./cell-parser";
import { cleaningSeed } from "./cell-seed";
import { isApplicable, showsTenantBorneMark } from "./cell-applicability";
// ui-task-10e: pointer/selection/colour extension — `SelectionCell` is the
// hook's (ui-4, use-grid-selection.ts) cell-identity shape. Importing the
// TYPE only keeps this file free of the hook's runtime/state; the page shell
// (bills-grid-page.tsx) owns the actual useGridSelection() instance.
import type { SelectionCell } from "./use-grid-selection";
// Excel-Web V2 (grid-gestures.ts): the SINGLE resolver for pointer/click
// modifiers. `resolvePointerGesture` turns a raw pointerdown into select /
// context / ignore (platform-aware: Cmd=multi on mac, Ctrl+click=right-click on
// mac); `resolveClickMods` gives the same platform-aware {shift,ctrl} for the
// activate click path.
import { resolvePointerGesture, resolveClickMods } from "./grid-gestures";

// Task 9 (R7/R8): a small phone-style count badge — red circle + number,
// hidden entirely at 0 (never renders "0" or NaN). Display-only; reused on
// both the attachment (paperclip) button and the expense (eye) button.
function CountBadge({ count, testId }: { count: number; testId: string }) {
  if (!count || count <= 0) return null;
  return (
    <span
      data-testid={testId}
      className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-600 px-1 text-[10px] font-semibold leading-none text-white"
    >
      {count}
    </span>
  );
}

// Task 7 (P5/R7): per-row audit affordance — a small muted icon whose hover
// tooltip reads "Edited by {name} · {local date-time}"; when never edited
// shows a muted "—" with title "Not edited" instead, per Error Handling:
// never a crash or a raw UUID.
//
// Final-review fix pass, FIX 1: the dash gates on `name` ALONE, not `name &&
// at` — `at` (row.entry.updatedAt / subRow.updatedAt) is the Prisma
// `@updatedAt` token, which is ALWAYS non-null on any saved entry, so
// requiring both null would never fire for a saved row. `lastEditedByName`
// is the actual null-able signal (updatedById is a nullable FK with no
// backfill — every pre-existing prod/UAT row has this null while carrying a
// real updatedAt). Spec R7 + Error Handling define the null contract on the
// NAME, not the timestamp.
function AuditIcon({ name, at }: { name: string | null | undefined; at: string | null | undefined }) {
  if (!name) return <span className="text-muted-foreground/50" title="Not edited">—</span>;
  const when = at ? new Date(at).toLocaleString() : "";
  const title = `Edited by ${name}${when ? ` · ${when}` : ""}`;
  return (
    <span
      className="inline-flex text-muted-foreground/60"
      title={title}
      aria-label={title}
      data-testid="audit-icon"
    >
      <History className="h-3 w-3" />
    </span>
  );
}

export type ExpenseBearer = "tenant" | "owner";
/** Which recurring cell (Owner / Tenant) opened the recurring dialog — the dialog's line list and
 *  total are scoped to it, exactly as the Expenses dialog is scoped by ExpenseBearer. */
export type RecurringBearer = "tenant" | "owner";

const ENTRY_STATUS_TONES: Record<string, StatusTone> = PHASE2_STATUS_TONES.billsGridEntry;

export type CellKey = string; // apartmentId (unit-grain) or listingId (subRow-grain)

export type CellEditHandler = (cellKey: CellKey, columnId: ColumnId, value: string) => void;

export interface GridTableProps {
  rows: GridRow[];
  columns: GridColumn[];
  onCellEdit?: CellEditHandler;
  onOpenSettings?: (apartmentId: string) => void; // R11 — per-unit bearer drawer
  onViewExpenses?: (apartmentId: string, bearer: ExpenseBearer) => void; // R27 — expense eye-icon
  onViewRecurring?: (apartmentId: string, bearer: RecurringBearer) => void; // recurring-charges — recurring dialog trigger
  onOpenAttachments?: (apartmentId: string) => void; // attachments panel
  // ui-task-10e (R31 a/c/d, via useGridSelection — ui-4): ALL optional —
  // absent ⇒ every cell renders exactly as before this task (Task-3/ui-10b
  // parity). Wired on the EDITABLE numeric cells only (LockedCell/billed
  // cells never receive these — money guard for ctrl-fill, ui-10f, lives at
  // that layer, not here).
  // Task 3 (Excel mouse-selection V2): the second arg is now a {shift,ctrl}
  // mods object (was a bare ctrlKey boolean). shift extends a rectangle from
  // the anchor; ctrl toggles a cell into a multi-selection; both fold metaKey
  // into ctrl (mac Cmd) exactly as the old ctrlKey||metaKey did.
  onCellPointerDown?: (cell: SelectionCell, mods: { shift: boolean; ctrl: boolean }) => void;
  onCellPointerEnter?: (cell: SelectionCell) => void; // drag-over
  onCellPointerUp?: () => void;
  isCellSelected?: (cellKey: string, columnId: ColumnId) => boolean; // render selection highlight
  cellColour?: (cellKey: string, columnId: ColumnId) => string | undefined; // render background colour (localStorage-only, never a calc input)
  // P4 Task 3 (active-cell nav, R5): ALL optional — absent ⇒ byte-identical to
  // today (parity). Wired on EVERY navigable cell (editable inputs AND the
  // read-only value-bearing cells: billed/amount/rental LockedCells, the four
  // expense-total ReadOnlyCells, and the raw inline sub-row rental <td>), so
  // arrow-nav landing on any of them gets an active ring + focus + click.
  isCellActive?: (cellKey: string, columnId: ColumnId) => boolean; // render the active-cell ring (distinct from selection)
  // Task 3: activate now carries a {shift,ctrl} mods object built from the
  // click event's modifier keys — so a shift/ctrl click extends/toggles the
  // selection via the SAME path instead of collapsing it through the plain
  // onClick. Plain click ⇒ {shift:false, ctrl:false} (unchanged behaviour).
  onCellActivate?: (cellKey: string, columnId: ColumnId, mods: { shift: boolean; ctrl: boolean }) => void; // pointer click → activate
  // Excel-Web V2 — right-click. Wired on EVERY navigable cell (editable +
  // read-only). The page owns the custom context menu: it preventDefaults the
  // native menu, preserves the selection when the click is inside it (else
  // collapses to this cell), and positions the menu at the pointer. OPTIONAL —
  // absent ⇒ no handler, native menu (parity).
  onCellContextMenu?: (cell: { cellKey: string; columnId: ColumnId }, e: React.MouseEvent) => void;
  // Excel-Web V2 — double-click an EDITABLE cell → enter edit mode (caret at the
  // click point; native word-select is suppressed). OPTIONAL — absent ⇒ no
  // handler (parity). Read-only cells never receive this (nothing to edit).
  onCellDoubleClick?: (cellKey: string, columnId: ColumnId) => void;
  // Excel-Web V2 — click a column header to select the whole column (all rows).
  // A SUB-column header passes its one id; a BAND header passes every sub-column
  // id under it (e.g. "TNB" → tnbOwner/previousKwh/currentKwh/amount). `mods`
  // carries platform-aware {shift,ctrl}: plain = replace, ctrl/cmd = add the
  // column(s), shift = extend the column range from the active cell. OPTIONAL —
  // absent ⇒ headers are non-interactive (parity).
  onSelectColumns?: (columnIds: ColumnId[], mods: { shift: boolean; ctrl: boolean }) => void;
  registerCell?: (cellKey: string, columnId: ColumnId, node: HTMLElement | null) => void; // node registry for the page's focus/scroll effect
  // ui-task-10g: the page's OWN `useStagedEdits` buffer (`${cellKey}:${columnId}`
  // -> raw text), so a PROGRAMMATIC stage the page makes on the buffer directly
  // (ctrl-fill via handleCellEdit, ui-9 crash-recovery restoring from
  // sessionStorage) also repaints the <input> here — not just a real keystroke,
  // which only ever reaches GridTable's OWN internal echo state below. OPTIONAL:
  // absent ⇒ byte-identical to today (Task-3/ui-4/ui-10b/e parity — internal-or-seed
  // only, no page buffer consulted at all).
  staged?: Record<string, string>;
  // P4 Task 5 (Esc-revert, Hard Point B): GridTable's internalStaged keystroke
  // echo has TOP display precedence (stagedOrSeed checks it FIRST). So the page's
  // revertActiveEdit must clear BOTH the page buffer (unstage) AND this internal
  // echo — otherwise the typed value stays visible. GridTable exposes its clear
  // capability by calling this registrar (mirrors the cell-node `registerCell`
  // registry) with a stable clearInternalStaged(cellKey, columnId) fn. OPTIONAL:
  // absent ⇒ no registration, byte-identical to today.
  registerClearInternalStaged?: (fn: (cellKey: string, columnId: string) => void) => void;
  // ── Per-unit Bill selection (money-critical) ──────────────────────────────
  // The user picks WHICH units to Bill via a checkbox per row + a select-all in
  // the Unit header. ALL optional — absent ⇒ no checkboxes render (parity with
  // the pre-selection grid; GridTable-only tests that omit these are unaffected).
  // Billing is per-UNIT (apartment): a checked unit bills every occupied room's
  // tenant invoice + the owner invoice as one backend op — there is no per-tenant
  // Bill. `billableApartmentIds` is the page's `billableRows` id-set (entry saved,
  // not yet billed): ONLY these rows get a checkbox, and the header select-all is
  // disabled when the set is empty. `selectedForBill` is the checked subset.
  billableApartmentIds?: ReadonlySet<string>;
  selectedForBill?: ReadonlySet<string>;
  allBillableSelected?: boolean; // header checkbox = checked
  someBillableSelected?: boolean; // header checkbox = indeterminate
  onToggleBillSelection?: (apartmentId: string) => void; // per-row toggle
  onToggleSelectAllForBill?: () => void; // header select-all / clear-all
  // Mirrors the page's "show vacant" view toggle down to the room grain: when
  // explicitly `false`, a partitioned unit hides its vacant (untenanted, dataless)
  // rooms — the same rows `visibleUnits` never gets to filter because they live
  // INSIDE an occupied unit. `undefined` ⇒ no room filtering (parity for
  // GridTable-only tests that don't wire the toggle); `true` ⇒ show every room.
  showVacant?: boolean;
}

// ── band-header grouping ─────────────────────────────────────────────────────

interface BandGroup {
  band: string;
  columns: GridColumn[];
}

/** Groups consecutive columns sharing a `band`, preserving CURRENT_COLUMNS order. Columns with no band (unitCode) are excluded — they get their own rowSpan=2 header cell instead. */
function groupBands(columns: GridColumn[]): BandGroup[] {
  const groups: BandGroup[] = [];
  for (const col of columns) {
    if (!col.band) continue;
    const last = groups[groups.length - 1];
    if (last && last.band === col.band) {
      last.columns.push(col);
    } else {
      groups.push({ band: col.band, columns: [col] });
    }
  }
  return groups;
}

// ── money helpers (display-only; never a calc input) ────────────────────────

function subtractMoney(total: string | null, part: string | null): string {
  const t = total != null ? Number(total) : 0;
  const p = part != null ? Number(part) : 0;
  return (t - p).toFixed(2);
}

/** Round to 2dp, half-away-from-zero via the standard float `* 100 round /
 * 100` idiom — mirrors the server's own round2 (compute.ts). Display-only:
 * the live-preview this feeds is NEVER sent on Save (server is the sole
 * money authority; Task 6 §7). */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Task 6: the Amount cell is read-only and now LIVE-PREVIEWS
 * round2((current-previous) x ratePerKwh) whenever both Current/Previous are
 * staged/seeded as parseable numbers — else it falls back to the last
 * stored `subRow.amount`. Negative deltas clamp to 0 (never negative money
 * shown), matching the server's own floor. Pure/display-only. */
function amountPreview(subRow: GridSubRow, prevRaw: string, curRaw: string): string {
  const rate = Number(subRow.ratePerKwh);
  const prev = prevRaw !== "" ? Number(prevRaw) : NaN;
  const cur = curRaw !== "" ? Number(curRaw) : NaN;
  if (Number.isNaN(prev) || Number.isNaN(cur) || Number.isNaN(rate)) {
    return subRow.amount ?? "—";
  }
  const delta = cur - prev;
  return Math.max(0, round2(delta * rate)).toFixed(2);
}

// ui-task-10e: `SelectionCell.value` seeds `sum` (drag-select) in
// useGridSelection — numeric-only per that hook's own contract. Per the
// brief: Number() of the staged/seed string; NaN → null (never a calc input
// itself, purely identifies "is this cell's current text a number").
//
// ui-task-10f fix (Fix 2): an empty/whitespace-only cell must resolve to
// `null`, NOT `0` — `Number("")` is `0`, not `NaN`, so without this guard an
// empty (never-Saved) anchor cell silently identified as "a numeric 0" and
// bills-grid-page.tsx's ctrl-fill staged "0" into every dragged target.
function cellNumericValue(raw: string): number | null {
  if (raw == null || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isNaN(n) ? null : n;
}

/** Seed value for a unit-grain editable cell: the snapshotted entry field, or
 * (cleaning only, R7) the recurring auto-fill amount when nothing was ever
 * Saved. Auto-fill NEVER applies to any column other than cleaning — every
 * other field has no such recurring default in the DTO. `rental` is NOT
 * handled here (Task 6): it moved off `entry` onto `SubRow.rental` and is
 * now read-only, rendered via `LockedCell` in the render loop below instead
 * of through this editable-cell seed path. */
function seedValue(row: GridRow, columnId: ColumnId): string {
  const entry = row.entry;
  switch (columnId) {
    case "cleaningOwner":
    case "cleaningTenant":
      return cleaningSeed(row);
    case "tnbOwner":
      return entry?.tnbTotal ?? "";
    case "airOwner":
    case "airTenant":
      return entry?.airSelangor ?? "";
    case "wifiOwner":
    case "wifiTenant":
      return entry?.wifi ?? "";
    case "maintenanceFee":
      return entry?.maintenanceFee ?? "";
    default:
      return "";
  }
}

// ── read-only computed columns (tenant/owner expense totals) ────────────────

function readOnlyValue(row: GridRow, columnId: ColumnId): string {
  switch (columnId) {
    case "tenantExpWithSst":
      return row.expenses.tenant.withSstTotal;
    case "tenantExpNonSst":
      return subtractMoney(row.expenses.tenant.total, row.expenses.tenant.withSstTotal);
    case "ownerExpWithSst":
      return row.expenses.owner.withSstTotal;
    case "ownerExpNonSst":
      return subtractMoney(row.expenses.owner.total, row.expenses.owner.withSstTotal);
    case "ownerRecurring":
      return row.recurring?.owner.total ?? "0.00";
    case "tenantRecurring":
      return row.recurring?.tenant.total ?? "0.00";
    default:
      return "";
  }
}

// ── editable input cell ──────────────────────────────────────────────────────

/**
 * The "this line has been paid" marker: a green tick pinned to the cell's
 * bottom-right. Rendered INSIDE the <td> (which gains `relative`), so it rides
 * the cell box without touching layout — no extra column, no reflow, and the
 * value stays copyable/selectable exactly as before.
 *
 * `aria-hidden` on the glyph with a visually-hidden label alongside: a bare "✓"
 * announces as nothing useful, and the state must reach a screen reader as
 * words. `pointer-events-none` keeps the marker out of the cell's
 * click/drag/selection gestures — it is decoration over a live grid surface.
 */
function SettlementMarker({ state }: { state: PaintedSettlement }) {
  const paint = SETTLEMENT_PAINT[state];
  return (
    <span
      className={cn("pointer-events-none absolute bottom-0.5 right-0.5 leading-none", paint.tick)}
      data-testid={paint.testId}
    >
      <span aria-hidden="true" className="text-[11px]">{paint.glyph}</span>
      <span className="sr-only">{paint.label}</span>
    </span>
  );
}

/**
 * Corner "T" on a money cell whose cost is borne by the TENANT (2026-08-14, client request).
 *
 * Used by the single-column bands — TNB and Maintenance Fee — where there is no tenant-side
 * column to move the amount into, so the drawer's Owner/Tenant answer would otherwise be
 * invisible in the grid. {@link showsTenantBorneMark} owns WHICH columns qualify. AIR and
 * Cleaning/WiFi are deliberately unmarked: they own both columns, and the amount sitting
 * under one of them already carries the answer.
 *
 * Top-right by request, which also keeps it clear of {@link SettlementMarker} at
 * bottom-right, so a paid tenant-borne cell shows both without collision.
 */
/**
 * The mark answers the SAME question the Setting drawer asks — "who bears this cost" —
 * and nothing more. Deliberately not "recharged to the tenant": `isUtilityTenantBorne`
 * also covers the legacy `manager_advanced` ("KAEN advanced", setting-drawer.tsx:114),
 * where KAEN fronted the payment rather than the owner. Naming the MECHANISM would make
 * the grid assert something the drawer contradicts; naming the BEARER is true for every
 * value in the set, and needs no second per-value map to drift out of sync.
 */
const TENANT_BORNE_LABEL = "Borne by the tenant";

function TenantBorneMark() {
  // `title` lives on the CELL, not here: `pointer-events-none` makes this span
  // un-hit-testable, so a title attribute on it could never render a tooltip.
  // Sky rather than the brand gold — amber-600 is already the "partially paid" ◐ in
  // these same cells (SETTLEMENT_PAINT below), and a gold "T" a few millimetres from an
  // amber ◐ reads as the same family (money state) when it means something else.
  return (
    <span
      className="pointer-events-none absolute right-0.5 top-0.5 rounded-[3px] bg-sky-500/15 px-1 text-[9px] font-bold leading-[1.35] text-sky-700 dark:text-sky-300"
      data-testid="tenant-borne-mark"
    >
      <span aria-hidden="true">T</span>
      <span className="sr-only">{TENANT_BORNE_LABEL}</span>
    </span>
  );
}

/** Muted "settled" wash for a fully paid cell — greys the value without hiding it. */
const SETTLED_CELL_CLASS = "relative bg-emerald-50/60 text-muted-foreground dark:bg-emerald-950/20";
/** Amber counterpart for a PARTLY paid cell. Same shape as the paid wash so the two
 * read as one family (money in), distinguished by hue rather than by presence. */
const PARTIAL_CELL_CLASS = "relative bg-amber-50/60 text-muted-foreground dark:bg-amber-950/20";

/** The settlement states that PAINT a cell. "none"/"unpaid" render nothing, so they
 * are excluded from the paint table rather than mapped to a null everyone must
 * null-check. */
type PaintedSettlement = Extract<SettlementState, "partial" | "paid">;

/**
 * Per-state cell affordance: wash, tick colour, glyph and screen-reader label.
 *
 * Keyed as a `Record` over the painted states so adding a state to SettlementState
 * cannot silently fall through to "renders like unpaid" — the union widens and this
 * table stops compiling until the new state is answered.
 *
 * Colour is NOT the only channel: paid is "✓" and partial is "◐", so the two states
 * remain distinguishable without colour vision. Both carry an sr-only word too.
 */
const SETTLEMENT_PAINT: Record<
  PaintedSettlement,
  { wash: string; tick: string; glyph: string; label: string; testId: string }
> = {
  paid: {
    wash: SETTLED_CELL_CLASS,
    tick: "text-emerald-600 dark:text-emerald-400",
    glyph: "✓",
    label: "Paid",
    testId: "settled-tick",
  },
  partial: {
    wash: PARTIAL_CELL_CLASS,
    tick: "text-amber-600 dark:text-amber-400",
    glyph: "◐",
    label: "Partially paid",
    testId: "partial-tick",
  },
};

/** Narrow a raw settlement state to the painted subset ("none"/"unpaid" ⇒ undefined). */
function painted(state: SettlementState | undefined): PaintedSettlement | undefined {
  return state === "paid" || state === "partial" ? state : undefined;
}

function EditableCell({
  columnId,
  value,
  onChange,
  numeric,
  settlement,
  tenantBorne,
  onCellPointerDown,
  onCellPointerEnter,
  onCellPointerUp,
  selected,
  colour,
  active,
  onActivate,
  onContextMenu,
  onDoubleClick,
  registerCell,
}: {
  columnId: ColumnId;
  value: string;
  onChange: (value: string) => void;
  numeric?: boolean;
  /** Renders the corner {@link TenantBorneMark}. Display only — it never gates editing. */
  tenantBorne?: boolean;
  /** Server-derived payment state of the live grid charges behind this column.
   * Purely a visual: whether the cell is editable is decided by the ROW lock
   * (row-lock.ts) + the backend paid-freeze, never by this marker. In practice a
   * painted cell is now almost always inside a locked row — a row with any money
   * against it locks entirely — so this renders as an EditableCell only on an
   * unbilled row. */
  settlement?: PaintedSettlement;
  // ui-task-10e: all optional — absent ⇒ no listener attached, no selection
  // marker, no background colour (Task-3/ui-10b parity when the page shell
  // doesn't pass them).
  onCellPointerDown?: (e: React.PointerEvent<HTMLTableCellElement>) => void;
  onCellPointerEnter?: () => void;
  onCellPointerUp?: () => void;
  selected?: boolean;
  colour?: string;
  // P4 Task 3: active-cell nav. All optional — absent ⇒ no marker, no click
  // handler, no node registration (parity). `registerCell` targets the
  // <input> (focus lands there for editable cells).
  // Task 3 (mouse-selection V2): onActivate now receives the click event so a
  // shift/ctrl click can carry its modifiers up to onCellActivate.
  active?: boolean;
  onActivate?: (e: React.MouseEvent) => void;
  // Excel-Web V2: right-click (context menu) + double-click (enter edit mode).
  // Both optional ⇒ parity when the page doesn't opt in.
  onContextMenu?: (e: React.MouseEvent) => void;
  onDoubleClick?: () => void;
  registerCell?: (node: HTMLElement | null) => void;
}) {
  // R31 (D11, "amount cells accept no formula"): a numeric cell rejects a
  // FORMULA (leading "=") right here, before it ever reaches the
  // staged-edit buffer — reusing parseAmountCell (cell-parser.ts, ui-4), the
  // same gate expenses-dialog.tsx applies at submit-time. This does NOT
  // hand-roll a stricter "amounts only" rule: partial/in-progress numeric
  // input ("", "-", "1.", "1.5", "0") is never blocked — only a value that
  // STARTS WITH "=" triggers the reject, so normal typing is unaffected.
  // Money stays server-guarded regardless (Save never trusts client input);
  // this only adds the missing inline feedback.
  const [amountError, setAmountError] = useState<string | null>(null);

  function handleChange(next: string) {
    if (numeric && next.trim().startsWith("=")) {
      const parsed = parseAmountCell(next);
      setAmountError(parsed.ok ? null : parsed.message);
      return; // rejected — NOT staged
    }
    setAmountError(null);
    onChange(next);
  }

  // P4 Task 5 (R2, type-to-edit): keep a LOCAL ref to the <input> alongside the
  // page's `registerCell` node registry. The callback ref below fans out to BOTH
  // so the page focus effect (which .focus()es this node) and the select-on-
  // activate effect (which .select()s its text) each get the same element —
  // they COEXIST (Hard Point A): the page focuses, EditableCell selects.
  const inputRef = useRef<HTMLInputElement | null>(null);
  const setInputRef = useCallback(
    (node: HTMLInputElement | null) => {
      inputRef.current = node;
      registerCell?.(node);
    },
    [registerCell],
  );

  // On activation, select the input's full text so the FIRST keystroke REPLACES
  // the saved value (Excel type-to-edit) instead of appending. Runs on the
  // `active` edge; the page's focus effect (nav.active change) focuses the node,
  // and this selects its text — order-independent since selecting text does not
  // require prior focus in jsdom/DOM (calling .select() also focuses). Guarded
  // on `active` so a non-active editable cell is never disturbed (parity).
  useEffect(() => {
    if (active) inputRef.current?.select();
  }, [active]);

  return (
    <td
      className={cn(
        "px-2 py-1.5 text-sm text-[var(--text-primary)]",
        numeric && "text-right",
        // Task 3 (mouse-selection V2): the in-range visual is a light --primary
        // TINT FILL — a rectangle of tinted cells reads as one continuous block
        // (the old ring-inset outlined every cell individually, breaking the
        // Excel-style contiguous look). Still gated on `!active`: the active
        // cell keeps its distinct OUTSET ring below and never also paints the
        // tint (so the active cell inside a range stays unambiguous). V2: bumped
        // to /15 so the block reads clearly now that the competing native
        // text-selection (the gold ::selection) is suppressed on the grid.
        selected && !active && "bg-[var(--primary)]/15",
        // P4 Task 4/6: the active cell reads as a strong SOLID --primary border
        // (Excel active-cell look) — non-inset/outset, high-contrast and, per
        // Fix 1 above, always distinct from the inset --primary selection ring
        // (the selection ring is suppressed on the active cell). active wins the
        // outline whether or not the cell is also in the range.
        active && "ring-2 ring-[var(--primary)]",
        // Settled wash sits BELOW selection/active in the class order above, so a
        // paid cell that is also selected still reads as selected — payment state
        // must never swallow the gesture feedback the admin is driving.
        settlement && SETTLEMENT_PAINT[settlement].wash,
        // The corner mark is absolutely positioned; without a positioned ancestor it
        // would escape to the nearest one and land on the wrong cell. The settlement
        // washes already carry `relative`, so this only adds it when they don't.
        tenantBorne && "relative",
      )}
      style={colour ? { backgroundColor: colour } : undefined}
      data-testid={`cell-${columnId}`}
      // The mark's tooltip: the cell is the hoverable element (the mark itself is
      // pointer-events-none, so a title there would never fire).
      title={tenantBorne ? TENANT_BORNE_LABEL : undefined}
      // `data-settled` stays PAID-ONLY (it is what "this line is done" means to
      // every existing reader); `data-settlement` carries the finer state.
      data-settled={settlement === "paid" ? "true" : undefined}
      data-settlement={settlement}
      data-selected={selected ? "true" : undefined}
      data-active={active ? "true" : undefined}
      onPointerDown={onCellPointerDown}
      onPointerEnter={onCellPointerEnter}
      onPointerUp={onCellPointerUp}
      onClick={(e) => onActivate?.(e)}
      onContextMenu={onContextMenu}
      // Excel-Web V2: double-click enters edit mode with the caret at the click
      // point. preventDefault suppresses the browser's native word/text
      // selection; the page flips edit mode so arrows now move the caret.
      onDoubleClick={
        onDoubleClick
          ? (e) => {
              e.preventDefault();
              inputRef.current?.focus();
              onDoubleClick();
            }
          : undefined
      }
    >
      <input
        ref={setInputRef}
        type="text"
        inputMode="decimal"
        value={value}
        onChange={(e) => handleChange(e.target.value)}
        title={amountError ?? undefined}
        aria-invalid={amountError ? true : undefined}
        // Excel-Web V2: the grid surface sets `user-select:none` to kill native
        // text selection during cell gestures; the input re-enables it
        // (`select-text`) so in-cell caret + text selection works while editing.
        // `selection:` recolours the in-field highlight to the --primary tint so
        // it never reads as the old gold ::selection (the reported "yellow").
        className={cn(
          "w-24 select-text rounded-md border border-[var(--input-border)] bg-[var(--card-bg)] px-2 py-1 text-sm text-[var(--text-primary)] outline-none transition selection:bg-[var(--primary)]/25 focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)]",
          numeric && "text-right",
          amountError && "border-rose-500 focus:ring-rose-400",
        )}
      />
      {amountError && (
        <span className="mt-0.5 block text-[10px] leading-tight text-rose-600" data-testid={`amount-error-${columnId}`}>
          {amountError}
        </span>
      )}
      {settlement && <SettlementMarker state={settlement} />}
      {tenantBorne && <TenantBorneMark />}
    </td>
  );
}

function LockedCell({
  columnId,
  display,
  numeric,
  settlement,
  tenantBorne,
  active,
  selected,
  onCellPointerDown,
  onCellPointerEnter,
  onCellPointerUp,
  onActivate,
  onContextMenu,
  registerCell,
}: {
  columnId: ColumnId;
  display: string;
  numeric?: boolean;
  /** Server-derived payment state of the live grid charges behind this column. Visual only. */
  settlement?: PaintedSettlement;
  /** Renders the corner {@link TenantBorneMark}. A billed row is read-only but still
   *  carries the setting it was billed under, so the answer must not vanish here. */
  tenantBorne?: boolean;
  // P4 Task 3: active-cell nav for read-only value-bearing cells (billed
  // cells, `amount`, unit-row `rental`). All optional — absent ⇒ parity. The
  // <td> is the registered/focused node (no input); tabIndex=-1 makes the
  // page focus effect's .focus() land on it.
  // Task 3: onActivate receives the click event so a shift/ctrl click carries
  // its modifiers up to onCellActivate.
  active?: boolean;
  // Excel-Web V2: a read-only cell inside the selected range now paints the
  // same --primary tint as editable cells, so a range spanning read-only cells
  // (amount / billed / rental) reads as ONE solid block. onContextMenu wires the
  // custom right-click menu. Both optional ⇒ parity.
  selected?: boolean;
  // Selection (drag start/grow/end) is orthogonal to editing — a read-only cell
  // is selectable/copyable but not editable. Same handler types as EditableCell.
  onCellPointerDown?: (e: React.PointerEvent<HTMLTableCellElement>) => void;
  onCellPointerEnter?: () => void;
  onCellPointerUp?: () => void;
  onActivate?: (e: React.MouseEvent) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  registerCell?: (node: HTMLElement | null) => void;
}) {
  return (
    <td
      ref={registerCell}
      className={cn(
        "px-2 py-1.5 text-sm text-muted-foreground",
        numeric && "text-right",
        // V2: one bg utility via ternary (no Tailwind bg conflict) — the
        // selection tint when in-range-and-not-active, else the muted lock bg.
        selected && !active ? "bg-[var(--primary)]/15" : "bg-muted/60",
        // P4 Task 4: visible SOLID --primary active ring (non-inset), matching
        // EditableCell — see its comment for the visibility rationale.
        active && "ring-2 ring-[var(--primary)]",
        // Settlement wash last so it overrides the default muted lock bg — but a
        // SELECTED cell keeps the selection tint (the ternary above already won
        // the bg slot, and this only repaints when not selected).
        //
        // This is the branch that answers "locked but GREEN, not grey": a paid cell
        // inside a now-locked row renders here, and the emerald wash beats the
        // `bg-muted/60` lock default, so locking a paid row does not turn it grey.
        settlement && !selected && SETTLEMENT_PAINT[settlement].wash,
        settlement && selected && "relative",
        // See EditableCell: the corner mark needs a positioned ancestor of its own.
        tenantBorne && "relative",
      )}
      data-testid={`cell-${columnId}`}
      // See EditableCell: the mark is pointer-events-none, so the cell owns the tooltip.
      title={tenantBorne ? TENANT_BORNE_LABEL : undefined}
      data-settled={settlement === "paid" ? "true" : undefined}
      data-settlement={settlement}
      data-active={active ? "true" : undefined}
      data-selected={selected ? "true" : undefined}
      data-copy-value={display}
      aria-readonly="true"
      tabIndex={registerCell ? -1 : undefined}
      onPointerDown={onCellPointerDown}
      onPointerEnter={onCellPointerEnter}
      onPointerUp={onCellPointerUp}
      onClick={(e) => onActivate?.(e)}
      onContextMenu={onContextMenu}
    >
      {display}
      {settlement && <SettlementMarker state={settlement} />}
      {tenantBorne && <TenantBorneMark />}
    </td>
  );
}

function ReadOnlyCell({
  columnId,
  display,
  numeric,
  settlement,
  onView,
  viewLabel,
  viewTestId,
  badgeCount,
  active,
  selected,
  onCellPointerDown,
  onCellPointerEnter,
  onCellPointerUp,
  onActivate,
  onContextMenu,
  registerCell,
}: {
  columnId: ColumnId;
  display: string;
  numeric?: boolean;
  /** Server-derived payment state of the live grid charges behind this column. Visual only. */
  settlement?: PaintedSettlement;
  onView?: () => void;
  viewLabel?: string;
  viewTestId?: string;
  badgeCount?: number;
  // P4 Task 3: active-cell nav for the read-only expense totals. All optional
  // — absent ⇒ parity. The <td> is the registered/focused node; the inner
  // eye-Button (onView) keeps its own onClick and stops propagation so
  // opening the expense drawer never also fires activate.
  // Task 3: onActivate receives the click event so a shift/ctrl click carries
  // its modifiers up to onCellActivate.
  active?: boolean;
  // Excel-Web V2: selection tint + custom right-click menu (see LockedCell).
  selected?: boolean;
  // Selection is orthogonal to editing (see LockedCell): the read-only expense/
  // recurring totals are selectable + copyable, never editable.
  onCellPointerDown?: (e: React.PointerEvent<HTMLTableCellElement>) => void;
  onCellPointerEnter?: () => void;
  onCellPointerUp?: () => void;
  onActivate?: (e: React.MouseEvent) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  registerCell?: (node: HTMLElement | null) => void;
}) {
  return (
    <td
      ref={registerCell}
      className={cn(
        "px-2 py-1.5 text-sm text-[var(--text-primary)]",
        numeric && "text-right",
        // V2: selection tint when in-range-and-not-active (see LockedCell).
        selected && !active && "bg-[var(--primary)]/15",
        // P4 Task 4: visible SOLID --primary active ring (non-inset), matching
        // EditableCell — see its comment for the visibility rationale.
        active && "ring-2 ring-[var(--primary)]",
        // Settlement wash — after selection/active so it never swallows their feedback.
        settlement && SETTLEMENT_PAINT[settlement].wash,
      )}
      data-testid={`cell-${columnId}`}
      data-settled={settlement === "paid" ? "true" : undefined}
      data-settlement={settlement}
      data-active={active ? "true" : undefined}
      data-selected={selected ? "true" : undefined}
      data-copy-value={display}
      tabIndex={registerCell ? -1 : undefined}
      onPointerDown={onCellPointerDown}
      onPointerEnter={onCellPointerEnter}
      onPointerUp={onCellPointerUp}
      onClick={(e) => onActivate?.(e)}
      onContextMenu={onContextMenu}
    >
      {onView ? (
        <div className={cn("flex items-center gap-1", numeric && "justify-end")}>
          <span>{display}</span>
          <span className="relative inline-flex">
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={viewLabel}
              data-testid={viewTestId}
              // When the cell is nav-wired (onActivate present), stop the click
              // from ALSO bubbling to the <td>'s onActivate — opening the
              // expense drawer must not also move the active cell. Parity: when
              // onActivate is absent this is exactly the old `onClick={onView}`.
              onClick={onActivate ? (e) => { e.stopPropagation(); onView?.(); } : onView}
              className="text-muted-foreground hover:text-foreground"
            >
              <Eye />
            </Button>
            {badgeCount != null && <CountBadge count={badgeCount} testId={`${viewTestId}-badge`} />}
          </span>
        </div>
      ) : (
        display
      )}
      {settlement && <SettlementMarker state={settlement} />}
    </td>
  );
}

// ── GridTable ─────────────────────────────────────────────────────────────

export function GridTable({
  rows,
  columns,
  onCellEdit,
  onOpenSettings,
  onViewExpenses,
  onViewRecurring,
  onOpenAttachments,
  onCellPointerDown,
  onCellPointerEnter,
  onCellPointerUp,
  isCellSelected,
  cellColour,
  isCellActive,
  onCellActivate,
  onCellContextMenu,
  onCellDoubleClick,
  onSelectColumns,
  registerCell,
  staged,
  registerClearInternalStaged,
  billableApartmentIds,
  selectedForBill,
  allBillableSelected,
  someBillableSelected,
  onToggleBillSelection,
  onToggleSelectAllForBill,
  showVacant,
}: GridTableProps) {
  const bandGroups = groupBands(columns);
  const dataColumns = columns.filter((c) => c.band); // everything except unitCode

  // Per-cell keystroke-echo buffer: `${cellKey}:${columnId}` -> user-TYPED
  // value. This is GridTable's own internal state, kept separate from the
  // `staged` PROP (the page's useStagedEdits buffer) so a real keystroke
  // always repaints instantly with no page round-trip (R7).
  const [internalStaged, setInternalStaged] = useState<Record<string, string>>({});

  function stageEdit(cellKey: string, columnId: ColumnId, value: string) {
    setInternalStaged((prev) => ({ ...prev, [`${cellKey}:${columnId}`]: value }));
    onCellEdit?.(cellKey, columnId, value);
  }

  // P4 Task 5 (Esc-revert, Hard Point B): expose a stable imperative clear of the
  // internalStaged echo to the page, registered once on mount (like registerCell).
  // Removing the key drops the top-precedence echo so stagedOrSeed falls back to
  // the page buffer (also being unstaged by the page) or the seed — the input
  // then repaints its saved value. Deleting an absent key is a safe no-op.
  const clearInternalStaged = useCallback((cellKey: string, columnId: string) => {
    setInternalStaged((prev) => {
      const key = `${cellKey}:${columnId}`;
      if (!Object.prototype.hasOwnProperty.call(prev, key)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);
  useEffect(() => {
    registerClearInternalStaged?.(clearInternalStaged);
  }, [registerClearInternalStaged, clearInternalStaged]);

  // ui-task-10g: display precedence is (1) a real keystroke echo — internal,
  // instant, no page round-trip — (2) else the page's OWN staged buffer (the
  // `staged` prop — surfaces ctrl-fill writes and ui-9 crash-recovery, both of
  // which stage directly into the PAGE buffer and never touch
  // `internalStaged`) — (3) else the seed. `staged` is OPTIONAL: when absent,
  // step 2 is skipped entirely — byte-identical to before this task.
  function stagedOrSeed(cellKey: string, columnId: ColumnId, seed: string): string {
    const key = `${cellKey}:${columnId}`;
    if (Object.prototype.hasOwnProperty.call(internalStaged, key)) return internalStaged[key];
    if (staged && Object.prototype.hasOwnProperty.call(staged, key)) return staged[key];
    return seed;
  }

  // Final-review Finding 1: distinguishes "seeded/as-saved" from
  // "staged/being-edited" — same two sources `stagedOrSeed` consults, but
  // WITHOUT the seed fallback. Used by the Amount cell to decide whether to
  // show the stored server snapshot (no staged edit on this row's
  // previousKwh/currentKwh) or the live re-priced preview (admin is actively
  // editing). A staged empty string ("" — user cleared the field) still
  // counts as staged: hasOwnProperty is true, so amountPreview correctly
  // falls back to the stored amount via its own NaN guard rather than this
  // helper masking the edit.
  function isStaged(cellKey: string, columnId: ColumnId): boolean {
    const key = `${cellKey}:${columnId}`;
    if (Object.prototype.hasOwnProperty.call(internalStaged, key)) return true;
    if (staged && Object.prototype.hasOwnProperty.call(staged, key)) return true;
    return false;
  }

  return (
    // Task 11 (R4b): NOT <TableWrap> (components/ui.tsx, frozen/shared with
    // other tables) — same visual classes (rounded border), but WITHOUT its
    // own overflow-x-auto. TableWrap's overflow-x-auto forces the browser to
    // also compute overflow-y:auto on it (the standard CSS overflow-x/
    // overflow-y coupling — an axis left "visible" is bumped to "auto" once
    // the other axis is non-visible), which makes TableWrap — not the page's
    // bounded/scrollable grid-region — the nearest ancestor scroll container
    // for position:sticky. TableWrap itself never gets a height constraint
    // of its own, so it never actually scrolls vertically, leaving a sticky
    // top-* header inert against it (empirically verified: the header moved
    // by the full scroll delta, i.e. did not stick, with TableWrap's
    // overflow-x-auto present in the ancestor chain; dropping it here — and
    // letting grid-region own scrolling on both axes directly — settles the
    // header at exactly the scrollport boundary instead, confirming a real
    // pin). Horizontal Unit-column pin is unaffected: grid-region already
    // carries overflow-x-auto unconditionally, so it correctly absorbs the
    // table's horizontal overflow that TableWrap no longer claims.
    // Excel-Web V2: `select-none` on the grid surface kills the browser's native
    // text selection for EVERY pointer gesture (drag/shift/ctrl/double-click) —
    // the reported gold ::selection "yellow highlight" and every other
    // native-selection conflict. The active cell's <input> re-enables it
    // (`select-text`, see EditableCell) so in-cell editing keeps a working caret
    // and text selection.
    <div className="select-none rounded-lg border border-[var(--border)]">
      <DataTable>
        <TableHead>
          <tr>
            <th rowSpan={2} className="sticky left-0 top-0 z-30 bg-[var(--page-bg)] min-w-[13rem] px-4 py-3 text-left font-semibold align-bottom">
              <div className="flex items-center gap-2">
                {/* Select-all: checks every BILLABLE unit at once (indeterminate
                    when only some are). §15 bulk-selection — toggles the visible
                    billable set only, never a silent full-filter select. Disabled
                    when nothing is billable. Absent unless the page wires Bill
                    selection (parity for GridTable-only tests). */}
                {onToggleSelectAllForBill && (
                  <Checkbox
                    aria-label="Select all billable units for billing"
                    data-testid="bill-select-all"
                    checked={!!allBillableSelected}
                    indeterminate={!!someBillableSelected}
                    disabled={!billableApartmentIds || billableApartmentIds.size === 0}
                    onCheckedChange={() => onToggleSelectAllForBill()}
                  />
                )}
                <span>Unit</span>
              </div>
            </th>
            {bandGroups.map((g) => (
              <th
                key={g.band}
                colSpan={g.columns.length}
                data-testid="band-header"
                // Excel-Web V2: a band header selects EVERY sub-column under it
                // (all rows). cursor-pointer + hover cue when interactive.
                onClick={onSelectColumns ? (e) => onSelectColumns(g.columns.map((c) => c.id), resolveClickMods(e)) : undefined}
                title={onSelectColumns ? `Select all ${g.band} columns` : undefined}
                className={cn(
                  "sticky top-0 z-20 h-9 bg-[var(--page-bg)] px-4 py-2 text-center font-semibold border-l border-[var(--border)]",
                  onSelectColumns && "cursor-pointer transition hover:bg-[var(--primary)]/10",
                )}
              >
                {g.band}
              </th>
            ))}
          </tr>
          <tr>
            {dataColumns.map((c) => (
              <th
                key={c.id}
                data-testid={`col-header-${c.id}`}
                // Excel-Web V2: a sub-column header selects that ONE column (all rows).
                onClick={onSelectColumns ? (e) => onSelectColumns([c.id], resolveClickMods(e)) : undefined}
                title={onSelectColumns ? "Select column" : undefined}
                className={cn(
                  "sticky top-9 z-20 bg-[var(--page-bg)] px-2 py-2 font-medium border-l border-[var(--border)]",
                  c.numeric && "text-right",
                  onSelectColumns && "cursor-pointer transition hover:bg-[var(--primary)]/10",
                )}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </TableHead>
        <tbody>
          {rows.length === 0 && <EmptyRow colSpan={columns.length} label="No apartments for this period." />}
          {rows.map((row) => (
            <GridUnitRowGroup
              key={row.apartmentId}
              row={row}
              dataColumns={dataColumns}
              stagedOrSeed={stagedOrSeed}
              isStaged={isStaged}
              stageEdit={stageEdit}
              onOpenSettings={onOpenSettings}
              onViewExpenses={onViewExpenses}
              onViewRecurring={onViewRecurring}
              onOpenAttachments={onOpenAttachments}
              onCellPointerDown={onCellPointerDown}
              onCellPointerEnter={onCellPointerEnter}
              onCellPointerUp={onCellPointerUp}
              isCellSelected={isCellSelected}
              cellColour={cellColour}
              isCellActive={isCellActive}
              onCellActivate={onCellActivate}
              onCellContextMenu={onCellContextMenu}
              onCellDoubleClick={onCellDoubleClick}
              registerCell={registerCell}
              selectableForBill={!!billableApartmentIds?.has(row.apartmentId)}
              selectedForBill={!!selectedForBill?.has(row.apartmentId)}
              onToggleBillSelection={onToggleBillSelection}
              showVacant={showVacant}
            />
          ))}
        </tbody>
      </DataTable>
    </div>
  );
}

// ── one apartment's row(s): unit row + optional nested tenant sub-rows + prior strip ──

function GridUnitRowGroup({
  row,
  dataColumns,
  stagedOrSeed,
  isStaged,
  stageEdit,
  onOpenSettings,
  onViewExpenses,
  onViewRecurring,
  onOpenAttachments,
  onCellPointerDown,
  onCellPointerEnter,
  onCellPointerUp,
  isCellSelected,
  cellColour,
  isCellActive,
  onCellActivate,
  onCellContextMenu,
  onCellDoubleClick,
  registerCell,
  selectableForBill,
  selectedForBill,
  onToggleBillSelection,
  showVacant,
}: {
  row: GridRow;
  dataColumns: GridColumn[];
  stagedOrSeed: (cellKey: string, columnId: ColumnId, seed: string) => string;
  isStaged: (cellKey: string, columnId: ColumnId) => boolean;
  stageEdit: (cellKey: string, columnId: ColumnId, value: string) => void;
  onOpenSettings?: (apartmentId: string) => void;
  onViewExpenses?: (apartmentId: string, bearer: ExpenseBearer) => void;
  onViewRecurring?: (apartmentId: string, bearer: RecurringBearer) => void;
  onOpenAttachments?: (apartmentId: string) => void;
  onCellPointerDown?: (cell: SelectionCell, mods: { shift: boolean; ctrl: boolean }) => void;
  onCellPointerEnter?: (cell: SelectionCell) => void;
  onCellPointerUp?: () => void;
  isCellSelected?: (cellKey: string, columnId: ColumnId) => boolean;
  cellColour?: (cellKey: string, columnId: ColumnId) => string | undefined;
  isCellActive?: (cellKey: string, columnId: ColumnId) => boolean;
  onCellActivate?: (cellKey: string, columnId: ColumnId, mods: { shift: boolean; ctrl: boolean }) => void;
  onCellContextMenu?: (cell: { cellKey: string; columnId: ColumnId }, e: React.MouseEvent) => void;
  onCellDoubleClick?: (cellKey: string, columnId: ColumnId) => void;
  registerCell?: (cellKey: string, columnId: ColumnId, node: HTMLElement | null) => void;
  // Per-unit Bill selection (see GridTableProps). `selectableForBill` = this row
  // is billable (a checkbox renders); `selectedForBill` = it's checked.
  selectableForBill?: boolean;
  selectedForBill?: boolean;
  onToggleBillSelection?: (apartmentId: string) => void;
  showVacant?: boolean;
}) {
  // R2/R3 (Task 6 re-base): grain-lock is now server-derived via
  // `row.isWholeUnit` (Apartment.listingMode === "WHOLE") — a partitioned
  // apartment nests its readings as tenant-sub-rows; a whole-unit tenancy
  // shows its single reading inline and renders zero nested rows. Replaces
  // the old `subRows.length > 1 || entry.rental == null` heuristic now that
  // entry.rental no longer exists. MUST stay byte-identical to export-xlsx.ts's
  // own `hasNestedSubRows` — a mismatch breaks inline-vs-nested rendering
  // parity between the table and the export.
  const hasNestedSubRows = !row.isWholeUnit;
  const inlineSubRow: GridSubRow | undefined = !hasNestedSubRows ? row.subRows[0] : undefined;
  // Vacant-room fix: a partitioned unit's vacant, dataless rooms are dropped from
  // BOTH the occupancy count and the rendered sub-rows when the page's "show vacant"
  // toggle is off. `showVacant === undefined` (GridTable-only tests that don't wire
  // the toggle) resolves to `true` ⇒ no filtering (byte-parity). Whole units are
  // unaffected — their single reading renders inline, never as a nested room.
  const roomsToRender = visibleSubRows(row.subRows, showVacant ?? true);
  // Task 7 (R2), grammar fix Task 11 — a single occupancy tag on the unit
  // row: "N rooms" (plural) / "1 room" (singular) / "Vacant" (zero rooms,
  // never "0 rooms") for a partitioned apartment, "Whole unit · {tenant}"
  // (or bare "Whole unit" when vacant) for a whole-unit tenancy. Display-only.
  const roomCount = roomsToRender.length;
  const occupancyTag = hasNestedSubRows
    ? roomCount === 0
      ? "Vacant"
      : roomCount === 1
        ? "1 room"
        : `${roomCount} rooms`
    : `Whole unit${inlineSubRow?.partyName ? ` · ${inlineSubRow.partyName}` : ""}`;
  // The row's payment badge. Once the unit-month carries live grid charges, the
  // DERIVED settlement is what shows: the stored `paymentStatus` column is set by hand
  // and is deliberately never advanced by a Bill or a payment, so a tenant who has paid
  // in full still leaves it reading "unpaid" — which is the bug this replaces.
  //
  // `status === "none"` means nothing is billed yet (no live charges), and there the
  // manual column is still the only thing anyone has said about this row, so it is shown
  // unchanged — byte-parity for every un-billed row.
  //
  // "partial" covers BOTH "some of it is paid" and "the tenant paid but the owner has
  // not": the roll-up spans tenant AND owner charges on purpose, so outstanding owner
  // money can never hide behind a green "Paid".
  const settled = row.settlement;
  const isDerived = settled != null && settled.status !== "none";
  const settlementLabel = isDerived
    ? settled.status === "paid"
      ? "Paid"
      : settled.status === "partial"
        ? "Partially paid"
        : "Unpaid"
    : row.paymentStatus;
  const settlementTone = isDerived
    ? (ENTRY_STATUS_TONES[settled.status] ?? "slate")
    : (ENTRY_STATUS_TONES[row.paymentStatus] ?? "slate");
  // Review Minor #5: a billed row's editable inputs are misleading — the page
  // already drops billed edits at the buffer, so the visual must show
  // read-only truthfully. `!= null` catches both null AND undefined, so
  // Task-3 fixtures without `billedAt` are UNAFFECTED (isLocked stays false).
  //
  // The lock predicate now lives in ONE place (row-lock.ts) instead of being
  // hand-copied here, in nav-cells.ts and in bills-grid-page.tsx. It also reads
  // real payment state rather than the manual `paymentStatus` column, so a row
  // with ANY money against it — partial or full — renders read-only, matching
  // the server freeze instead of offering an edit that Save would reject. See
  // row-lock.ts for the full rationale.
  const isLocked = isRowLocked(row);
  // Cell-grain (R6): partial re-Bill means paying the electricity no longer freezes the
  // WiFi, so the row lock is now coarser than the money it represents. `isCellLocked`
  // starts from `isLocked` and can only ever UNLOCK a cell whose own bucket is unpaid —
  // it never opens a cell the row lock kept shut.
  const cellLocked = (columnId: ColumnId) => isCellLocked(row, columnId);

  // Re-Bill tag authority: `billRevision > 0` means this live unit-month has
  // actually been re-Billed (superseded + reissued at least once). The FIRST
  // Bill leaves billRevision at 0, so a fresh bill never shows the Re-Bill tag
  // (bug: it used to, keyed on the ambiguous `billedAt != null`, which is set on
  // BOTH the first Bill and a re-Bill). Billed vs Re-Billed are mutually
  // exclusive below — a re-Billed row shows Re-Billed only, never both.
  const isReBilled = (row.billRevision ?? 0) > 0;

  // ui-task-10e: builds the pointer/selection/colour props for one editable
  // cell (unit-grain, inline subRow, or nested sub-row — all three sites
  // share this). Every field is `undefined` when its corresponding GridTable
  // prop is absent, so EditableCell attaches no listener/marker/colour —
  // parity with Task-3/ui-10b when the page shell doesn't opt in.
  /**
   * The payment state of the live grid charges behind this cell — drives the wash +
   * tick. Folded into the two prop-builders below (rather than passed at each of the
   * ~16 cell call sites) so a newly-added cell cannot silently miss it.
   *
   * A sub-row cell's `cellKey` IS the room's listingId, so the room-grain state is
   * preferred where one exists; unit-grain keys (apartmentId) never appear in `rooms`
   * and fall through to the unit roll-up.
   *
   * "partial" now PAINTS (amber "◐") where it previously rendered as nothing. The old
   * rule — only "paid" marks, because a half-settled line must not read as done — was
   * right that partial ≠ done, but it expressed that by making partial
   * indistinguishable from NOTHING PAID, which is the more misleading of the two. A
   * distinct hue and glyph says "money in, not finished" without ever reading as done.
   */
  function cellSettlement(cellKey: string, columnId: ColumnId): PaintedSettlement | undefined {
    const bucket = SETTLEMENT_BUCKET_OF_COLUMN[columnId];
    if (!bucket || !row.settlement) return undefined;
    return painted(row.settlement.rooms?.[cellKey]?.[bucket] ?? row.settlement.cells[bucket]);
  }

  function editableCellProps(cellKey: string, columnId: ColumnId, rawValue: string) {
    const selCell: SelectionCell = { cellKey, columnId, value: cellNumericValue(rawValue) };
    return {
      settlement: cellSettlement(cellKey, columnId),
      // Excel-Web V2: resolve the raw pointerdown ONCE, platform-aware. Only a
      // primary-button "select" gesture starts cell selection — a right-click
      // (or macOS Ctrl-click) resolves to "context" and MUST NOT start a
      // left-drag/collapse (the context menu owns it via onContextMenu below);
      // a middle-click resolves to "ignore". `mods.ctrl` is the platform
      // multi-select key (Cmd on macOS, Ctrl elsewhere); Alt is ignored.
      onCellPointerDown: onCellPointerDown
        ? (e: React.PointerEvent<HTMLTableCellElement>) => {
            const g = resolvePointerGesture(e);
            if (g.kind === "select") onCellPointerDown(selCell, g.mods);
          }
        : undefined,
      onCellPointerEnter: onCellPointerEnter ? () => onCellPointerEnter(selCell) : undefined,
      onCellPointerUp,
      selected: isCellSelected?.(cellKey, columnId),
      colour: cellColour?.(cellKey, columnId),
      active: isCellActive?.(cellKey, columnId),
      // Task 3 (V2): activate carries the click's modifiers (platform-aware) so a
      // shift/ctrl click extends/toggles the selection instead of collapsing it.
      onActivate: onCellActivate
        ? (e: React.MouseEvent) => onCellActivate(cellKey, columnId, resolveClickMods(e))
        : undefined,
      onContextMenu: onCellContextMenu ? (e: React.MouseEvent) => onCellContextMenu({ cellKey, columnId }, e) : undefined,
      onDoubleClick: onCellDoubleClick ? () => onCellDoubleClick(cellKey, columnId) : undefined,
      registerCell: registerCell ? (node: HTMLElement | null) => registerCell(cellKey, columnId, node) : undefined,
    };
  }

  // P4 Task 3 (extended): selection props for the read-only navigable cells
  // (LockedCell / ReadOnlyCell / the raw sub-row rental <td>). Selection is
  // ORTHOGONAL to editing: a read-only price/rental/expense/amount cell can't be
  // EDITED, but it must be SELECTABLE + summable + copyable, so it now carries the
  // SAME pointer-selection wiring as an editable cell (drag start/grow/end +
  // shift/ctrl click). What stays editable-only is EDITING itself — no `<input>`,
  // no `onDoubleClick`→beginEdit, no colour-fill. Money-safe: the sole write
  // consumer of `sel.range`, `onDelete`, no-ops read-only cells (bills-grid-page
  // onDelete step 5). Every field is `undefined` when its GridTable prop is absent
  // ⇒ parity. The selCell carries identities only (no `value`) — the page enriches
  // each committed cell's numeric value from the DOM (readCellDisplayString).
  function readOnlyCellProps(cellKey: string, columnId: ColumnId) {
    const selCell: SelectionCell = { cellKey, columnId };
    return {
      settlement: cellSettlement(cellKey, columnId),
      // Same platform-aware gesture resolution as editableCellProps: only a
      // primary-button "select" starts a drag; right-click resolves to "context".
      onCellPointerDown: onCellPointerDown
        ? (e: React.PointerEvent<HTMLTableCellElement>) => {
            const g = resolvePointerGesture(e);
            if (g.kind === "select") onCellPointerDown(selCell, g.mods);
          }
        : undefined,
      onCellPointerEnter: onCellPointerEnter ? () => onCellPointerEnter(selCell) : undefined,
      onCellPointerUp,
      active: isCellActive?.(cellKey, columnId),
      // Excel-Web V2: read-only navigable cells paint the same selection tint, so a
      // range that spans them reads as one solid block.
      selected: isCellSelected?.(cellKey, columnId),
      // Task 3 (V2): carry the click's modifiers (platform-aware) up to
      // onCellActivate (same as the editable path) so a shift/ctrl click on a
      // read-only navigable cell extends/toggles the selection.
      onActivate: onCellActivate
        ? (e: React.MouseEvent) => onCellActivate(cellKey, columnId, resolveClickMods(e))
        : undefined,
      onContextMenu: onCellContextMenu ? (e: React.MouseEvent) => onCellContextMenu({ cellKey, columnId }, e) : undefined,
      registerCell: registerCell ? (node: HTMLElement | null) => registerCell(cellKey, columnId, node) : undefined,
    };
  }

  return (
    <Fragment>
      <tr className="border-b border-[var(--border)] transition hover:bg-[var(--page-bg)]">
        <td className="sticky left-0 z-10 bg-[var(--page-bg)] px-4 py-3 text-sm text-[var(--text-primary)] align-top">
          {/* Identity line — the primary scan target. The unit code must read
              on ONE line: `whitespace-nowrap` stops the browser breaking a
              hyphenated code (e.g. "A-08-02") at each "-", and `shrink-0` stops
              it being squeezed when the sticky column is tight. Status pill sits
              beside it; row actions cluster to the right via `ml-auto`. */}
          <div className="flex items-center gap-2">
            {/* Per-unit Bill selection — only billable rows (saved, not yet
                billed) render a checkbox. Billing a checked unit issues ALL its
                tenants' invoices + the owner invoice in one backend op. */}
            {onToggleBillSelection && selectableForBill && (
              <Checkbox
                aria-label={`Select ${row.unitCode} for billing`}
                data-testid={`bill-select-${row.apartmentId}`}
                checked={!!selectedForBill}
                onCheckedChange={() => onToggleBillSelection(row.apartmentId)}
                className="shrink-0"
              />
            )}
            {onOpenSettings ? (
              <button
                type="button"
                data-testid="unit-code-btn"
                aria-label={`Settings for ${row.unitCode}`}
                onClick={() => onOpenSettings(row.apartmentId)}
                className="shrink-0 whitespace-nowrap font-mono font-semibold underline-offset-2 hover:underline focus:outline-none focus:ring-2 focus:ring-[var(--ring)] rounded"
              >
                {row.unitCode}
              </button>
            ) : (
              <span className="shrink-0 whitespace-nowrap font-mono font-semibold">{row.unitCode}</span>
            )}
            <StatusPill tone={settlementTone} testId="entry-payment-pill">
              {settlementLabel}
            </StatusPill>
            {/* Rule 2: a `Billed` tag whenever this unit-month has a LIVE grid-workflow
                invoice — driven by the provenance-based `row.billed` (NOT billedAt/
                invoicedAt), so it still shows after a legacy sourceGridEntryId=null
                orphaning. Suppressed once the row has been re-Billed: Billed and
                Re-Billed are mutually exclusive (a re-Billed row shows Re-Billed only). */}
            {row.billed && !isReBilled && (
              <Badge variant="emerald" data-testid="billed-badge">Billed</Badge>
            )}
            {/* Re-Billed: shown ONLY after a genuine re-Bill (billRevision > 0),
                replacing the Billed tag. A first-time Bill never reaches here. */}
            {row.billed && isReBilled && (
              <Badge variant="amber" data-testid="rebill-badge">Re-Billed</Badge>
            )}
            {/* R13 — money settled against a proforma line whose tax invoice never got
                minted. The MONEY IS CORRECT; only the document is missing, which is why
                this reads "Invoice pending" rather than anything alarming about payment.
                Repairable via POST /bills-grid/entries/:entryId/graduate-retry. Without
                this chip the repair path exists but nobody can find it. */}
            {row.graduationPending && (
              <Badge variant="amber" data-testid="graduation-pending-badge">Invoice pending</Badge>
            )}
            <span className="ml-auto flex shrink-0 items-center gap-1">
              {row.warnings.length > 0 && (
                <span className="text-xs text-amber-600" title={row.warnings.map((w) => w.code).join(", ")}>
                  ⚠
                </span>
              )}
              {(row.previewError?.code === "AIRCON_EXCEEDS_TNB" || row.previewError?.code === "TNB_UNDERSHOOT") && (
                <span
                  className="text-xs text-red-600"
                  title={
                    row.previewError?.code === "AIRCON_EXCEEDS_TNB"
                      ? "Whole unit: aircond is part of the TNB bill, so it can't be higher than the TNB total. Lower the aircond reading (Current kWh) or raise the TNB total. This amount is auto-calculated and can't be edited."
                      : "The TNB total is just below the aircond total. Raise the TNB total to at least the aircond amount, or lower the aircond reading (Current kWh). This amount is auto-calculated and can't be edited."
                  }
                >
                  ⚠
                </span>
              )}
              {onOpenAttachments && (
                <span className="relative inline-flex">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    // Names the SCOPE, not just the noun: this opens the unit-level
                    // (owner-only) panel, never the per-line tenant-visible one.
                    aria-label={`Owner unit bills for ${row.unitCode}`}
                    title="Unit bills (owner) — never shown to a tenant"
                    data-testid="attachments-btn"
                    onClick={(e) => { e.stopPropagation(); onOpenAttachments(row.apartmentId); }}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <Paperclip />
                  </Button>
                  <CountBadge count={row.attachments.length} testId="attachment-badge" />
                </span>
              )}
              <AuditIcon name={row.entry?.lastEditedByName ?? null} at={row.entry?.updatedAt ?? null} />
            </span>
          </div>
          {/* Context lines — occupancy/tenant then the parent property/condo
              name (Item 5: identifies which building a unit belongs to, critical
              under the "All" filter where condos interleave). Both `truncate`
              inside a shared `max-w-*` cap so a long tenant name can't drag the
              sticky column wider (which is what was crushing the code above).
              The occupancy element keeps its exact text — tests assert its
              textContent verbatim ("Whole unit · {name}" / "3 rooms"). */}
          <div className="mt-1 max-w-[15rem] space-y-0.5">
            {/* Whole-unit tenant name lives in this tag ("Whole unit · {name}"). It used to
                `truncate` and got clipped by the narrow unit column — now it WRAPS within the
                capped width so the full tenant name shows without dragging the column wider.
                textContent is unchanged, so the verbatim-tag tests still hold. */}
            <div data-testid="unit-occupancy-tag" className="whitespace-normal break-words text-xs text-muted-foreground" title={occupancyTag}>
              {occupancyTag}
            </div>
            {row.propertyName && (
              // Visibility bump (was text-muted-foreground/70 — too faint to identify the
              // building at a glance): full-contrast secondary text + medium weight.
              <div className="truncate text-xs font-medium text-foreground/80" title={row.propertyName}>
                {row.propertyName}
              </div>
            )}
            {row.ownerName && (
              <div
                data-testid="owner-line"
                className="truncate text-xs text-muted-foreground"
                title={`Owner: ${row.ownerName}`}
              >
                <span className="text-muted-foreground/70">Owner</span>{" "}
                <span className="font-medium text-foreground/80">{row.ownerName}</span>
              </div>
            )}
            {/* Whole-unit tenant phone: a whole unit renders inline (no nested sub-rows),
                so its tenant's phone would otherwise be dropped — the tenant NAME already
                shows in the "Whole unit · {name}" occupancy tag above, this adds the phone.
                `inlineSubRow` is only set for whole units, so this never doubles up with the
                per-room phone on a partitioned unit's nested rows. */}
            {inlineSubRow?.partyPhone && (
              <div
                data-testid="whole-unit-tenant-phone"
                className="break-words text-xs text-muted-foreground"
                title={`Tenant: ${inlineSubRow.partyName ?? "—"} · ${inlineSubRow.partyPhone}`}
              >
                <span className="text-muted-foreground/70">Tenant</span>{" "}
                <span className="tabular-nums text-foreground/80">{inlineSubRow.partyPhone}</span>
              </div>
            )}
          </div>
        </td>
        {dataColumns.map((col) => {
          if (col.grain === "subRow") {
            // Grain lock (R3): rendered on the unit row ONLY when there are
            // no nested sub-rows to show the reading in — otherwise this cell
            // is a hard lock (the real value lives in the nested rows below).
            if (hasNestedSubRows) {
              return <LockedCell key={col.id} columnId={col.id} display="—" numeric={col.numeric} />;
            }
            const cellKey = inlineSubRow?.listingId ?? row.apartmentId;
            const seed = inlineSubRow?.[col.id as "previousKwh" | "currentKwh" | "amount"] ?? "";
            if (!inlineSubRow) return <LockedCell key={col.id} columnId={col.id} display="—" numeric={col.numeric} />;
            const inlineValue = stagedOrSeed(cellKey, col.id, seed);
            // Task 6: Amount is read-only everywhere — the inline (whole-unit)
            // case live-previews from the SAME staged/seeded Current/Previous
            // this cellKey/row resolves to, so the preview tracks in-progress
            // edits before Save.
            if (col.id === "amount") {
              const prev = stagedOrSeed(cellKey, "previousKwh", inlineSubRow.previousKwh ?? "");
              const cur = stagedOrSeed(cellKey, "currentKwh", inlineSubRow.currentKwh ?? "");
              // Final-review Finding 1: an unedited saved reading shows the
              // STORED snapshot amount (matches the server-computed totals
              // derived from it), NOT a re-computation at the CURRENT rate —
              // the live preview only kicks in once the admin actually
              // stages an edit to THIS row's previousKwh/currentKwh.
              const hasStagedEdit = isStaged(cellKey, "previousKwh") || isStaged(cellKey, "currentKwh");
              const display = hasStagedEdit ? amountPreview(inlineSubRow, prev, cur) : (inlineSubRow.amount ?? "—");
              return (
                <LockedCell key={col.id} columnId={col.id} display={display} numeric={col.numeric} {...readOnlyCellProps(cellKey, col.id)} />
              );
            }
            if (cellLocked(col.id)) {
              return <LockedCell key={col.id} columnId={col.id} display={inlineValue} numeric={col.numeric} {...readOnlyCellProps(cellKey, col.id)} />;
            }
            return (
              <EditableCell
                key={col.id}
                columnId={col.id}
                value={inlineValue}
                onChange={(value) => stageEdit(cellKey, col.id, value)}
                numeric={col.numeric}
                {...editableCellProps(cellKey, col.id, inlineValue)}
              />
            );
          }
          if (!col.editable) {
            // Recurring-charges (R6 refined; Maintenance joined 2026-08-06): a governable scalar
            // cell is read-only ONLY when an ENABLED recurring def governs it (settings-controlled).
            // When the server explicitly says NOT governed (=== false) — no def, disabled def, or a
            // pre-effective month — the cell is an EDITABLE per-month value again (applicability- +
            // billed-lock-gated), exactly like the legacy grid. Lock + generated amount come from
            // row-lock.ts's shared predicates so keyboard nav can never disagree with the render.
            if (col.id === "cleaningOwner" || col.id === "cleaningTenant" || col.id === "wifiOwner" || col.id === "wifiTenant" || col.id === "maintenanceFee") {
              const applicable = isApplicable(row, col.id);
              const recurringLocked = scalarSettingsLock(row, col.id);
              // Maintenance Fee is the other single-column band, so it is marked here as
              // well as TNB below. Cleaning/WiFi never qualify — showsTenantBorneMark
              // returns false for them, since their amount already moves column.
              const scalarTenantBorne = showsTenantBorneMark(row, col.id);
              if (recurringLocked === false && applicable && !cellLocked(col.id)) {
                const seed = seedValue(row, col.id);
                const unitValue = stagedOrSeed(row.apartmentId, col.id, seed);
                return (
                  <EditableCell
                    key={col.id}
                    columnId={col.id}
                    value={unitValue}
                    onChange={(value) => stageEdit(row.apartmentId, col.id, value)}
                    numeric={col.numeric}
                    tenantBorne={scalarTenantBorne}
                    {...editableCellProps(row.apartmentId, col.id, unitValue)}
                  />
                );
              }
              // Read-only (governed) display: the entry's frozen scalar if present, else the
              // GENERATED amount from the recurring def — so a governed cell shows e.g. 100 even
              // for an unopened month whose entry hasn't been created yet (fixes "– instead of 100").
              const v = seedValue(row, col.id);
              const generated = scalarGeneratedAmount(row, col.id);
              // Governed cell: the GENERATED def amount is authoritative (settings-controlled) and
              // wins over the entry scalar / config seed — so an unopened month shows e.g. 100, and
              // a stale/absent scalar never renders "–". Falls back to the seed only when there is
              // no generated amount (ungoverned-but-undefined-flag fixtures).
              const shown = generated || v || "";
              const display = applicable && shown ? shown : "—";
              return <LockedCell key={col.id} columnId={col.id} display={display} numeric={col.numeric} tenantBorne={scalarTenantBorne} {...readOnlyCellProps(row.apartmentId, col.id)} />;
            }
            // Recurring-charges (R9): CUSTOM recurring totals — read-only, count badge, open the
            // read-only itemised dialog (with an "Edit in Unit Settings" action).
            if (col.id === "ownerRecurring" || col.id === "tenantRecurring") {
              const recBearer = col.id === "ownerRecurring" ? "owner" : "tenant";
              return (
                <ReadOnlyCell
                  key={col.id}
                  columnId={col.id}
                  display={readOnlyValue(row, col.id)}
                  numeric={col.numeric}
                  onView={onViewRecurring ? () => onViewRecurring(row.apartmentId, recBearer) : undefined}
                  viewLabel={recBearer === "tenant" ? "View tenant recurring charges" : "View owner recurring charges"}
                  viewTestId={recBearer === "tenant" ? "view-recurring-tenant" : "view-recurring-owner"}
                  badgeCount={recBearer === "tenant" ? (row.recurring?.tenant.count ?? 0) : (row.recurring?.owner.count ?? 0)}
                  {...readOnlyCellProps(row.apartmentId, col.id)}
                />
              );
            }
            const isExpenseWithSst = col.id === "tenantExpWithSst" || col.id === "ownerExpWithSst";
            const bearer: ExpenseBearer = col.id === "tenantExpWithSst" ? "tenant" : "owner";
            // Task 6: Rental is read-only, sourced from the whole-unit
            // tenancy's own sub-row (rental moved off `entry` onto
            // `SubRow.rental`, Task 5) — "—" when unset, mirroring every
            // other LockedCell's empty-value convention.
            if (col.id === "rental") {
              return (
                <LockedCell key={col.id} columnId={col.id} display={row.subRows[0]?.rental ?? "—"} numeric={col.numeric} {...readOnlyCellProps(row.apartmentId, col.id)} />
              );
            }
            return (
              <ReadOnlyCell
                key={col.id}
                columnId={col.id}
                display={readOnlyValue(row, col.id)}
                numeric={col.numeric}
                onView={isExpenseWithSst && onViewExpenses ? () => onViewExpenses(row.apartmentId, bearer) : undefined}
                viewLabel={bearer === "tenant" ? "View tenant expenses" : "View owner expenses"}
                viewTestId={bearer === "tenant" ? "view-expenses-tenant" : "view-expenses-owner"}
                badgeCount={bearer === "tenant" ? row.expenses.tenant.count : row.expenses.owner.count}
                {...readOnlyCellProps(row.apartmentId, col.id)}
              />
            );
          }
          if (col.id !== "unitCode" && !isApplicable(row, col.id)) {
            // Still marked. The one inapplicable case a single-column band has is TNB under
            // "tenant pays directly" — where the tenant unambiguously bears the cost — so
            // dropping the mark here left a bare "—" in precisely the situation the mark
            // exists to explain. It now reads "nothing to enter, the tenant handles it".
            return (
              <LockedCell
                key={col.id}
                columnId={col.id}
                display="—"
                numeric={col.numeric}
                tenantBorne={showsTenantBorneMark(row, col.id)}
              />
            );
          }
          const seed = seedValue(row, col.id);
          const unitValue = stagedOrSeed(row.apartmentId, col.id, seed);
          // TNB has one money column, so its Owner/Tenant setting has no column to move
          // between — it shows as a corner mark instead. showsTenantBorneMark owns the
          // rule (and reads the entry snapshot first, exactly like isApplicable).
          const tenantBorne = showsTenantBorneMark(row, col.id);
          if (cellLocked(col.id)) {
            return <LockedCell key={col.id} columnId={col.id} display={unitValue} numeric={col.numeric} tenantBorne={tenantBorne} {...readOnlyCellProps(row.apartmentId, col.id)} />;
          }
          return (
            <EditableCell
              key={col.id}
              columnId={col.id}
              value={unitValue}
              onChange={(value) => stageEdit(row.apartmentId, col.id, value)}
              numeric={col.numeric}
              tenantBorne={tenantBorne}
              {...editableCellProps(row.apartmentId, col.id, unitValue)}
            />
          );
        })}
      </tr>

      {hasNestedSubRows &&
        roomsToRender.map((subRow) => (
          <tr
            key={subRow.listingId}
            data-testid="tenant-sub-row"
            data-listing-id={subRow.listingId}
            className="border-b border-[var(--border)] bg-background/30 transition hover:bg-[var(--page-bg)]"
          >
            <td className="sticky left-0 z-10 bg-background px-4 py-2 pl-8 text-xs italic text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                ↳ {subRow.partyName ?? "Vacant"}
                {subRow.partyPhone && (
                  <span className="not-italic tabular-nums text-muted-foreground/80" data-testid="subrow-phone">· {subRow.partyPhone}</span>
                )}
                <AuditIcon name={subRow.lastEditedByName ?? null} at={subRow.updatedAt ?? null} />
              </span>
            </td>
            {dataColumns.map((col) => {
              if (col.grain !== "subRow") {
                // Off-grain (unit-grain) cell on a tenant sub-row: greyed and
                // non-editable, same as the reciprocal LockedCell (R3). Task 6
                // exception: `rental` now shows THIS room's own value
                // (SubRow.rental) instead of staying blank — per-room rental
                // display on a partitioned apartment's nested rows.
                //
                // P4 Task 3 (site c, reviewer catch): the per-room `rental`
                // cell is a RAW <td> (not a LockedCell/ReadOnlyCell component),
                // so the active-cell wiring is applied inline here — but ONLY
                // for `rental` (the sole navigable off-grain cell, per the Task
                // 1 enumerator); every other off-grain cell renders null and
                // stays byte-identical to before (parity). Keyed on the
                // sub-row's listingId.
                const isNavRental = col.id === "rental";
                const rentalNav = isNavRental ? readOnlyCellProps(subRow.listingId, col.id) : undefined;
                const rentalDisplay = col.id === "rental" ? (subRow.rental ?? "—") : null;
                return (
                  <td
                    key={col.id}
                    ref={rentalNav?.registerCell}
                    className={cn(
                      "px-2 py-2 text-sm text-muted-foreground",
                      col.numeric && "text-right",
                      // V2: selection tint (matches every other navigable cell)
                      // so a range spanning this per-room rental cell reads solid.
                      rentalNav?.selected && !rentalNav?.active && "bg-[var(--primary)]/15",
                      // P4 Task 4: visible SOLID --primary active ring
                      // (non-inset), matching every other navigable cell.
                      rentalNav?.active && "ring-2 ring-[var(--primary)]",
                    )}
                    data-testid={`cell-${col.id}`}
                    data-active={rentalNav?.active ? "true" : undefined}
                    data-selected={rentalNav?.selected ? "true" : undefined}
                    data-copy-value={isNavRental ? (rentalDisplay ?? "") : undefined}
                    aria-readonly="true"
                    tabIndex={isNavRental && rentalNav?.registerCell ? -1 : undefined}
                    onPointerDown={rentalNav?.onCellPointerDown}
                    onPointerEnter={rentalNav?.onCellPointerEnter}
                    onPointerUp={rentalNav?.onCellPointerUp}
                    onClick={rentalNav?.onActivate}
                    onContextMenu={rentalNav?.onContextMenu}
                  >
                    {rentalDisplay}
                  </td>
                );
              }
              const seed = subRow[col.id as "previousKwh" | "currentKwh" | "amount"] ?? "";
              const subRowValue = stagedOrSeed(subRow.listingId, col.id, seed);
              // Task 6: Amount is read-only everywhere — nested-row case
              // live-previews from THIS sub-row's own staged/seeded
              // Current/Previous.
              if (col.id === "amount") {
                const prev = stagedOrSeed(subRow.listingId, "previousKwh", subRow.previousKwh ?? "");
                const cur = stagedOrSeed(subRow.listingId, "currentKwh", subRow.currentKwh ?? "");
                // Final-review Finding 1: see identical comment at the inline
                // call site above — stored snapshot unless THIS sub-row has a
                // staged previousKwh/currentKwh edit.
                const hasStagedEdit = isStaged(subRow.listingId, "previousKwh") || isStaged(subRow.listingId, "currentKwh");
                const display = hasStagedEdit ? amountPreview(subRow, prev, cur) : (subRow.amount ?? "—");
                return (
                  <LockedCell key={col.id} columnId={col.id} display={display} numeric={col.numeric} {...readOnlyCellProps(subRow.listingId, col.id)} />
                );
              }
              if (cellLocked(col.id)) {
                return <LockedCell key={col.id} columnId={col.id} display={subRowValue} numeric={col.numeric} {...readOnlyCellProps(subRow.listingId, col.id)} />;
              }
              return (
                <EditableCell
                  key={col.id}
                  columnId={col.id}
                  value={subRowValue}
                  onChange={(value) => stageEdit(subRow.listingId, col.id, value)}
                  numeric={col.numeric}
                  {...editableCellProps(subRow.listingId, col.id, subRowValue)}
                />
              );
            })}
          </tr>
        ))}

      {row.priorMonths.map((prior) => (
        <tr
          key={`${row.apartmentId}-prior-${prior.period}`}
          data-testid="prior-month-strip"
          className="border-b border-[var(--border)] text-xs text-muted-foreground"
        >
          <td className="sticky left-0 z-10 bg-[var(--page-bg)] px-4 py-1.5">{prior.period}</td>
          <td colSpan={2} className="px-2 py-1.5" data-testid="prior-cleaning">
            {prior.cleaning ?? "—"}
          </td>
          <td colSpan={4} className="px-2 py-1.5" data-testid="prior-tnb">
            {prior.tnb ?? "—"}
          </td>
          <td colSpan={2} className="px-2 py-1.5" data-testid="prior-air">
            {prior.air ?? "—"}
          </td>
          <td colSpan={2} className="px-2 py-1.5" data-testid="prior-wifi">
            {prior.wifi ?? "—"}
          </td>
          <td colSpan={6} className="px-2 py-1.5" data-testid="prior-others">
            {prior.others}
          </td>
        </tr>
      ))}
    </Fragment>
  );
}
