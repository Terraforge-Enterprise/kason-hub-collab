// P4 Task 5 — type-to-edit + Enter/Tab commit-and-move + Esc-revert on the
// MONEY-CRITICAL bills-grid. Three layers, each money-guarded:
//   1. Hook-level (useGridKeyboard): Enter → onCommitMove("down", shift), Tab →
//      onCommitMove("right", shift), both preventDefault, positioned BEFORE the
//      Escape branch. Absent onCommitMove ⇒ pass through (parity).
//   2. Buffer-level (useStagedEdits): unstage(cellKey, columnId) removes exactly
//      one key + persists; the rest of the buffer is untouched.
//   3. Page-level (wired BillsGridPage): typing REPLACES the active cell's prior
//      text (input .select()ed on activate) and stages via handleCellEdit; Enter
//      moves down / Tab moves right WITHOUT any network request (stage only);
//      Esc VISIBLY reverts the active cell to its saved value (overcoming
//      GridTable's internalStaged top display-precedence); a billed apartment's
//      typed edit is still dropped by the handleCellEdit guard.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useMemo } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { GridRow, GridResponse } from "@/api/bills-grid";
import { AuthContext, type User } from "@/lib/auth";
import { useGridKeyboard } from "../use-grid-keyboard";

// ── page mocks (mirror grid-keyboard-nav.test.tsx's harness exactly) ─────────
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
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import BillsGridPage from "../bills-grid-page";

// ── hook-level harness (Enter/Tab → onCommitMove, BEFORE the Escape branch) ──

function CommitHarness(opts: {
  onCommitMove?: (dir: "down" | "right", shift: boolean) => void;
  cancelActiveEdit?: () => void;
  closeTransientPopover?: () => boolean;
}) {
  const stable = useMemo(
    () => ({
      onCommitMove: opts.onCommitMove,
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

describe("useGridKeyboard commit-and-move (Task 5)", () => {
  it("Enter → onCommitMove('down', false) + preventDefault; Tab → onCommitMove('right', false) + preventDefault", () => {
    const onCommitMove = vi.fn();
    render(<CommitHarness onCommitMove={onCommitMove} />);
    const container = screen.getByTestId("grid-container");

    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    container.dispatchEvent(enter);
    expect(onCommitMove).toHaveBeenNthCalledWith(1, "down", false);
    expect(enter.defaultPrevented).toBe(true);

    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    container.dispatchEvent(tab);
    expect(onCommitMove).toHaveBeenNthCalledWith(2, "right", false);
    expect(tab.defaultPrevented).toBe(true);
  });

  it("Shift+Enter → onCommitMove('down', true); Shift+Tab → onCommitMove('right', true)", () => {
    const onCommitMove = vi.fn();
    render(<CommitHarness onCommitMove={onCommitMove} />);
    const container = screen.getByTestId("grid-container");

    container.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true }));
    expect(onCommitMove).toHaveBeenNthCalledWith(1, "down", true);

    container.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
    expect(onCommitMove).toHaveBeenNthCalledWith(2, "right", true);
  });

  it("Enter/Tab pass through untouched when onCommitMove is absent (parity, no crash, no preventDefault)", () => {
    render(<CommitHarness />); // no onCommitMove
    const container = screen.getByTestId("grid-container");
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    expect(() => container.dispatchEvent(enter)).not.toThrow();
    expect(enter.defaultPrevented).toBe(false);
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    container.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
  });

  it("Escape still reverts the active cell (cancelActiveEdit) — commit branches sit BEFORE it, Escape unaffected", () => {
    const onCommitMove = vi.fn();
    const cancelActiveEdit = vi.fn();
    render(<CommitHarness onCommitMove={onCommitMove} cancelActiveEdit={cancelActiveEdit} />);
    const container = screen.getByTestId("grid-container");
    const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    container.dispatchEvent(esc);
    expect(cancelActiveEdit).toHaveBeenCalledTimes(1);
    expect(onCommitMove).not.toHaveBeenCalled();
    expect(esc.defaultPrevented).toBe(true);
  });
});

// ── page-level fixtures + render (mirror grid-keyboard-nav.test.tsx) ──────────

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
      // editable money cell these tests type into is tnbOwner (entry.tnbTotal),
      // seeded to "80.00" so the "over saved 80.00" narratives stay verbatim.
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

// Activates a cell by clicking its <td>, waits for the page focus effect to
// land AND for the input's own text to be selected (select-on-activate). Returns
// the cell + its <input>. Targets tnbOwner (cleaning/WiFi are read-only now, so
// the canonical editable unit-grain money cell is tnbOwner).
async function activateTnb(user: ReturnType<typeof userEvent.setup>, unitCode: string) {
  const row = screen.getByText(unitCode).closest("tr")!;
  const cell = within(row).getByTestId("cell-tnbOwner");
  await user.click(cell);
  await waitFor(() => expect(cell.getAttribute("data-active")).toBe("true"));
  const input = within(cell).getByRole("textbox") as HTMLInputElement;
  return { row, cell, input };
}

describe("BillsGridPage type-to-edit (Task 5, page-wired)", () => {
  it("type replaces and stages — activating a cell selects its full text so the first keystroke overwrites the saved value, staged via handleCellEdit", async () => {
    const user = userEvent.setup();
    fetchGrid.mockResolvedValue(gridResponse([makeRow({ apartmentId: "apt-1", unitCode: "A-1" })]));
    renderPage();

    await screen.findByText("A-1");
    const { input } = await activateTnb(user, "A-1");
    // Saved tnbTotal is "80.00" — the input paints it.
    expect(input.value).toBe("80.00");

    // On activate the input's full text is selected (Excel type-to-replace),
    // so a single typed char replaces "80.00" wholesale rather than appending.
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe("80.00".length);

    // Typing "5" REPLACES the selection (jsdom honours selection on input) →
    // value becomes "5", staged via the existing onChange → handleCellEdit path.
    await user.keyboard("5");
    expect(input.value).toBe("5");
    // dirtyCount surfaces in the toolbar's Save button label once staged
    // (proves the value routed through handleCellEdit → stage).
    await waitFor(() => expect(screen.getByRole("button", { name: /^Save \(1\)$/ })).toBeInTheDocument());
  });

  it("activate focuses AND selects text — the page focus effect focuses the input while EditableCell selects its text (both land, Hard Point A)", async () => {
    const user = userEvent.setup();
    fetchGrid.mockResolvedValue(gridResponse([makeRow({ apartmentId: "apt-1", unitCode: "A-1" })]));
    renderPage();

    await screen.findByText("A-1");
    const { input } = await activateTnb(user, "A-1");

    // (1) page focus effect: the active input is document.activeElement.
    await waitFor(() => expect(document.activeElement).toBe(input));
    // (2) select-on-activate: the input's full text is selected — the two
    // effects coexist, they don't fight each other.
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe("80.00".length);
  });
});

describe("BillsGridPage commit-and-move (Task 5, page-wired)", () => {
  it("enter down tab right — a typed value is staged; Enter moves the active cell DOWN, Tab moves it RIGHT", async () => {
    const user = userEvent.setup();
    fetchGrid.mockResolvedValue(
      gridResponse([
        makeRow({ apartmentId: "apt-1", unitCode: "A-1" }),
        makeRow({ apartmentId: "apt-2", unitCode: "A-2" }),
      ]),
    );
    renderPage();

    await screen.findByText("A-1");
    const { cell: a1Tnb, input: a1Input } = await activateTnb(user, "A-1");

    // Type over the selected saved value → staged (already proven in B1).
    await user.keyboard("99");
    expect(a1Input.value).toBe("99");

    const region = screen.getByTestId("grid-region");

    // Enter → commit (stage-only) + move DOWN → apt-2's tnbOwner active.
    act(() => {
      fireEvent.keyDown(region, { key: "Enter" });
    });
    const rowA2 = screen.getByText("A-2").closest("tr")!;
    const a2Tnb = within(rowA2).getByTestId("cell-tnbOwner");
    await waitFor(() => expect(a2Tnb.getAttribute("data-active")).toBe("true"));
    expect(a1Tnb.getAttribute("data-active")).not.toBe("true");
    // The staged value on A-1 survived the commit (Enter never reverts).
    await waitFor(() => expect(screen.getByRole("button", { name: /^Save \(1\)$/ })).toBeInTheDocument());

    // Tab → move RIGHT from apt-2's tnbOwner → the next navigable cell, its
    // inline meter column previousKwh (whole-unit rows render the meter inline).
    act(() => {
      fireEvent.keyDown(region, { key: "Tab" });
    });
    const a2Prev = within(rowA2).getByTestId("cell-previousKwh");
    await waitFor(() => expect(a2Prev.getAttribute("data-active")).toBe("true"));
    expect(a2Tnb.getAttribute("data-active")).not.toBe("true");
  });

  it("shift enter up shift tab left — Shift+Enter moves UP, Shift+Tab moves LEFT", async () => {
    const user = userEvent.setup();
    fetchGrid.mockResolvedValue(
      gridResponse([
        makeRow({ apartmentId: "apt-1", unitCode: "A-1" }),
        makeRow({ apartmentId: "apt-2", unitCode: "A-2" }),
      ]),
    );
    renderPage();

    await screen.findByText("A-2");
    // Start on A-2's tnbOwner so there's room to move up (row) and left (col).
    const rowA2 = screen.getByText("A-2").closest("tr")!;
    const a2Tnb = within(rowA2).getByTestId("cell-tnbOwner");
    await user.click(a2Tnb);
    await waitFor(() => expect(a2Tnb.getAttribute("data-active")).toBe("true"));

    const region = screen.getByTestId("grid-region");

    // Shift+Tab → move LEFT → A-2's cleaningOwner.
    act(() => {
      fireEvent.keyDown(region, { key: "Tab", shiftKey: true });
    });
    const a2Cleaning = within(rowA2).getByTestId("cell-cleaningOwner");
    await waitFor(() => expect(a2Cleaning.getAttribute("data-active")).toBe("true"));

    // Shift+Enter → move UP → A-1's cleaningOwner (same column, previous row).
    act(() => {
      fireEvent.keyDown(region, { key: "Enter", shiftKey: true });
    });
    const rowA1 = screen.getByText("A-1").closest("tr")!;
    const a1Cleaning = within(rowA1).getByTestId("cell-cleaningOwner");
    await waitFor(() => expect(a1Cleaning.getAttribute("data-active")).toBe("true"));
    expect(a2Cleaning.getAttribute("data-active")).not.toBe("true");
  });

  it("enter does not save — a commit (Enter) STAGES ONLY and issues NO network request (saveEntry/saveReadings/billRows/fetch all untouched)", async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    fetchGrid.mockResolvedValue(
      gridResponse([
        makeRow({ apartmentId: "apt-1", unitCode: "A-1" }),
        makeRow({ apartmentId: "apt-2", unitCode: "A-2" }),
      ]),
    );
    renderPage();

    await screen.findByText("A-1");
    const { input: a1Input } = await activateTnb(user, "A-1");
    await user.keyboard("77");
    expect(a1Input.value).toBe("77");

    const region = screen.getByTestId("grid-region");
    act(() => {
      fireEvent.keyDown(region, { key: "Enter" });
    });
    // active cell moved (commit happened)…
    const rowA2 = screen.getByText("A-2").closest("tr")!;
    await waitFor(() => expect(within(rowA2).getByTestId("cell-tnbOwner").getAttribute("data-active")).toBe("true"));

    // …but Save stays the explicit persist step — NO write of any kind fired.
    expect(saveEntry).not.toHaveBeenCalled();
    expect(saveReadings).not.toHaveBeenCalled();
    expect(billRows).not.toHaveBeenCalled();
    // fetchGrid is the initial load (allowed); no OTHER fetch fired for the commit.
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});

describe("BillsGridPage Esc-revert (Task 5, page-wired)", () => {
  it("esc reverts active — after typing '42' over saved '80.00', Escape VISIBLY reverts the input to '80.00' (overcomes internalStaged precedence) and the cell stays active", async () => {
    const user = userEvent.setup();
    fetchGrid.mockResolvedValue(gridResponse([makeRow({ apartmentId: "apt-1", unitCode: "A-1" })]));
    renderPage();

    await screen.findByText("A-1");
    const { cell, input } = await activateTnb(user, "A-1");
    expect(input.value).toBe("80.00");

    // Type over the selected saved value → GridTable's internalStaged echo (top
    // display precedence) now shows "42", and the page buffer stages "42" too.
    await user.keyboard("42");
    expect(input.value).toBe("42");
    await waitFor(() => expect(screen.getByRole("button", { name: /^Save \(1\)$/ })).toBeInTheDocument());

    // Escape → revertActiveEdit unstages the page buffer AND clears GridTable's
    // internalStaged echo — the input must VISIBLY repaint the saved "80.00",
    // NOT the typed "42" (this is the Hard-Point-B assertion: unstage alone
    // would leave "42" visible because internalStaged wins the precedence).
    const region = screen.getByTestId("grid-region");
    act(() => {
      fireEvent.keyDown(region, { key: "Escape" });
    });
    await waitFor(() => expect(input.value).toBe("80.00"));

    // The cell stays active (Escape reverts ONE cell, never dismisses the grid).
    expect(cell.getAttribute("data-active")).toBe("true");
    // The staged edit is gone → Save reverts to its no-dirty label.
    await waitFor(() => expect(screen.getByRole("button", { name: /^Save$/ })).toBeInTheDocument());
  });

  it("esc with no active cell no-op — Escape before any cell is activated does not crash and leaves the grid open", async () => {
    fetchGrid.mockResolvedValue(gridResponse([makeRow({ apartmentId: "apt-1", unitCode: "A-1" })]));
    renderPage();

    await screen.findByText("A-1");
    const region = screen.getByTestId("grid-region");
    expect(() =>
      act(() => {
        fireEvent.keyDown(region, { key: "Escape" });
      }),
    ).not.toThrow();
    // grid still rendered.
    expect(screen.getByText("A-1")).toBeInTheDocument();
  });
});

describe("BillsGridPage money guard intact (Task 5)", () => {
  it("billed cell typed edit rejected — a billed apartment's cell is read-only (no <input>), so a typed edit can never reach the staged buffer via the handleCellEdit chokepoint", async () => {
    const user = userEvent.setup();
    // A billed AND FULLY PAID apartment: billedAt set + paymentStatus "paid" →
    // GridTable renders its cells as read-only LockedCells (no <input>), and
    // handleCellEdit fail-closes on billedApartmentIds even if a stage were
    // somehow attempted. Task 7 (R7): billed alone no longer locks — paid is
    // required too, so this fixture must set both to stay a genuine lock case.
    fetchGrid.mockResolvedValue(
      gridResponse([
        makeRow({ apartmentId: "apt-1", unitCode: "A-1", billedAt: "2026-07-05T00:00:00.000Z", paymentStatus: "paid" }),
      ]),
    );
    renderPage();

    await screen.findByText("A-1");
    const row = screen.getByText("A-1").closest("tr")!;
    const cell = within(row).getByTestId("cell-cleaningOwner");
    // Billed → the cell is a read-only LockedCell: it shows the saved value as
    // text and has NO editable <input> to type into.
    expect(within(cell).queryByRole("textbox")).toBeNull();
    expect(cell.textContent).toContain("80.00");

    // Activate it (read-only cells are still navigable) and attempt to type —
    // there is no input to receive it, and even a programmatic stage would be
    // dropped by handleCellEdit's billed guard. Nothing stages: dirtyCount 0.
    await user.click(cell);
    await user.keyboard("999");
    expect(screen.getByRole("button", { name: /^Save$/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Save \(/ })).toBeNull();
  });
});
