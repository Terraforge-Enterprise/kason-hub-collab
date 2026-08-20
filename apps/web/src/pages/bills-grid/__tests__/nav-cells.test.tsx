// P4 Task 1 — nav-cells.tsx. `buildNavRows` is the single source of truth for
// "what a nav coordinate can land on": it enumerates the ORDERED navigable
// cells, mirroring GridUnitRowGroup's render branches exactly, and tags each
// cell editable/read-only. The render-parity test (3rd `it`) is the drift
// guard: editable NavCell count + columns MUST equal the rendered <input>s.
//
// Fixtures mirror grid-table.test.tsx's makeRow/makeEntry/makeBearerConfig/
// makeSubRow helpers (adapted here, not imported, since the originals are
// file-local) so every fixture is a VALID GridRow/GridEntryDto shape — never a
// simplified stand-in (§16). `makeSub(listingId)` is the brief's single-arg
// convenience wrapper over makeSubRow.
import { describe, it, expect, vi, afterEach } from "vitest";

afterEach(() => vi.unstubAllEnvs());
import { render } from "@testing-library/react";
import type { GridRow, GridEntryDto, GridBearerConfigDto, GridSubRow } from "@/api/bills-grid";
import { emptySettlementCells } from "@kason/shared";
import { buildNavRows } from "../nav-cells";
import { GridTable } from "../grid-table";
import { CURRENT_COLUMNS } from "../columns";

function makeEntry(partial: Partial<GridEntryDto> = {}): GridEntryDto {
  return {
    cleaning: null,
    tnbTotal: null,
    airSelangor: null,
    wifi: null,
    maintenanceFee: null,
    readingDate: null,
    paymentStatus: "unpaid",
    tnbPattern: "recharged",
    airPattern: "recharged",
    cleaningBearer: "owner",
    wifiBearer: "owner",
    maintenanceFeeBearer: "owner",
    updatedAt: "2026-07-01T00:00:00.000Z",
    lockState: "draft",
    ...partial,
  };
}

function makeBearerConfig(partial: Partial<GridBearerConfigDto> = {}): GridBearerConfigDto {
  return {
    tnbPattern: "recharged",
    airPattern: "recharged",
    cleaningBearer: "owner",
    wifiBearer: "owner",
    maintenanceFeeBearer: "owner",
    cleaningRecurringAmount: "0.00",
    isLocked: false,
    ...partial,
  };
}

function makeSubRow(partial: Partial<GridSubRow> = {}): GridSubRow {
  return {
    listingId: "L1",
    tenancyId: "T1",
    partyName: "Tenant",
    previousKwh: null,
    currentKwh: null,
    amount: null,
    ratePerKwh: "0.6000",
    rateConfigured: false,
    rental: null,
    ...partial,
  };
}

/** Brief's single-arg convenience: a sub-row with the given listingId (and a
 * distinct tenancyId so vacant/occupied identity stays sane in fixtures). */
function makeSub(listingId: string, partial: Partial<GridSubRow> = {}): GridSubRow {
  return makeSubRow({ listingId, tenancyId: `T-${listingId}`, ...partial });
}

function makeRow(partial: Partial<GridRow> = {}): GridRow {
  return {
    apartmentId: "APT1",
    unitCode: "PV9 A-13-13",
    propertyId: "PROP1",
    propertyName: "Sunway Vista",
    entryId: null,
    preview: null,
    previewError: null,
    warnings: [],
    subRows: [],
    billedAt: null,
    paymentStatus: "unpaid",
    priorMonths: [],
    entry: null,
    bearerConfig: makeBearerConfig(),
    expenses: { tenant: { total: "0.00", withSstTotal: "0.00", count: 0 }, owner: { total: "0.00", withSstTotal: "0.00", count: 0 } },
    attachments: [],
    isWholeUnit: false,
    ...partial,
  };
}

// Minimal fixtures: one whole-unit (inline meter), one partitioned (2 sub-rows).
// Each carries a saved entry so the bearer-active-side + seed paths are real.
function wholeUnit(over: Partial<GridRow> = {}): GridRow {
  return makeRow({ apartmentId: "APT-W", entry: makeEntry({}), isWholeUnit: true, subRows: [makeSub("L1")], ...over });
}
function partitioned(over: Partial<GridRow> = {}): GridRow {
  return makeRow({ apartmentId: "APT-P", entry: makeEntry({}), isWholeUnit: false, subRows: [makeSub("L1"), makeSub("L2")], ...over });
}

describe("buildNavRows", () => {
  it("enumerates navigable cells and tags editability", () => {
    const rows = [wholeUnit()];
    const nav = buildNavRows(rows, CURRENT_COLUMNS);
    const flat = nav.flatMap((r) => r.cells);
    // editable unit cell present + editable (cleaning/WiFi are read-only now, so
    // the fixture is recharged, so the editable TNB value lives under Tenant.
    expect(flat.find((c) => c.columnId === "tnbTenant")?.editable).toBe(true);
    // amount present, NOT editable
    expect(flat.find((c) => c.columnId === "amount")?.editable).toBe(false);
    // rental present, NOT editable
    expect(flat.find((c) => c.columnId === "rental")?.editable).toBe(false);
    // no NavCell has columnId "unitCode" (excluded — not a data column)
    expect(flat.some((c) => c.columnId === "unitCode")).toBe(false);
  });

  // Task 7 (spec R7): billed ALONE no longer locks — only billed AND FULLY
  // paid does. `paymentStatus: "paid"` makes this fixture genuinely locked
  // (renamed from "billed rows are navigable but not editable", which no
  // longer holds now that a billed-but-unpaid row must stay editable below).
  it("billed AND fully-paid rows are locked (R7)", () => {
    const nav = buildNavRows(
      [wholeUnit({ billedAt: new Date().toISOString(), paymentStatus: "paid" })],
      CURRENT_COLUMNS,
    );
    const flat = nav.flatMap((r) => r.cells);
    expect(flat.length).toBeGreaterThan(0);
    expect(flat.every((c) => c.editable === false)).toBe(true);
  });

  // Task 7 (spec R7 — unlock predicate): a billed row with no money against it
  // unlocks for amend/re-Bill. Scoped to the MANUAL column here (no settlement on
  // the fixture); real payment state is covered by the settlement test below.
  it("billed but unpaid rows stay editable (R7 unlock)", () => {
    for (const paymentStatus of ["unpaid", "pending", "partial"] as const) {
      const nav = buildNavRows(
        [wholeUnit({ billedAt: new Date().toISOString(), paymentStatus })],
        CURRENT_COLUMNS,
      );
      const flat = nav.flatMap((r) => r.cells);
      expect(flat.length).toBeGreaterThan(0);
      expect(flat.find((c) => c.columnId === "tnbTenant")?.editable).toBe(true);
    }
  });

  // 2026-08-03: the lock now reads REAL settlement, not just the manual column.
  // Keyboard nav has to agree with the render about this or the two surfaces
  // disagree about what is typeable — which is exactly what the shared
  // `isRowLocked` exists to prevent.
  it("real payment state locks the PAID cell while the manual column says unpaid", () => {
    // Cell-grain is flag-gated — it is only sound while partial re-Bill exists to carry an
    // edit to an unpaid cell onto a document. Flag off, the whole row locks (pinned in
    // row-lock.test.ts).
    vi.stubEnv("VITE_ENABLE_PROFORMA_INVOICES", "true");
    // Was "locks the row". Partial re-Bill (R4/R6) means paying one line no longer freezes
    // its neighbours, so the lock is now per cell — and the old fixture was impossible
    // anyway: it claimed a `partial` row where EVERY bucket read "none", which
    // foldSettlement cannot produce (every live charge lands in some bucket).
    for (const status of ["partial", "paid"] as const) {
      const nav = buildNavRows(
        [wholeUnit({
          billedAt: new Date().toISOString(),
          paymentStatus: "unpaid",
          settlement: {
            status,
            cells: { ...emptySettlementCells(), airOwner: status },
            rooms: {},
            expenseLines: {},
          },
        })],
        CURRENT_COLUMNS,
      );
      const flat = nav.flatMap((r) => r.cells);
      expect(flat.length).toBeGreaterThan(0);
      // The settled cell is frozen…
      expect(flat.filter((c) => c.columnId === "airOwner").every((c) => c.editable === false)).toBe(true);
      // …and an untouched money cell on the SAME row is not.
      expect(flat.some((c) => c.columnId === "airTenant" && c.editable)).toBe(true);
    }
  });

  it("render parity: editable NavCell count and columns equal the rendered inputs", () => {
    // Strong, cellKey-free parity: the enumerator must mark EXACTLY the cells
    // that render an <input> as editable — no more, no fewer. A count match
    // catches over- or under-inclusion; a column match catches a wrong column
    // being marked editable. This avoids the fragile "blank column must be
    // editable somewhere" check (read-only columns like `rental`/`amount` render
    // "—" but are legitimately never editable, so that check was wrong).
    // Includes a settlement-LOCKED row: parity matters most exactly where the two
    // surfaces could disagree about editability, and a locked row contributes zero
    // inputs, so an enumerator that missed the lock would blow the count check.
    const rows = [
      wholeUnit(),
      partitioned(),
      wholeUnit({
        apartmentId: "APT-LOCKED",
        billedAt: new Date().toISOString(),
        paymentStatus: "unpaid",
        // A REALISTIC part-paid row: the money sits in a named bucket, so some cells
        // lock and others do not. That mixture is exactly where nav and render could
        // disagree, which is what this parity test exists to catch.
        settlement: {
          status: "partial",
          cells: { ...emptySettlementCells(), airOwner: "paid" },
          rooms: {},
          expenseLines: {},
        },
      }),
    ];
    const { container } = render(
      <GridTable rows={rows} columns={CURRENT_COLUMNS} onCellEdit={() => {}} />,
    );
    const nav = buildNavRows(rows, CURRENT_COLUMNS);
    const editableNav = nav.flatMap((r) => r.cells).filter((c) => c.editable);
    const renderedInputs = Array.from(container.querySelectorAll("td[data-testid^='cell-'] input"));
    // 1) exactly as many editable NavCells as rendered <input>s
    expect(editableNav.length).toBe(renderedInputs.length);
    // 2) every editable NavCell's column renders an <input> somewhere (no wrong column)
    const inputCols = new Set(
      renderedInputs.map((i) => i.closest("td")!.getAttribute("data-testid")!.replace("cell-", "")),
    );
    editableNav.forEach((c) => expect(inputCols.has(c.columnId)).toBe(true));
  });

  // P4 Task 3 regression: `useGridNav` runs `buildNavRows` in the PAGE body,
  // OUTSIDE the GridErrorBoundary that wraps GridTable. A malformed row with
  // `subRows === undefined` (the page's own error-boundary test deliberately
  // constructs one) must NOT throw here — the throw belongs inside GridTable's
  // render where the boundary catches it and shows "Reload grid". buildNavRows
  // must degrade the row to zero navigable sub-cells instead of crashing.
  it("does not throw on a malformed row whose subRows is undefined", () => {
    // Deliberately malformed rows mirroring the page's error-boundary fixture
    // (`badRow.subRows = undefined`). `Partial<GridRow>` accepts `undefined`
    // for the optional-in-partial `subRows`, so no ts-expect-error is needed.
    const bad = makeRow({ apartmentId: "APT-BAD", isWholeUnit: true, subRows: undefined as unknown as GridSubRow[] });
    const badNested = makeRow({ apartmentId: "APT-BAD2", isWholeUnit: false, subRows: undefined as unknown as GridSubRow[] });
    expect(() => buildNavRows([bad, badNested], CURRENT_COLUMNS)).not.toThrow();
    const nav = buildNavRows([bad, badNested], CURRENT_COLUMNS);
    // The unit rows still enumerate their unit-grain cells (rental/expense/editable);
    // there are simply no sub-row NavCells for the missing subRows.
    expect(nav.some((r) => r.rowType === "sub")).toBe(false);
  });
});
