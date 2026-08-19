// P4 Task 4 — keyboard arrow-nav + Esc-cancel via the extended useGridKeyboard
// (scope-guarded, R15). Two layers:
//   1. Hook-level: the grid-container keydown listener routes ArrowUp/Down/Left/
//      Right → onArrow(dir) + preventDefault (suppress container scroll), keeps
//      Escape contained (stopPropagation + preventDefault, never dismiss the
//      grid), and lets everything else (Cmd/Ctrl+K, plain chars) fall through
//      untouched so the layout-level search still opens.
//   2. Page-level: rendering the WIRED page, activating a cell, and firing an
//      arrow on the grid container moves the active cell to the expected cell
//      AND lands document focus on the newly-active editable cell's <input>
//      (scrollIntoView is a jsdom no-op — not asserted).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useMemo } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { GridRow, GridResponse } from "@/api/bills-grid";
import { AuthContext, type User } from "@/lib/auth";
import { useGridKeyboard } from "../use-grid-keyboard";

// ── page mocks (mirror bills-grid-page.test.tsx's harness exactly) ──────────
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

// ── hook-level harness ──────────────────────────────────────────────────────

function KeyboardHarness(opts: {
  onArrow?: (dir: "up" | "down" | "left" | "right") => void;
  cancelActiveEdit?: () => void;
  closeTransientPopover?: () => boolean;
}) {
  const stable = useMemo(
    () => ({
      onArrow: opts.onArrow,
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

describe("useGridKeyboard arrow-nav (Task 4)", () => {
  it("arrow routes to nav: ArrowDown → onArrow('down') and default scroll is prevented", () => {
    const onArrow = vi.fn();
    render(<KeyboardHarness onArrow={onArrow} />);
    const container = screen.getByTestId("grid-container");

    const evt = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
    container.dispatchEvent(evt);

    expect(onArrow).toHaveBeenCalledTimes(1);
    expect(onArrow).toHaveBeenCalledWith("down");
    expect(evt.defaultPrevented).toBe(true);
  });

  it("all four arrows map to their direction", () => {
    const onArrow = vi.fn();
    render(<KeyboardHarness onArrow={onArrow} />);
    const container = screen.getByTestId("grid-container");
    for (const [key, dir] of [
      ["ArrowUp", "up"],
      ["ArrowDown", "down"],
      ["ArrowLeft", "left"],
      ["ArrowRight", "right"],
    ] as const) {
      container.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      expect(onArrow).toHaveBeenLastCalledWith(dir);
    }
    expect(onArrow).toHaveBeenCalledTimes(4);
  });

  it("escape reverts the active cell (cancelActiveEdit) and stays contained", () => {
    const onArrow = vi.fn();
    const cancelActiveEdit = vi.fn();
    render(<KeyboardHarness onArrow={onArrow} cancelActiveEdit={cancelActiveEdit} />);
    const container = screen.getByTestId("grid-container");

    const evt = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    const stopSpy = vi.spyOn(evt, "stopPropagation");
    container.dispatchEvent(evt);

    expect(cancelActiveEdit).toHaveBeenCalledTimes(1);
    expect(onArrow).not.toHaveBeenCalled();
    expect(stopSpy).toHaveBeenCalled(); // never let a parent Dialog/Sheet close the grid
    expect(evt.defaultPrevented).toBe(true);
  });

  it("cmd+k passes through untouched (search still opens)", () => {
    const onArrow = vi.fn();
    render(<KeyboardHarness onArrow={onArrow} />);
    const container = screen.getByTestId("grid-container");

    const meta = new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true });
    const metaStop = vi.spyOn(meta, "stopPropagation");
    container.dispatchEvent(meta);
    expect(meta.defaultPrevented).toBe(false);
    expect(metaStop).not.toHaveBeenCalled();

    const ctrl = new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true });
    const ctrlStop = vi.spyOn(ctrl, "stopPropagation");
    container.dispatchEvent(ctrl);
    expect(ctrl.defaultPrevented).toBe(false);
    expect(ctrlStop).not.toHaveBeenCalled();

    expect(onArrow).not.toHaveBeenCalled();
  });

  it("plain character key passes through untouched", () => {
    const onArrow = vi.fn();
    render(<KeyboardHarness onArrow={onArrow} />);
    const container = screen.getByTestId("grid-container");
    const evt = new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true });
    const stopSpy = vi.spyOn(evt, "stopPropagation");
    container.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(false);
    expect(stopSpy).not.toHaveBeenCalled();
    expect(onArrow).not.toHaveBeenCalled();
  });

  it("arrows pass through when onArrow is not provided (no crash, no preventDefault)", () => {
    render(<KeyboardHarness />); // no onArrow
    const container = screen.getByTestId("grid-container");
    const evt = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
    expect(() => container.dispatchEvent(evt)).not.toThrow();
    expect(evt.defaultPrevented).toBe(false);
  });
});

// ── page-level fixtures + render (mirror bills-grid-page.test.tsx) ───────────

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
      tnbTotal: "150.00",
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
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("BillsGridPage keyboard arrow-nav (Task 4, page-wired)", () => {
  it("ArrowDown moves the active cell to the same column of the next row and focuses its input", async () => {
    const user = userEvent.setup();
    fetchGrid.mockResolvedValue(
      gridResponse([
        makeRow({ apartmentId: "apt-1", unitCode: "A-1" }),
        makeRow({ apartmentId: "apt-2", unitCode: "A-2" }),
      ]),
    );
    renderPage();

    // Both whole-unit rows render an editable tnbOwner <input> (cleaning/WiFi are
    // read-only now). Activate the FIRST row's tnbOwner by clicking its <td>.
    await screen.findByText("A-1");
    const rowA1 = screen.getByText("A-1").closest("tr")!;
    const a1Tnb = within(rowA1).getByTestId("cell-tnbOwner");
    await user.click(a1Tnb);
    await waitFor(() => expect(a1Tnb.getAttribute("data-active")).toBe("true"));

    // ArrowDown on the grid container → active cell moves to apt-2's
    // tnbOwner (same column, next navigable row).
    const region = screen.getByTestId("grid-region");
    act(() => {
      fireEvent.keyDown(region, { key: "ArrowDown" });
    });

    const rowA2 = screen.getByText("A-2").closest("tr")!;
    const a2Tnb = within(rowA2).getByTestId("cell-tnbOwner");
    await waitFor(() => expect(a2Tnb.getAttribute("data-active")).toBe("true"));
    expect(a1Tnb.getAttribute("data-active")).not.toBe("true");
    // The newly-active editable cell's <input> is document.activeElement.
    const a2Input = within(a2Tnb).getByRole("textbox");
    expect(document.activeElement).toBe(a2Input);
  });

  it("ArrowRight moves the active cell to the next navigable column and focuses its input", async () => {
    const user = userEvent.setup();
    fetchGrid.mockResolvedValue(gridResponse([makeRow({ apartmentId: "apt-1", unitCode: "A-1" })]));
    renderPage();

    await screen.findByText("A-1");
    const rowA1 = screen.getByText("A-1").closest("tr")!;
    const a1Cleaning = within(rowA1).getByTestId("cell-cleaningOwner");
    await user.click(a1Cleaning);
    await waitFor(() => expect(a1Cleaning.getAttribute("data-active")).toBe("true"));

    const region = screen.getByTestId("grid-region");
    act(() => {
      fireEvent.keyDown(region, { key: "ArrowRight" });
    });

    // cleaningBearer=owner ⇒ cleaningTenant is a locked "—" (not navigable), so
    // ArrowRight lands on tnbOwner (the next navigable unit-grain editable cell).
    const a1Tnb = within(rowA1).getByTestId("cell-tnbOwner");
    await waitFor(() => expect(a1Tnb.getAttribute("data-active")).toBe("true"));
    expect(a1Cleaning.getAttribute("data-active")).not.toBe("true");
    const tnbInput = within(a1Tnb).getByRole("textbox");
    expect(document.activeElement).toBe(tnbInput);
  });
});
