// UI Task 10b — grid-table-affordances.test.tsx. New OPTIONAL interaction
// affordances on GridTable (settings/attachments/expense-eye triggers) plus
// the billed-row visual read-only lock. Task-3's grid-table.test.tsx owns the
// original 9 acceptance rows and stays untouched — this file owns ONLY the
// new ui-task-10b acceptance criteria. Fixtures mirror grid-table.test.tsx's
// makeRow/makeEntry/makeBearerConfig/makeSubRow helpers (duplicated here,
// not imported, since the originals are file-local) so every fixture is a
// VALID GridRow/GridEntryDto shape — never a simplified stand-in (§16).
import { describe, expect, it, vi } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { GridRow, GridEntryDto, GridBearerConfigDto, GridSubRow } from "@/api/bills-grid";
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
    // OWNER-borne AIR ("absorbed") on purpose: these tests use airOwner as a convenient
    // EDITABLE anchor cell, and since 2026-08-14 the AIR bearer decides which of the two
    // AIR columns renders (cell-applicability.ts). Tenant-borne AIR would move the
    // editable cell to airTenant and this file's subject would vanish.
    airPattern: "absorbed",
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
    airPattern: "absorbed", // see makeEntry above
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
    // Task 6: grain-lock is now re-based on isWholeUnit (server-derived from
    // Apartment.listingMode), NOT entry.rental (removed). Default false
    // (partitioned) mirrors the old default fixture shape (entry: null /
    // entry.rental: null used to imply partitioned).
    isWholeUnit: false,
    ...partial,
  };
}

describe("GridTable — affordances (ui-task-10b)", () => {
  // R1 (Task 6): the unit-code itself is now the settings trigger — the
  // separate gear button is gone. Split into 3 focused tests matching the
  // task-6 brief's acceptance table (was one combined "settings affordance"
  // test against the old gear-button design).
  it('"unit name opens settings" — with onOpenSettings wired, the unit-code is a data-testid="unit-code-btn" control; clicking it calls onOpenSettings(apartmentId); no settings-btn gear exists anywhere in the table', async () => {
    const user = userEvent.setup();
    const onOpenSettings = vi.fn();
    const rowA = makeRow({ apartmentId: "APT1", unitCode: "PV9 A-13-13" });
    const rowB = makeRow({ apartmentId: "APT2", unitCode: "PV9 A-14-14" });
    render(
      <GridTable rows={[rowA, rowB]} columns={CURRENT_COLUMNS} onOpenSettings={onOpenSettings} />,
    );

    // the gear is gone entirely — the unit-code IS the trigger now
    expect(screen.queryByTestId("settings-btn")).toBeNull();
    expect(screen.getAllByTestId("unit-code-btn")).toHaveLength(2);

    const rowAEl = screen.getByRole("row", { name: /PV9 A-13-13/ });
    await user.click(within(rowAEl).getByTestId("unit-code-btn"));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(onOpenSettings).toHaveBeenCalledWith("APT1");
  });

  it('"attachment click does not open settings" — clicking the paperclip attachments icon calls onOpenAttachments(apartmentId) and does NOT call onOpenSettings (stopPropagation keeps the click from reaching the unit-code trigger)', async () => {
    const user = userEvent.setup();
    const onOpenSettings = vi.fn();
    const onOpenAttachments = vi.fn();
    const row = makeRow({ apartmentId: "APT1", unitCode: "PV9 A-13-13" });
    render(
      <GridTable
        rows={[row]}
        columns={CURRENT_COLUMNS}
        onOpenSettings={onOpenSettings}
        onOpenAttachments={onOpenAttachments}
      />,
    );

    await user.click(screen.getByTestId("attachments-btn"));
    expect(onOpenAttachments).toHaveBeenCalledTimes(1);
    expect(onOpenAttachments).toHaveBeenCalledWith("APT1");
    expect(onOpenSettings).not.toHaveBeenCalled();
  });

  it('"no settings access renders plain text" — with onOpenSettings undefined, the unit-code renders as plain non-interactive text: no unit-code-btn, no error thrown, and the code text still shows', () => {
    const row = makeRow({ apartmentId: "APT1", unitCode: "PV9 A-13-13" });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} />);

    expect(screen.queryByTestId("unit-code-btn")).toBeNull();
    expect(screen.getByText("PV9 A-13-13")).toBeInTheDocument();
  });

  it('"attachments affordance" — with onOpenAttachments, clicking the attachments button calls onOpenAttachments(apartmentId); absent handler → no button', async () => {
    const user = userEvent.setup();
    const onOpenAttachments = vi.fn();
    const row = makeRow({ apartmentId: "APT1", unitCode: "PV9 A-13-13" });
    const { rerender } = render(
      <GridTable rows={[row]} columns={CURRENT_COLUMNS} onOpenAttachments={onOpenAttachments} />,
    );

    await user.click(screen.getByTestId("attachments-btn"));
    expect(onOpenAttachments).toHaveBeenCalledTimes(1);
    expect(onOpenAttachments).toHaveBeenCalledWith("APT1");

    rerender(<GridTable rows={[row]} columns={CURRENT_COLUMNS} />);
    expect(screen.queryByTestId("attachments-btn")).toBeNull();
  });

  it('"expenses eye-icon per bearer" — the tenant-band eye calls onViewExpenses(apartmentId, "tenant") and the owner-band eye calls (apartmentId, "owner")', async () => {
    const user = userEvent.setup();
    const onViewExpenses = vi.fn();
    const row = makeRow({
      apartmentId: "APT1",
      expenses: {
        tenant: { total: "20.00", withSstTotal: "20.00", count: 1 },
        owner: { total: "30.00", withSstTotal: "30.00", count: 1 },
      },
    });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} onViewExpenses={onViewExpenses} />);

    await user.click(screen.getByTestId("view-expenses-tenant"));
    expect(onViewExpenses).toHaveBeenNthCalledWith(1, "APT1", "tenant");

    await user.click(screen.getByTestId("view-expenses-owner"));
    expect(onViewExpenses).toHaveBeenNthCalledWith(2, "APT1", "owner");

    // the numeric total must stay visible next to the icon — never hidden
    expect(within(screen.getByTestId("cell-tenantExpWithSst")).getByText("20.00")).toBeInTheDocument();
    expect(within(screen.getByTestId("cell-ownerExpWithSst")).getByText("30.00")).toBeInTheDocument();
  });

  it('"billed row locks editable cells" — a row with billedAt set AND fully paid renders its editable cells (incl. nested sub-rows) as aria-readonly="true" with no <input>, and typing does not fire onCellEdit; an unbilled row in the same render keeps editable inputs', async () => {
    const user = userEvent.setup();
    const onCellEdit = vi.fn();
    const billedRow = makeRow({
      apartmentId: "APT-BILLED",
      unitCode: "PV9 B-01-01",
      billedAt: "2026-07-10T00:00:00.000Z",
      // Task 7 (R7): billed ALONE no longer locks — this fixture must also be
      // fully "paid" to represent a genuinely-frozen row (see the sibling
      // "billed but unpaid" test below for the new unlock behavior).
      paymentStatus: "paid",
      entry: makeEntry({}),
      // Task 6: rental moved off entry onto the (first) sub-row — "1500.00"
      // preserved here so the rentalCell assertion below still checks the
      // same value it always did.
      subRows: [
        makeSubRow({ listingId: "LB1", tenancyId: "TB1", previousKwh: "100", currentKwh: "150", rental: "1500.00" }),
        makeSubRow({ listingId: "LB2", tenancyId: "TB2", previousKwh: "200", currentKwh: "250" }),
      ],
    });
    const unbilledRow = makeRow({
      apartmentId: "APT-OPEN",
      unitCode: "PV9 B-02-02",
      billedAt: null,
      entry: makeEntry({ tnbTotal: "2000.00" }),
    });
    render(<GridTable rows={[billedRow, unbilledRow]} columns={CURRENT_COLUMNS} onCellEdit={onCellEdit} />);

    // billed unit row: rental (Task 6: now read-only regardless of billed
    // state) is locked, not an input — value comes from subRows[0].rental.
    const billedUnitRow = screen.getByRole("row", { name: /PV9 B-01-01/ });
    const rentalCell = within(billedUnitRow).getByTestId("cell-rental");
    expect(rentalCell.querySelector("input")).toBeNull();
    expect(rentalCell.getAttribute("aria-readonly")).toBe("true");
    expect(rentalCell).toHaveTextContent("1500.00");

    // billed unit's nested tenant sub-rows are locked too
    const billedSubRows = screen
      .getAllByTestId("tenant-sub-row")
      .filter((r) => r.getAttribute("data-listing-id")?.startsWith("LB"));
    expect(billedSubRows).toHaveLength(2);
    for (const subRow of billedSubRows) {
      const cell = within(subRow).getByTestId("cell-previousKwh");
      expect(cell.querySelector("input")).toBeNull();
      expect(cell.getAttribute("aria-readonly")).toBe("true");
    }

    // Recurring-charges (R9): cleaning/WiFi are read-only now too, so the
    // "unbilled keeps an editable input + fires onCellEdit" half uses tnbOwner
    // (still an editable unit-grain cell) as its subject.
    const unbilledUnitRow = screen.getByRole("row", { name: /PV9 B-02-02/ });
    const openTnbCell = within(unbilledUnitRow).getByTestId("cell-tnbOwner");
    const openInput = openTnbCell.querySelector("input");
    expect(openInput).not.toBeNull();
    await user.clear(openInput as HTMLInputElement);
    await user.type(openInput as HTMLInputElement, "2200.00");
    expect(onCellEdit).toHaveBeenCalled();
    expect(onCellEdit.mock.calls.every((c) => c[0] !== "APT-BILLED")).toBe(true);
    expect(onCellEdit.mock.calls.some((c) => c[0] === "APT-OPEN")).toBe(true);
  });

  // Task 7 (spec R7 — unlock predicate): billed alone must NOT lock the render
  // — only billed AND FULLY paid does (the sibling test above). A billed row
  // with paymentStatus unpaid/pending/partial must render real <input>s (incl.
  // nested sub-rows), identical to an unbilled row, and a typed edit must
  // reach onCellEdit — proving the admin can actually amend/re-Bill through
  // the rendered grid, not just through the nav-cells.ts abstraction.
  it('"billed but unpaid row stays unlocked" — a row with billedAt set and paymentStatus "partial" renders real editable <input>s (incl. nested sub-rows), and typing reaches onCellEdit', async () => {
    const user = userEvent.setup();
    const onCellEdit = vi.fn();
    const billedUnpaidRow = makeRow({
      apartmentId: "APT-REBILL",
      unitCode: "PV9 C-01-01",
      billedAt: "2026-07-10T00:00:00.000Z",
      paymentStatus: "partial",
      entry: makeEntry({}),
      subRows: [
        makeSubRow({ listingId: "LR1", tenancyId: "TR1", previousKwh: "100", currentKwh: "150", rental: "1500.00" }),
        makeSubRow({ listingId: "LR2", tenancyId: "TR2", previousKwh: "200", currentKwh: "250" }),
      ],
    });
    render(<GridTable rows={[billedUnpaidRow]} columns={CURRENT_COLUMNS} onCellEdit={onCellEdit} />);

    // Unit-grain editable cell: a real <input>, not a LockedCell. (cleaning/WiFi
    // are read-only now, so tnbOwner is the editable subject.)
    const row = screen.getByRole("row", { name: /PV9 C-01-01/ });
    const tnbCell = within(row).getByTestId("cell-tnbOwner");
    const tnbInput = tnbCell.querySelector("input");
    expect(tnbInput).not.toBeNull();
    expect(tnbCell.getAttribute("aria-readonly")).not.toBe("true");

    // Nested tenant sub-rows are unlocked too.
    const subRows = screen.getAllByTestId("tenant-sub-row");
    expect(subRows).toHaveLength(2);
    for (const subRow of subRows) {
      const cell = within(subRow).getByTestId("cell-previousKwh");
      expect(cell.querySelector("input")).not.toBeNull();
    }

    // A typed edit actually reaches onCellEdit for this apartment.
    await user.clear(tnbInput as HTMLInputElement);
    await user.type(tnbInput as HTMLInputElement, "2200.00");
    expect(onCellEdit.mock.calls.some((c) => c[0] === "APT-REBILL")).toBe(true);
  });

  // Re-Bill tag (bug fix): the tag means "this unit-month has ACTUALLY been
  // re-Billed" (billRevision > 0), NOT the old "billed once, editing re-Bills it"
  // heuristic that keyed on `billedAt != null` — which fired on the very FIRST
  // Bill (billedAt is set on both a first Bill and a re-Bill) and ALSO co-existed
  // with the Billed tag on a real re-Bill. Billed and Re-Billed are now mutually
  // exclusive: a first Bill shows Billed only; a re-Bill shows Re-Billed only.
  it('"Billed vs Re-Billed tags are mutually exclusive" — a first Bill (billRevision 0) shows Billed only; a re-Bill (billRevision > 0) shows Re-Billed only; a fresh unbilled row shows neither', () => {
    const rows = [
      makeRow({ apartmentId: "APT-FRESH", unitCode: "PV9 D-01-01", billed: false, billedAt: null, paymentStatus: "unpaid" }),
      makeRow({ apartmentId: "APT-FIRST", unitCode: "PV9 D-02-02", billed: true, billRevision: 0, billedAt: "2026-07-10T00:00:00.000Z", paymentStatus: "unpaid" }),
      makeRow({ apartmentId: "APT-REBILL2", unitCode: "PV9 D-03-03", billed: true, billRevision: 2, billedAt: "2026-07-10T00:00:00.000Z", paymentStatus: "partial" }),
    ];
    render(<GridTable rows={rows} columns={CURRENT_COLUMNS} />);

    const freshRow = screen.getByRole("row", { name: /PV9 D-01-01/ });
    const firstRow = screen.getByRole("row", { name: /PV9 D-02-02/ });
    const rebillRow = screen.getByRole("row", { name: /PV9 D-03-03/ });

    // Fresh unbilled row: neither tag.
    expect(within(freshRow).queryByTestId("billed-badge")).toBeNull();
    expect(within(freshRow).queryByTestId("rebill-badge")).toBeNull();

    // First Bill: Billed only, NOT Re-Billed (the bug was Re-Bill showing here).
    expect(within(firstRow).getByTestId("billed-badge")).toBeInTheDocument();
    expect(within(firstRow).queryByTestId("rebill-badge")).toBeNull();

    // Real re-Bill: Re-Billed only, NOT both (the bug was Billed + Re-Bill together).
    expect(within(rebillRow).getByTestId("rebill-badge")).toHaveTextContent("Re-Billed");
    expect(within(rebillRow).queryByTestId("billed-badge")).toBeNull();
  });

  it('`hasUnbilledChanges` renders NO tag — the field still arrives from the server, the grid just does not surface it', () => {
    // 2026-08-17: the "Unbilled changes" tag was pulled from the UI. The server-side
    // derivation and the DTO field STAY (deriveHasUnbilledChanges / GridRowDto) — only the
    // rendering is gone, so these rows deliberately still carry `hasUnbilledChanges: true`.
    //
    // Pulled because it fired on every billed row the instant it was billed: `billedAt` is
    // written from a JS `new Date()` while `updatedAt` is Prisma's `@updatedAt`, stamped
    // milliseconds later in that same write, so `updatedAt > billedAt` was true from the
    // start (57 ms of skew measured on a real never-amended row). Permanent red noise, not
    // a signal. Billed / Re-Billed are the only row tags again.
    const rows = [
      makeRow({ apartmentId: "APT-BILLED", unitCode: "PV9 E-01-01", billed: true, billRevision: 0, billedAt: "2026-07-10T00:00:00.000Z", hasUnbilledChanges: true }),
      makeRow({ apartmentId: "APT-REBILLED", unitCode: "PV9 E-03-03", billed: true, billRevision: 2, billedAt: "2026-07-10T00:00:00.000Z", hasUnbilledChanges: true }),
    ];
    render(<GridTable rows={rows} columns={CURRENT_COLUMNS} />);

    const billedRow = screen.getByRole("row", { name: /PV9 E-01-01/ });
    const reBilledRow = screen.getByRole("row", { name: /PV9 E-03-03/ });

    // Flagged dirty by the server, yet no tag renders — the point of the removal.
    expect(within(billedRow).queryByTestId("unbilled-changes-badge")).toBeNull();
    expect(within(billedRow).getByTestId("billed-badge")).toBeInTheDocument();

    expect(within(reBilledRow).queryByTestId("unbilled-changes-badge")).toBeNull();
    expect(within(reBilledRow).getByTestId("rebill-badge")).toBeInTheDocument();

    expect(screen.queryByText("Unbilled changes")).toBeNull();
  });

  it('"no handlers = no affordances (Task-3 parity)" — rendering <GridTable rows columns /> with no handler props shows NO settings/attachments/eye buttons on any row', () => {
    const row = makeRow({
      apartmentId: "APT1",
      entry: makeEntry({}),
      subRows: [makeSubRow({ listingId: "L1", tenancyId: "T1" })],
      expenses: {
        tenant: { total: "20.00", withSstTotal: "20.00", count: 1 },
        owner: { total: "30.00", withSstTotal: "30.00", count: 1 },
      },
    });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} />);
    expect(screen.queryByTestId("unit-code-btn")).toBeNull();
    expect(screen.queryByTestId("attachments-btn")).toBeNull();
    expect(screen.queryByTestId("view-expenses-tenant")).toBeNull();
    expect(screen.queryByTestId("view-expenses-owner")).toBeNull();
  });
});

// ── ui-task-10e: pointer/selection/colour extension (additive to grid-table.tsx) ──
describe("GridTable — pointer/selection/colour (ui-task-10e)", () => {
  it('"pointer + selection highlight" — firing pointerdown on a cell calls onCellPointerDown with the SelectionCell (incl. numeric value) + a {shift,ctrl} mods object; a cell for which isCellSelected returns true carries the selection marker, others do not', () => {
    // Recurring-charges (R9): rental AND cleaning/WiFi are read-only (no pointer
    // wiring) — this pointer/selection affordance test uses tnbOwner + airOwner
    // (both still editable) as its subjects instead.
    const onCellPointerDown = vi.fn();
    // isWholeUnit: true → inline render, no nested sub-rows, so the unit-grain
    // tnbOwner/airOwner cells each appear exactly once (no off-grain nested
    // duplicate to collide with the getByTestId queries below).
    const row = makeRow({
      apartmentId: "APT1",
      isWholeUnit: true,
      entry: makeEntry({ tnbTotal: "1000.00", airSelangor: "50.00" }),
      subRows: [makeSubRow({ listingId: "L1", tenancyId: "T1" })],
    });
    render(
      <GridTable
        rows={[row]}
        columns={CURRENT_COLUMNS}
        onCellPointerDown={onCellPointerDown}
        isCellSelected={(cellKey, columnId) => cellKey === "APT1" && columnId === "tnbOwner"}
      />,
    );

    const tnbCell = screen.getByTestId("cell-tnbOwner");
    fireEvent.pointerDown(tnbCell, { ctrlKey: true });

    expect(onCellPointerDown).toHaveBeenCalledTimes(1);
    // Task 3: the second arg is now a {shift,ctrl} mods object (was a bare
    // ctrlKey boolean) — a ctrl-only pointerdown reports {shift:false, ctrl:true}.
    expect(onCellPointerDown).toHaveBeenCalledWith(
      { cellKey: "APT1", columnId: "tnbOwner", value: 1000 },
      { shift: false, ctrl: true },
    );
    expect(tnbCell.getAttribute("data-selected")).toBe("true");

    const airCell = screen.getByTestId("cell-airOwner");
    expect(airCell.getAttribute("data-selected")).toBeNull();

    // a plain (no ctrl/meta/shift) pointerdown reports {shift:false, ctrl:false}
    fireEvent.pointerDown(airCell);
    expect(onCellPointerDown).toHaveBeenNthCalledWith(
      2,
      { cellKey: "APT1", columnId: "airOwner", value: 50 },
      { shift: false, ctrl: false },
    );
  });

  it('"pointer-down carries shift+ctrl" — a pointerdown with BOTH shiftKey and ctrlKey set calls onCellPointerDown with mods {shift:true, ctrl:true}; on a non-mac platform a bare metaKey (Cmd) is NOT the multi-select modifier', () => {
    const onCellPointerDown = vi.fn();
    const row = makeRow({
      apartmentId: "APT1",
      isWholeUnit: true,
      entry: makeEntry({ tnbTotal: "1000.00" }),
      subRows: [makeSubRow({ listingId: "L1", tenancyId: "T1" })],
    });
    render(
      <GridTable rows={[row]} columns={CURRENT_COLUMNS} onCellPointerDown={onCellPointerDown} />,
    );

    const tnbCell = screen.getByTestId("cell-tnbOwner");
    fireEvent.pointerDown(tnbCell, { shiftKey: true, ctrlKey: true });
    expect(onCellPointerDown).toHaveBeenCalledWith(
      { cellKey: "APT1", columnId: "tnbOwner", value: 1000 },
      { shift: true, ctrl: true },
    );

    // Excel-Web V2 platform-aware modifiers: the multi-select key is Ctrl on
    // Windows/Linux and Cmd on macOS (grid-gestures.ts). jsdom is a non-mac
    // platform, so a bare metaKey (Cmd) is NOT the multi-select modifier here —
    // it resolves to ctrl:false (on macOS the same event would be ctrl:true).
    fireEvent.pointerDown(tnbCell, { metaKey: true });
    expect(onCellPointerDown).toHaveBeenLastCalledWith(
      { cellKey: "APT1", columnId: "tnbOwner", value: 1000 },
      { shift: false, ctrl: false },
    );
  });

  it('"cell colour render" — cellColour returning a colour for one cell paints that <td>\'s background; other cells stay unstyled', () => {
    // Recurring-charges (R9): rental AND cleaning/WiFi are read-only (LockedCell,
    // no colour wiring) — colour render is exercised on tnbOwner vs airOwner
    // (both editable).
    const row = makeRow({
      apartmentId: "APT1",
      entry: makeEntry({ tnbTotal: "50.00", airSelangor: "30.00" }),
    });
    render(
      <GridTable
        rows={[row]}
        columns={CURRENT_COLUMNS}
        cellColour={(cellKey, columnId) =>
          cellKey === "APT1" && columnId === "tnbOwner" ? "rgb(253, 230, 138)" : undefined
        }
      />,
    );

    const tnbCell = screen.getByTestId("cell-tnbOwner");
    expect(tnbCell.style.backgroundColor).toBe("rgb(253, 230, 138)");

    const airCell = screen.getByTestId("cell-airOwner");
    expect(airCell.style.backgroundColor).toBe("");
  });

  it('"no pointer props = unchanged" — without onCellPointerDown/onCellPointerEnter/onCellPointerUp/isCellSelected/cellColour, cells render with no selection marker, no colour, and firing pointer events is a no-op (Task-3 parity)', () => {
    const row = makeRow({
      apartmentId: "APT1",
      entry: makeEntry({}),
      subRows: [
        makeSubRow({ listingId: "L1", tenancyId: "T1" }),
        makeSubRow({ listingId: "L2", tenancyId: "T2" }),
      ],
    });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} />);

    const unitRow = screen.getByRole("row", { name: /PV9 A-13-13/ });
    // Task 6: cleaningOwner (still editable) stands in for the old rental
    // subject — proves an editable cell renders unwired when no pointer props.
    const cleaningCell = within(unitRow).getByTestId("cell-cleaningOwner");
    expect(cleaningCell.getAttribute("data-selected")).toBeNull();
    expect(cleaningCell.style.backgroundColor).toBe("");
    expect(() => {
      fireEvent.pointerDown(cleaningCell);
      fireEvent.pointerEnter(cleaningCell);
      fireEvent.pointerUp(cleaningCell);
    }).not.toThrow();

    const subRow = screen.getAllByTestId("tenant-sub-row")[0];
    const meterCell = within(subRow).getByTestId("cell-previousKwh");
    expect(meterCell.getAttribute("data-selected")).toBeNull();
    expect(meterCell.style.backgroundColor).toBe("");
  });
});

// ── ui-task-10g: `staged` prop — GridTable also renders the page's
// useStagedEdits buffer for display, so programmatic stages (ctrl-fill,
// crash-recovery) repaint the <input> — not just GridTable's own internal
// keystroke-echo `staged` state. ──────────────────────────────────────────
describe("GridTable — staged prop (ui-task-10g)", () => {
  // Recurring-charges (R9): rental AND cleaning/WiFi are read-only now (no
  // <input>), so these staged-prop / keystroke-echo tests use tnbOwner (still
  // editable) as the subject.
  it('"staged prop surfaces a value" — a staged prop value for a cell displays instead of a DIFFERENT seed (page buffer wins over seed)', () => {
    const row = makeRow({ apartmentId: "apt-1", entry: makeEntry({}) });
    render(
      <GridTable rows={[row]} columns={CURRENT_COLUMNS} staged={{ "apt-1:tnbOwner": "777" }} />,
    );

    const tnbInput = within(screen.getByTestId("cell-tnbOwner")).getByRole("textbox");
    expect(tnbInput).toHaveValue("777");
  });

  it('"internal keystroke wins over staged prop" — typing into a cell that has a staged-prop value shows the TYPED value, not the prop', async () => {
    const user = userEvent.setup();
    const row = makeRow({ apartmentId: "apt-1", entry: makeEntry({}) });
    render(
      <GridTable rows={[row]} columns={CURRENT_COLUMNS} staged={{ "apt-1:tnbOwner": "777" }} />,
    );

    const tnbInput = within(screen.getByTestId("cell-tnbOwner")).getByRole("textbox");
    expect(tnbInput).toHaveValue("777"); // starts from the prop (no keystroke yet)

    await user.clear(tnbInput);
    await user.type(tnbInput, "555");
    expect(tnbInput).toHaveValue("555"); // typing wins over the still-unchanged prop
  });

  it('"no staged prop = seed" (parity) — without the staged prop, a cell shows its seed value unchanged (Task-3/ui-10b/e parity)', () => {
    const row = makeRow({ apartmentId: "apt-1", entry: makeEntry({ tnbTotal: "1000.00" }) });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} />);

    const tnbInput = within(screen.getByTestId("cell-tnbOwner")).getByRole("textbox");
    expect(tnbInput).toHaveValue("1000.00");
  });
});

// ── ui-task-10-keyfix: cross-month display contamination. GridTable's
// internal keystroke-echo buffer (`internalStaged`) is checked BEFORE the
// `staged` prop/seed in stagedOrSeed. The page mounts GridTable with
// `key={currentPeriod}` (bills-grid-page.tsx) so a period switch forces a
// fresh GridTable instance — clearing internalStaged — instead of the typed
// value from one month bleeding into the next. These tests exercise that
// remount contract directly at the GridTable level: the SAME key across a
// rows change must NOT clear the internal echo (negative control proving the
// key change, not the rows change, is what resets it); a DIFFERENT key must.
// ── Task 9 (R7/R8): phone-style count badges on the attachment (paperclip)
// button and the expense (eye) button. Display-only, sourced from
// row.attachments.length and row.expenses.{tenant,owner}.count (Task 1) —
// hidden entirely at 0 (never renders "0" or NaN). ──────────────────────────
describe("GridTable — count badges (R7/R8, ui-task-9)", () => {
  it('"attachment count badge" — a unit with 2 attachments shows a badge "2" on the attachments button', () => {
    const onOpenAttachments = vi.fn();
    const row = makeRow({
      apartmentId: "APT1",
      attachments: [
        { id: "A1", filename: "receipt1.pdf" },
        { id: "A2", filename: "receipt2.pdf" },
      ],
    });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} onOpenAttachments={onOpenAttachments} />);

    expect(screen.getByTestId("attachment-badge")).toHaveTextContent("2");
  });

  it('"no attachment badge at zero" — a unit with 0 attachments shows no attachment badge (never renders "0")', () => {
    const onOpenAttachments = vi.fn();
    const row = makeRow({ apartmentId: "APT1", attachments: [] });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} onOpenAttachments={onOpenAttachments} />);

    expect(screen.queryByTestId("attachment-badge")).toBeNull();
  });

  it('"expense count badge" — a unit with 3 active tenant expenses shows a badge "3" on the tenant expense eye; 0 owner expenses shows no owner badge', () => {
    const onViewExpenses = vi.fn();
    const row = makeRow({
      apartmentId: "APT1",
      expenses: {
        tenant: { total: "60.00", withSstTotal: "60.00", count: 3 },
        owner: { total: "0.00", withSstTotal: "0.00", count: 0 },
      },
    });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} onViewExpenses={onViewExpenses} />);

    expect(screen.getByTestId("view-expenses-tenant-badge")).toHaveTextContent("3");
    expect(screen.queryByTestId("view-expenses-owner-badge")).toBeNull();
  });
});

describe("GridTable — key-per-period remount clears internal echo (ui-task-10-keyfix)", () => {
  // Recurring-charges (R9): rental AND cleaning/WiFi are read-only now — these
  // internal-echo remount tests use tnbOwner (still editable) as the typed
  // subject; June's distinct seed is set via entry.tnbTotal "500.00".
  it('"same key across a rows change" — typing into a cell, then rerendering with the SAME key and DIFFERENT rows, still shows the typed value (internal echo persists without a key change)', async () => {
    const user = userEvent.setup();
    const rowJuly = makeRow({ apartmentId: "apt-1", entry: makeEntry({}) });
    const rowJune = makeRow({ apartmentId: "apt-1", entry: makeEntry({ tnbTotal: "500.00" }) });
    const { rerender } = render(
      <GridTable key="2026-07-01" rows={[rowJuly]} columns={CURRENT_COLUMNS} />,
    );

    const tnbInput = within(screen.getByTestId("cell-tnbOwner")).getByRole("textbox");
    await user.clear(tnbInput);
    await user.type(tnbInput, "9999");
    expect(tnbInput).toHaveValue("9999");

    // same key, different rows (June's seed is 500.00) — this is what the
    // bug looked like before the page-level key fix: no remount, so the
    // internal echo from July's keystroke keeps winning over June's seed.
    rerender(<GridTable key="2026-07-01" rows={[rowJune]} columns={CURRENT_COLUMNS} />);
    const sameInstanceInput = within(screen.getByTestId("cell-tnbOwner")).getByRole("textbox");
    expect(sameInstanceInput).toHaveValue("9999");
  });

  it('"different key across a period switch" — typing into a cell, then rerendering with a DIFFERENT key (new period) and that period\'s rows, shows the NEW period\'s seed, not the previously-typed value', async () => {
    const user = userEvent.setup();
    const rowJuly = makeRow({ apartmentId: "apt-1", entry: makeEntry({}) });
    const rowJune = makeRow({ apartmentId: "apt-1", entry: makeEntry({ tnbTotal: "500.00" }) });
    const { rerender } = render(
      <GridTable key="2026-07-01" rows={[rowJuly]} columns={CURRENT_COLUMNS} />,
    );

    const tnbInput = within(screen.getByTestId("cell-tnbOwner")).getByRole("textbox");
    await user.clear(tnbInput);
    await user.type(tnbInput, "9999");
    expect(tnbInput).toHaveValue("9999");

    // different key (period switch) — GridTable remounts fresh, internalStaged
    // resets to {}, so June's seed (500.00) shows — NOT July's typed 9999.
    rerender(<GridTable key="2026-06-01" rows={[rowJune]} columns={CURRENT_COLUMNS} />);
    const remountedInput = within(screen.getByTestId("cell-tnbOwner")).getByRole("textbox");
    expect(remountedInput).toHaveValue("500.00");
  });
});
