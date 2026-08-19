// P4 Task 7 — Delete/Backspace clear-by-grain on the MONEY-CRITICAL bills-grid.
// Two layers, each money-guarded:
//   1. Hook-level (useGridKeyboard): Delete/Backspace → onDelete() + preventDefault,
//      positioned BEFORE the Escape branch. Absent onDelete ⇒ pass through (parity).
//   2. Page-level (wired BillsGridPage): onDelete clears each target cell (range if
//      present, else the active cell) BY GRAIN, routing EVERY write through the
//      handleCellEdit chokepoint:
//        - billed (owning apartment) → SKIP (never write locked money),
//        - meter column → handleCellEdit(cellKey, columnId, "") (stages "" → Save nulls it),
//        - uncommitted staged edit → unstage (revert to saved),
//        - saved entry money cell → NO-OP + a single cue (never a silent staged "").
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useMemo } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { GridRow, GridResponse } from "@/api/bills-grid";
import { AuthContext, type User } from "@/lib/auth";
import { useGridKeyboard } from "../use-grid-keyboard";

// ── page mocks (mirror grid-type-commit.test.tsx's harness exactly) ──────────
const savePref = vi.fn();
const loadPref = vi.fn((_ns: string, _key: string, fallback: unknown) => fallback);
const saveCellColours = vi.fn();
const loadCellColours = vi.fn((_ns: string) => ({}) as Record<string, string>);
vi.mock("@/lib/view-prefs", () => ({
  loadPref: (...args: [string, string, unknown]) => loadPref(...args),
  savePref: (...args: [string, string, unknown]) => savePref(...args),
  loadCellColours: (...args: [string]) => loadCellColours(...args),
  saveCellColours: (...args: [string, Record<string, string>]) => saveCellColours(...args),
}));

const fetchGrid = vi.fn();
const saveEntry = vi.fn();
const saveReadings = vi.fn();
const billRows = vi.fn();
const getBearerConfig = vi.fn();
const listExpenses = vi.fn();
const listAttachments = vi.fn();
vi.mock("@/api/bills-grid", async () => {
  const actual = await vi.importActual<typeof import("@/api/bills-grid")>("@/api/bills-grid");
  return {
    ...actual,
    fetchGrid: (...args: unknown[]) => fetchGrid(...args),
    saveEntry: (...args: unknown[]) => saveEntry(...args),
    saveReadings: (...args: unknown[]) => saveReadings(...args),
    billRows: (...args: unknown[]) => billRows(...args),
    getBearerConfig: (...args: unknown[]) => getBearerConfig(...args),
    listExpenses: (...args: unknown[]) => listExpenses(...args),
    listAttachments: (...args: unknown[]) => listAttachments(...args),
  };
});
vi.mock("../export-xlsx", () => ({ exportGridToXlsx: vi.fn() }));
// The saved-money no-op cue is a `toast.info(...)`. Mock `toast` as an object
// with the named methods the page uses (info for the cue; success/error for Save).
const toastInfo = vi.fn();
const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    info: (...a: unknown[]) => toastInfo(...a),
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}));

import BillsGridPage from "../bills-grid-page";

// ── hook-level harness (Delete/Backspace → onDelete, BEFORE the Escape branch) ──

function DeleteHarness(opts: {
  onDelete?: () => void;
  cancelActiveEdit?: () => void;
  closeTransientPopover?: () => boolean;
}) {
  const stable = useMemo(
    () => ({
      onDelete: opts.onDelete,
      cancelActiveEdit: opts.cancelActiveEdit ?? (() => {}),
      closeTransientPopover: opts.closeTransientPopover ?? (() => false),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fixed identity for the whole test
    [],
  );
  const gridRef = useGridKeyboard(stable);
  return (
    <div ref={gridRef} tabIndex={0} data-testid="grid-container">
      grid
    </div>
  );
}

describe("useGridKeyboard delete-to-clear (Task 7)", () => {
  it("Delete → onDelete() + preventDefault", () => {
    const onDelete = vi.fn();
    render(<DeleteHarness onDelete={onDelete} />);
    const container = screen.getByTestId("grid-container");

    const evt = new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true });
    container.dispatchEvent(evt);

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(evt.defaultPrevented).toBe(true);
  });

  it("Backspace → onDelete() + preventDefault (browser back-nav suppressed)", () => {
    const onDelete = vi.fn();
    render(<DeleteHarness onDelete={onDelete} />);
    const container = screen.getByTestId("grid-container");

    const evt = new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true });
    container.dispatchEvent(evt);

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(evt.defaultPrevented).toBe(true);
  });

  it("Delete/Backspace pass through untouched when onDelete is absent (parity, no crash, no preventDefault)", () => {
    render(<DeleteHarness />); // no onDelete
    const container = screen.getByTestId("grid-container");

    const del = new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true });
    expect(() => container.dispatchEvent(del)).not.toThrow();
    expect(del.defaultPrevented).toBe(false);

    const back = new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true });
    container.dispatchEvent(back);
    expect(back.defaultPrevented).toBe(false);
  });

  it("Escape still reverts the active cell — the Delete branch sits BEFORE Escape, Escape unaffected", () => {
    const onDelete = vi.fn();
    const cancelActiveEdit = vi.fn();
    render(<DeleteHarness onDelete={onDelete} cancelActiveEdit={cancelActiveEdit} />);
    const container = screen.getByTestId("grid-container");

    const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    container.dispatchEvent(esc);

    expect(cancelActiveEdit).toHaveBeenCalledTimes(1);
    expect(onDelete).not.toHaveBeenCalled();
    expect(esc.defaultPrevented).toBe(true);
  });
});

// ── page-level fixtures + render (mirror grid-type-commit.test.tsx) ───────────

function makeRow(overrides: Partial<GridRow> & { apartmentId: string; unitCode: string }): GridRow {
  return {
    propertyId: "p1",
    propertyName: "Sunway Vista",
    entryId: `${overrides.apartmentId}-entry`,
    preview: null,
    previewError: null,
    warnings: [],
    subRows: [
      {
        listingId: `${overrides.apartmentId}-room-1`,
        tenancyId: `${overrides.apartmentId}-ten-1`,
        partyName: "Tenant",
        previousKwh: "100.00",
        currentKwh: "150.00",
        amount: "25.00",
        ratePerKwh: "0.5000",
        rateConfigured: true,
        rental: "1200.00",
      },
    ],
    isWholeUnit: true,
    billedAt: null,
    paymentStatus: "unpaid",
    priorMonths: [],
    entry: {
      cleaning: "80.00",
      // Recurring-charges (R9): cleaning/WiFi are read-only now; the canonical
      // editable saved-money cell these delete-grain tests use is tnbOwner
      // (entry.tnbTotal), seeded "80.00" so the "saved 80.00" narratives hold.
      tnbTotal: "80.00",
      airSelangor: "40.00",
      wifi: "60.00",
      maintenanceFee: "50.00",
      readingDate: null,
      paymentStatus: "unpaid",
      tnbPattern: "recharged",
      airPattern: "recharged",
      cleaningBearer: "owner",
      wifiBearer: "owner",
      maintenanceFeeBearer: "owner",
      updatedAt: "2026-07-01T00:00:00.000Z",
      lockState: "draft",
    },
    bearerConfig: {
      tnbPattern: "recharged",
      airPattern: "recharged",
      cleaningBearer: "owner",
      wifiBearer: "owner",
      maintenanceFeeBearer: "owner",
      cleaningRecurringAmount: "80.00",
      isLocked: false,
    },
    expenses: { tenant: { total: "0.00", withSstTotal: "0.00", count: 0 }, owner: { total: "0.00", withSstTotal: "0.00", count: 0 } },
    attachments: [],
    ...overrides,
  };
}

function gridResponse(rows: GridRow[], periods: string[] = ["2026-07-01"]): GridResponse {
  return { period: periods[0], periods, rows };
}

const TEST_USER: User = { id: "u1", fullName: "Admin", email: "a@x.test", role: "manager", orgId: "org-1" };

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, refetchOnMount: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <AuthContext.Provider value={{ user: TEST_USER, setAuth: () => {}, clearAuth: () => {}, isAuthenticated: true }}>
        <MemoryRouter initialEntries={["/billing/tenant-owner-billing"]}>
          <BillsGridPage />
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  fetchGrid.mockReset();
  saveEntry.mockReset();
  saveReadings.mockReset();
  billRows.mockReset();
  saveEntry.mockResolvedValue({});
  saveReadings.mockResolvedValue({});
  getBearerConfig.mockResolvedValue({
    apartmentId: "apt-1",
    tnbPattern: "recharged",
    airPattern: "recharged",
    cleaningBearer: "owner",
    wifiBearer: "owner",
    maintenanceFeeBearer: "owner",
    cleaningRecurringAmount: "80.00",
    isLocked: false,
    updatedAt: null,
  });
  listExpenses.mockResolvedValue({ items: [], total: "0.00" });
  listAttachments.mockResolvedValue({ items: [] });
  sessionStorage.clear();
});

afterEach(() => {
  vi.clearAllMocks();
});

// Activate a cell by clicking its <td>; wait for the page focus effect to land.
async function activate(user: ReturnType<typeof userEvent.setup>, unitCode: string, testId: string) {
  const row = screen.getByText(unitCode).closest("tr")!;
  const cell = within(row).getByTestId(testId);
  await user.click(cell);
  await waitFor(() => expect(cell.getAttribute("data-active")).toBe("true"));
  return { row, cell };
}

describe("BillsGridPage delete-to-clear by grain (Task 7, page-wired)", () => {
  it("delete meter blanks — a meter cell with a value → Delete stages '' (Save persists null) via handleCellEdit", async () => {
    const user = userEvent.setup();
    fetchGrid.mockResolvedValue(gridResponse([makeRow({ apartmentId: "apt-1", unitCode: "A-1" })]));
    renderPage();

    await screen.findByText("A-1");
    // A whole-unit row renders its inline meter cells (previousKwh/currentKwh)
    // as editable cells keyed on the sub-row's listingId. Activate currentKwh.
    const { cell } = await activate(user, "A-1", "cell-currentKwh");
    const input = within(cell).getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("150.00");

    // Delete on the grid region → onDelete stages "" for this meter cell (a
    // blank meter reading → Save nulls it). The input must repaint empty.
    const region = screen.getByTestId("grid-region");
    act(() => {
      fireEvent.keyDown(region, { key: "Delete" });
    });
    await waitFor(() => expect(input.value).toBe(""));
    // The blank staged edit is a dirty change (dirtyCount 1) — the Save button
    // label proves it routed through the staged buffer via handleCellEdit.
    await waitFor(() => expect(screen.getByRole("button", { name: /^Save \(1\)$/ })).toBeInTheDocument());
  });

  it("delete saved money no-op cue — a saved entry money cell → Delete stages NOTHING and shows a cue (never a silent '')", async () => {
    const user = userEvent.setup();
    fetchGrid.mockResolvedValue(gridResponse([makeRow({ apartmentId: "apt-1", unitCode: "A-1" })]));
    renderPage();

    await screen.findByText("A-1");
    // tnbOwner is a saved entry-money cell (value "80.00"), editable, not a
    // meter column, and not staged. (cleaning/WiFi are read-only now, so
    // tnbOwner is the editable saved-money subject.)
    const { cell } = await activate(user, "A-1", "cell-tnbOwner");
    const input = within(cell).getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("80.00");

    const region = screen.getByTestId("grid-region");
    act(() => {
      fireEvent.keyDown(region, { key: "Delete" });
    });

    // The cue fired…
    await waitFor(() => expect(toastInfo).toHaveBeenCalledWith("Delete won't clear a saved amount. Type 0 to set it to zero."));
    // …and NOTHING was staged: the input still shows the saved "80.00" (no ""),
    // and the Save button stays label-less "Save" (dirtyCount 0). This is the
    // money-critical guard: a saved-money Delete must NEVER stage "" (Save would
    // silently drop it), so the clear must be an explicit no-op+cue.
    expect(input.value).toBe("80.00");
    expect(screen.getByRole("button", { name: /^Save$/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Save \(/ })).toBeNull();
  });

  it("delete skips billed — a range spanning an unbilled meter cell + a BILLED apartment's cell blanks only the editable one; the billed one is skipped by owning apartment", async () => {
    const user = userEvent.setup();
    fetchGrid.mockResolvedValue(
      gridResponse([
        makeRow({ apartmentId: "apt-1", unitCode: "A-1" }), // unbilled
        // Task 7 (R7): billed alone no longer locks — paymentStatus "paid" is
        // required too, so this fixture stays a genuine lock case.
        makeRow({ apartmentId: "apt-2", unitCode: "A-2", billedAt: "2026-07-05T00:00:00.000Z", paymentStatus: "paid" }), // BILLED
      ]),
    );
    renderPage();

    await screen.findByText("A-1");
    // Activate apt-1's currentKwh, then Shift+ArrowDown to extend the range down
    // to apt-2's currentKwh (same column, next navigable row). Range now spans
    // both currentKwh cells — one unbilled (apt-1), one billed (apt-2).
    const { cell: a1Cur } = await activate(user, "A-1", "cell-currentKwh");
    const a1Input = within(a1Cur).getByRole("textbox") as HTMLInputElement;
    expect(a1Input.value).toBe("150.00");

    const region = screen.getByTestId("grid-region");
    act(() => {
      fireEvent.keyDown(region, { key: "ArrowDown", shiftKey: true });
    });

    // Guard against a vacuous pass: the range MUST actually span both cells
    // (the selection badge shows "Count 2") so the skip below is a real skip of
    // a billed cell present IN the range, not a range that never reached apt-2.
    await waitFor(() => expect(screen.getByTestId("selection-badge")).toHaveTextContent("Count 2"));

    // Delete over the range.
    act(() => {
      fireEvent.keyDown(region, { key: "Delete" });
    });

    // apt-1's meter (unbilled) blanked…
    await waitFor(() => expect(a1Input.value).toBe(""));
    // …and exactly ONE staged edit exists (apt-1 only) — the billed apt-2 cell
    // was skipped, never staged (Save (1), never Save (2)).
    await waitFor(() => expect(screen.getByRole("button", { name: /^Save \(1\)$/ })).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /^Save \(2\)$/ })).toBeNull();
    // apt-2 (billed) renders its currentKwh as a read-only LockedCell showing
    // the saved value — never blanked, never an editable input.
    const rowA2 = screen.getByText("A-2").closest("tr")!;
    const a2Cur = within(rowA2).getByTestId("cell-currentKwh");
    expect(within(a2Cur).queryByRole("textbox")).toBeNull();
    expect(a2Cur.textContent).toContain("150.00");
    // No network write of any kind — Save stays the explicit persist step.
    expect(saveEntry).not.toHaveBeenCalled();
    expect(saveReadings).not.toHaveBeenCalled();
  });

  it("delete reverts staged — a cell with an uncommitted staged edit → Delete reverts it (removed from staged), not a no-op cue", async () => {
    const user = userEvent.setup();
    fetchGrid.mockResolvedValue(gridResponse([makeRow({ apartmentId: "apt-1", unitCode: "A-1" })]));
    renderPage();

    await screen.findByText("A-1");
    // Type over tnbOwner's saved "80.00" → the page buffer now holds an
    // uncommitted staged edit for this cell (Save (1)). (cleaning/WiFi are
    // read-only now, so tnbOwner is the editable saved-money subject.)
    const { cell } = await activate(user, "A-1", "cell-tnbOwner");
    const input = within(cell).getByRole("textbox") as HTMLInputElement;
    await user.keyboard("42");
    expect(input.value).toBe("42");
    await waitFor(() => expect(screen.getByRole("button", { name: /^Save \(1\)$/ })).toBeInTheDocument());

    // Delete → the staged edit is reverted (unstaged): the input repaints the
    // saved "80.00" and Save drops to its no-dirty label. NO cue (this is the
    // revert grain, not the saved-money no-op grain).
    const region = screen.getByTestId("grid-region");
    act(() => {
      fireEvent.keyDown(region, { key: "Delete" });
    });
    await waitFor(() => expect(input.value).toBe("80.00"));
    await waitFor(() => expect(screen.getByRole("button", { name: /^Save$/ })).toBeInTheDocument());
    expect(toastInfo).not.toHaveBeenCalled();
  });

  it("delete blanks a typed-into meter cell — after typing a value into a meter cell, Delete must VISIBLY blank it (overcome GridTable's internalStaged echo)", async () => {
    const user = userEvent.setup();
    fetchGrid.mockResolvedValue(gridResponse([makeRow({ apartmentId: "apt-1", unitCode: "A-1" })]));
    renderPage();

    await screen.findByText("A-1");
    // Type "999" into currentKwh → GridTable's internalStaged echo (top display
    // precedence) now shows "999", and the page buffer stages "999".
    const { cell } = await activate(user, "A-1", "cell-currentKwh");
    const input = within(cell).getByRole("textbox") as HTMLInputElement;
    await user.keyboard("999");
    expect(input.value).toBe("999");

    // Delete → the meter grain re-blanks it: the input must VISIBLY repaint
    // empty, NOT the typed "999" (internalStaged echo must be cleared too).
    const region = screen.getByTestId("grid-region");
    act(() => {
      fireEvent.keyDown(region, { key: "Delete" });
    });
    await waitFor(() => expect(input.value).toBe(""));
    // Still a dirty blank (Save (1)) — the "" is staged so Save nulls the reading.
    await waitFor(() => expect(screen.getByRole("button", { name: /^Save \(1\)$/ })).toBeInTheDocument());
  });

  it("delete never fires a network write — a meter Delete STAGES ONLY (saveEntry/saveReadings/billRows/fetch all untouched)", async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    fetchGrid.mockResolvedValue(gridResponse([makeRow({ apartmentId: "apt-1", unitCode: "A-1" })]));
    renderPage();

    await screen.findByText("A-1");
    const { cell } = await activate(user, "A-1", "cell-currentKwh");
    const input = within(cell).getByRole("textbox") as HTMLInputElement;

    const region = screen.getByTestId("grid-region");
    act(() => {
      fireEvent.keyDown(region, { key: "Delete" });
    });
    await waitFor(() => expect(input.value).toBe(""));

    // Save stays the explicit persist step — a Delete never writes to the server.
    expect(saveEntry).not.toHaveBeenCalled();
    expect(saveReadings).not.toHaveBeenCalled();
    expect(billRows).not.toHaveBeenCalled();
    // fetchGrid (the initial load) is mocked separately; no OTHER fetch fired.
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it("delete read-only no-op — Delete on a read-only cell (rental) stages nothing and shows no cue", async () => {
    const user = userEvent.setup();
    fetchGrid.mockResolvedValue(gridResponse([makeRow({ apartmentId: "apt-1", unitCode: "A-1" })]));
    renderPage();

    await screen.findByText("A-1");
    // rental is a read-only LockedCell (navigable, editable:false, not meter,
    // not entry-money) → Delete must be a pure no-op: nothing staged, no cue.
    const { cell } = await activate(user, "A-1", "cell-rental");
    expect(within(cell).queryByRole("textbox")).toBeNull(); // read-only, no input

    const region = screen.getByTestId("grid-region");
    act(() => {
      fireEvent.keyDown(region, { key: "Delete" });
    });

    // No stage, no cue — the Save button stays label-less.
    expect(screen.getByRole("button", { name: /^Save$/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Save \(/ })).toBeNull();
    expect(toastInfo).not.toHaveBeenCalled();
  });

  it("delete with no target no-op — Delete before any cell is active and with no range does not crash and leaves the grid open", async () => {
    fetchGrid.mockResolvedValue(gridResponse([makeRow({ apartmentId: "apt-1", unitCode: "A-1" })]));
    renderPage();

    await screen.findByText("A-1");
    const region = screen.getByTestId("grid-region");
    expect(() =>
      act(() => {
        fireEvent.keyDown(region, { key: "Delete" });
      }),
    ).not.toThrow();
    expect(screen.getByText("A-1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Save$/ })).toBeInTheDocument();
    expect(toastInfo).not.toHaveBeenCalled();
  });

  it("delete skips billed meter by owning apartment — a BILLED apartment's own meter (sub-row) cell in the range is skipped, proving owning-apartment (not raw listingId) resolution", async () => {
    const user = userEvent.setup();
    // apt-1 unbilled; apt-2 BILLED. apt-2's currentKwh cellKey is its sub-row's
    // listingId (apt-2-room-1), which is ABSENT from billedApartmentIds — only
    // its OWNING apartmentId (apt-2) is in the lock map. Resolving the billed
    // check by raw cellKey would let this billed meter cell through; resolving
    // by resolveApartmentId (owning apartment) correctly skips it.
    fetchGrid.mockResolvedValue(
      gridResponse([
        makeRow({ apartmentId: "apt-1", unitCode: "A-1" }),
        // Task 7 (R7): billed alone no longer locks — paid required too.
        makeRow({ apartmentId: "apt-2", unitCode: "A-2", billedAt: "2026-07-05T00:00:00.000Z", paymentStatus: "paid" }),
      ]),
    );
    renderPage();

    await screen.findByText("A-1");
    const { cell: a1Cur } = await activate(user, "A-1", "cell-currentKwh");
    const a1Input = within(a1Cur).getByRole("textbox") as HTMLInputElement;

    const region = screen.getByTestId("grid-region");
    act(() => {
      fireEvent.keyDown(region, { key: "ArrowDown", shiftKey: true });
    });
    await waitFor(() => expect(screen.getByTestId("selection-badge")).toHaveTextContent("Count 2"));
    act(() => {
      fireEvent.keyDown(region, { key: "Delete" });
    });

    // apt-1's meter blanked; apt-2's billed meter skipped → only ONE staged edit.
    await waitFor(() => expect(a1Input.value).toBe(""));
    await waitFor(() => expect(screen.getByRole("button", { name: /^Save \(1\)$/ })).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /^Save \(2\)$/ })).toBeNull();
    // apt-2's billed meter cell stays a read-only LockedCell with its saved value.
    const rowA2 = screen.getByText("A-2").closest("tr")!;
    const a2Cur = within(rowA2).getByTestId("cell-currentKwh");
    expect(within(a2Cur).queryByRole("textbox")).toBeNull();
    expect(a2Cur.textContent).toContain("150.00");
  });

  it("delete saved money cue fires once per delete — a range with 2+ saved-money cells shows the cue exactly ONCE, not per cell", async () => {
    const user = userEvent.setup();
    fetchGrid.mockResolvedValue(
      gridResponse([
        makeRow({ apartmentId: "apt-1", unitCode: "A-1" }),
        makeRow({ apartmentId: "apt-2", unitCode: "A-2" }),
      ]),
    );
    renderPage();

    await screen.findByText("A-1");
    // Activate apt-1's cleaningOwner (saved money), Shift+ArrowDown to extend
    // the range to apt-2's cleaningOwner (also saved money) — two saved-money
    // cells, both unbilled, both unstaged.
    await activate(user, "A-1", "cell-cleaningOwner");
    const region = screen.getByTestId("grid-region");
    act(() => {
      fireEvent.keyDown(region, { key: "ArrowDown", shiftKey: true });
    });
    await waitFor(() => expect(screen.getByTestId("selection-badge")).toHaveTextContent("Count 2"));

    act(() => {
      fireEvent.keyDown(region, { key: "Delete" });
    });

    // The cue fires exactly ONCE for the whole Delete, not once per saved-money
    // cell — and nothing was staged (no silent "").
    await waitFor(() => expect(toastInfo).toHaveBeenCalledTimes(1));
    expect(toastInfo).toHaveBeenCalledWith("Delete won't clear a saved amount. Type 0 to set it to zero.");
    expect(screen.getByRole("button", { name: /^Save$/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Save \(/ })).toBeNull();
  });

  it("delete billed saved-money fires NO cue — the first-layer billed-skip suppresses the saved-money cue for a BILLED cell (isolates rule 1 from handleCellEdit's own guard)", async () => {
    const user = userEvent.setup();
    // A SINGLE billed apartment. Its cleaningOwner is a saved-money cell. The
    // saved-money cue (rule 4) is a pure no-op branch that fires BEFORE
    // handleCellEdit is ever consulted — so ONLY the first-layer billed-skip
    // (rule 1) can suppress it for a billed cell. If rule 1 were removed, this
    // billed cleaningOwner would fall through to rule 4 and fire the cue. A
    // single-cell target (no range) sidesteps the cue-once guard entirely, so
    // this test isolates rule 1 with no masking.
    fetchGrid.mockResolvedValue(
      // Task 7 (R7): billed alone no longer locks — paid required too.
      gridResponse([makeRow({ apartmentId: "apt-1", unitCode: "A-1", billedAt: "2026-07-05T00:00:00.000Z", paymentStatus: "paid" })]),
    );
    renderPage();

    await screen.findByText("A-1");
    // Billed → cleaningOwner is a read-only LockedCell (navigable, no input).
    const { cell } = await activate(user, "A-1", "cell-cleaningOwner");
    expect(within(cell).queryByRole("textbox")).toBeNull();

    const region = screen.getByTestId("grid-region");
    act(() => {
      fireEvent.keyDown(region, { key: "Delete" });
    });

    // Rule 1 skipped the billed cell → NO cue at all, and nothing staged.
    // (Any cue would mean the billed cell slipped past rule 1 into the
    // saved-money branch — a money-misleading "Type 0" prompt on locked money.)
    expect(toastInfo).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /^Save \(/ })).toBeNull();
  });
});
