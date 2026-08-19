// Excel-Web V2 — page-level interaction contract. Renders BillsGridPage and
// exercises the gestures whose whole point is "one grid action, no competing
// native behaviour": native-selection suppression, right-click (preserve /
// activate + custom menu), double-click edit mode, Cmd/Ctrl+A select-all, and
// Cmd/Ctrl+C copy-as-TSV. Pointer/modifier UNIT coverage lives in
// grid-gestures.test.ts; the copy PLANNER in grid-copy.test.ts.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { GridRow, GridEntryDto, GridBearerConfigDto, GridResponse } from "@/api/bills-grid";
import { AuthContext, type User } from "@/lib/auth";
import { toast } from "sonner";

const fetchGridMock = vi.fn();
const saveEntryMock = vi.fn();
const saveReadingsMock = vi.fn();
const billRowsMock = vi.fn();
const getBearerConfigMock = vi.fn();
const listExpensesMock = vi.fn();
const listAttachmentsMock = vi.fn();
vi.mock("@/api/bills-grid", async () => {
  const actual = await vi.importActual<typeof import("@/api/bills-grid")>("@/api/bills-grid");
  return {
    ...actual,
    fetchGrid: (...a: unknown[]) => fetchGridMock(...a),
    saveEntry: (...a: unknown[]) => saveEntryMock(...a),
    saveReadings: (...a: unknown[]) => saveReadingsMock(...a),
    billRows: (...a: unknown[]) => billRowsMock(...a),
    getBearerConfig: (...a: unknown[]) => getBearerConfigMock(...a),
    listExpenses: (...a: unknown[]) => listExpensesMock(...a),
    listAttachments: (...a: unknown[]) => listAttachmentsMock(...a),
  };
});
vi.mock("../export-xlsx", () => ({ exportGridToXlsx: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import BillsGridPage from "../bills-grid-page";

const TEST_USER: User = { id: "u1", fullName: "Admin", email: "a@x.test", role: "manager", orgId: "org-1" };

function makeEntry(partial: Partial<GridEntryDto> = {}): GridEntryDto {
  return {
    cleaning: null, tnbTotal: null, airSelangor: null, wifi: null, maintenanceFee: null,
    // OWNER-borne AIR ("absorbed") on purpose: these tests use airOwner as a convenient
    // EDITABLE anchor cell, and since 2026-08-14 the AIR bearer decides which of the two
    // AIR columns renders (cell-applicability.ts). Tenant-borne AIR would move the
    // editable cell to airTenant and this file's subject would vanish.
    readingDate: null, paymentStatus: "unpaid", tnbPattern: "recharged", airPattern: "absorbed",
    cleaningBearer: "owner", wifiBearer: "owner", maintenanceFeeBearer: "owner",
    updatedAt: "2026-07-01T00:00:00.000Z", lockState: "draft", ...partial,
  };
}
function makeBearerConfig(partial: Partial<GridBearerConfigDto> = {}): GridBearerConfigDto {
  return {
    tnbPattern: "recharged", airPattern: "absorbed", cleaningBearer: "owner", wifiBearer: "owner",
    maintenanceFeeBearer: "owner", cleaningRecurringAmount: "0.00", isLocked: false, ...partial,
  };
}
function pageRow(apartmentId: string, unitCode: string, tnbTotal: string): GridRow {
  return {
    apartmentId, unitCode, propertyId: "PROP1", propertyName: "Sunway Vista", entryId: null,
    preview: null, previewError: null, warnings: [], billedAt: null, paymentStatus: "unpaid",
    priorMonths: [], bearerConfig: makeBearerConfig(), attachments: [], isWholeUnit: true,
    expenses: { tenant: { total: "0.00", withSstTotal: "0.00", count: 0 }, owner: { total: "0.00", withSstTotal: "0.00", count: 0 } },
    entry: makeEntry({ tnbTotal, cleaning: "80.00", airSelangor: "40.00", wifi: "60.00", maintenanceFee: "50.00" }),
    subRows: [{
      listingId: `${apartmentId}-room-1`, tenancyId: `${apartmentId}-ten-1`, partyName: "Tenant",
      previousKwh: "100.00", currentKwh: "150.00", amount: "25.00", ratePerKwh: "0.5000",
      rateConfigured: true, rental: "1200.00",
    }],
  };
}
function pageResponse(rows: GridRow[]): GridResponse {
  return { period: "2026-07-01", periods: ["2026-07-01"], rows };
}
function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, refetchOnMount: false } } });
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
  vi.clearAllMocks();
  getBearerConfigMock.mockResolvedValue({
    apartmentId: "apt-1", tnbPattern: "recharged", airPattern: "recharged", cleaningBearer: "owner",
    wifiBearer: "owner", maintenanceFeeBearer: "owner", cleaningRecurringAmount: "80.00", isLocked: false, updatedAt: null,
  });
  listExpensesMock.mockResolvedValue({ items: [], total: "0.00" });
  listAttachmentsMock.mockResolvedValue({ items: [] });
  fetchGridMock.mockResolvedValue(pageResponse([
    pageRow("apt-1", "A-1", "50.00"),
    pageRow("apt-2", "A-2", "20.00"),
    pageRow("apt-3", "A-3", "30.00"),
  ]));
});

const selected = (el: Element) => el.getAttribute("data-selected") === "true";
const active = (el: Element) => el.getAttribute("data-active") === "true";
const gridRegion = () => screen.getByTestId("grid-region");

describe("bills-grid interaction contract (Excel-Web V2)", () => {
  it("suppresses native text selection: the grid surface carries `select-none`", async () => {
    renderPage();
    // cleaning/WiFi are read-only now, so an editable cell (tnbOwner) is the
    // subject for the in-cell `select-text` re-enable half.
    const cell = (await screen.findAllByTestId("cell-tnbOwner"))[0];
    // The table wrapper ancestor owns select-none (kills the gold ::selection).
    expect(cell.closest(".select-none")).not.toBeNull();
    // …and the editable input re-enables it so in-cell editing keeps a caret.
    expect(within(cell).getByRole("textbox").className).toContain("select-text");
  });

  it("right-click OUTSIDE the selection activates that cell, opens the custom menu, and suppresses the native menu", async () => {
    renderPage();
    await screen.findByText("A-1");
    // cleaning/WiFi are read-only (no pointer selection), so airOwner is the
    // editable cell we plain-select before right-clicking elsewhere.
    const air0 = screen.getAllByTestId("cell-airOwner")[0];
    const tnb0 = screen.getAllByTestId("cell-tnbOwner")[0];

    // Select air0 (single cell).
    fireEvent.pointerDown(air0);
    fireEvent.pointerUp(air0);
    await waitFor(() => expect(selected(air0)).toBe(true));

    // Right-click a DIFFERENT cell → preventDefault (native menu suppressed).
    const notCanceled = fireEvent.contextMenu(tnb0, { clientX: 20, clientY: 20 });
    expect(notCanceled).toBe(false); // preventDefault ran

    // Custom menu opened; the clicked cell is now the (collapsed) selection+active.
    expect(screen.getByTestId("grid-context-menu")).toBeInTheDocument();
    expect(active(tnb0)).toBe(true);
    expect(selected(tnb0)).toBe(true);
    expect(selected(air0)).toBe(false); // collapsed away from the old cell
  });

  it("right-click INSIDE the selection preserves it", async () => {
    renderPage();
    await screen.findByText("A-1");
    // cleaning/WiFi are read-only (no pointer selection), so airOwner is the
    // editable drag endpoint paired with tnbOwner.
    const air0 = screen.getAllByTestId("cell-airOwner")[0];
    const tnb0 = screen.getAllByTestId("cell-tnbOwner")[0];

    // Drag-select a range spanning air0 → tnb0.
    fireEvent.pointerDown(air0);
    fireEvent.pointerEnter(tnb0);
    fireEvent.pointerUp(tnb0);
    await waitFor(() => expect(selected(tnb0)).toBe(true));
    expect(selected(air0)).toBe(true);

    // Right-click a cell INSIDE the range → the range is preserved (not collapsed).
    fireEvent.contextMenu(air0, { clientX: 10, clientY: 10 });
    expect(screen.getByTestId("grid-context-menu")).toBeInTheDocument();
    expect(selected(air0)).toBe(true);
    expect(selected(tnb0)).toBe(true);
  });

  it("double-click enters edit mode: arrows then move the caret in the field, NOT the active cell", async () => {
    renderPage();
    await screen.findByText("A-1");
    // cleaning/WiFi are read-only (no double-click-to-edit), so the editable
    // double-click subject is airOwner; tnbOwner is the "did not jump here" cell.
    const air0 = screen.getAllByTestId("cell-airOwner")[0];
    const tnb0 = screen.getAllByTestId("cell-tnbOwner")[0];

    // Navigation mode: a plain click + ArrowRight MOVES the active cell.
    fireEvent.click(air0);
    await waitFor(() => expect(active(air0)).toBe(true));
    fireEvent.keyDown(gridRegion(), { key: "ArrowRight" });
    await waitFor(() => expect(active(air0)).toBe(false)); // moved off

    // Edit mode: double-click → ArrowRight is released to the input, active stays.
    fireEvent.doubleClick(air0);
    await waitFor(() => expect(active(air0)).toBe(true));
    fireEvent.keyDown(gridRegion(), { key: "ArrowRight" });
    expect(active(air0)).toBe(true); // did NOT navigate — caret move belongs to the input
    expect(active(tnb0)).toBe(false);
  });

  it("Ctrl/Cmd+A selects every navigable cell (not the page's text); read-only cells join the block", async () => {
    renderPage();
    await screen.findByText("A-1");

    fireEvent.keyDown(gridRegion(), { key: "a", ctrlKey: true });

    await waitFor(() => {
      // every editable unit cell selected…
      expect(screen.getAllByTestId("cell-cleaningOwner").every(selected)).toBe(true);
    });
    // …and the read-only Amount cell too (consistent block, V2).
    expect(selected(screen.getAllByTestId("cell-amount")[0])).toBe(true);
  });

  it("Ctrl/Cmd+C copies the selected rectangular range to the clipboard as TSV", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    renderPage();
    await screen.findByText("A-1");
    // cleaning/WiFi are read-only now, so copy a single editable cell (tnbOwner).
    const tnb0 = screen.getAllByTestId("cell-tnbOwner")[0];
    const tnb0Value = within(tnb0).getByRole("textbox").getAttribute("value") ?? "";

    fireEvent.pointerDown(tnb0);
    fireEvent.pointerUp(tnb0);
    await waitFor(() => expect(selected(tnb0)).toBe(true));

    fireEvent.keyDown(gridRegion(), { key: "c", ctrlKey: true });
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(tnb0Value);
    expect(toast.success).toHaveBeenCalled();
  });

  it("clicking a sub-column header selects that whole column (all rows), and seats the active cell at its top", async () => {
    renderPage();
    await screen.findByText("A-1");

    fireEvent.click(screen.getByTestId("col-header-tnbOwner"));

    await waitFor(() => expect(screen.getAllByTestId("cell-tnbOwner").every(selected)).toBe(true));
    // other columns are NOT selected (only the clicked column)
    expect(selected(screen.getAllByTestId("cell-cleaningOwner")[0])).toBe(false);
    // active seated at the top cell of the column
    expect(active(screen.getAllByTestId("cell-tnbOwner")[0])).toBe(true);
  });

  it("clicking a BAND header (e.g. TNB) selects every sub-column under it (Owner + Previous + Current + Amount), all rows", async () => {
    renderPage();
    await screen.findByText("A-1");

    fireEvent.click(screen.getByText("TNB"));

    await waitFor(() => expect(selected(screen.getAllByTestId("cell-tnbOwner")[0])).toBe(true));
    // …the meter columns and the read-only Amount under the same band, too
    expect(selected(screen.getAllByTestId("cell-previousKwh")[0])).toBe(true);
    expect(selected(screen.getAllByTestId("cell-currentKwh")[0])).toBe(true);
    expect(selected(screen.getAllByTestId("cell-amount")[0])).toBe(true);
    // …across every row
    expect(screen.getAllByTestId("cell-tnbOwner").every(selected)).toBe(true);
    // a column outside the band is untouched
    expect(selected(screen.getAllByTestId("cell-cleaningOwner")[0])).toBe(false);
  });

  it("Ctrl/Cmd+click a second column header ADDS it (non-contiguous), never replacing the first", async () => {
    renderPage();
    await screen.findByText("A-1");

    fireEvent.click(screen.getByTestId("col-header-cleaningOwner"));
    await waitFor(() => expect(selected(screen.getAllByTestId("cell-cleaningOwner")[0])).toBe(true));

    fireEvent.click(screen.getByTestId("col-header-tnbOwner"), { ctrlKey: true });
    await waitFor(() => expect(selected(screen.getAllByTestId("cell-tnbOwner")[0])).toBe(true));
    // the first column is STILL selected (added, not replaced)
    expect(screen.getAllByTestId("cell-cleaningOwner").every(selected)).toBe(true);
  });

  it("a non-contiguous (ctrl-added) selection refuses to copy and cues the user instead", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    renderPage();
    await screen.findByText("A-1");
    // cleaning/WiFi are read-only now, so the two disjoint editable cells are
    // tnbOwner + maintenanceFee.
    const tnb0 = screen.getAllByTestId("cell-tnbOwner")[0];
    const maint2 = screen.getAllByTestId("cell-maintenanceFee")[2];

    // Two disjoint cells (ctrl-add) → the bbox has unselected navigable cells.
    fireEvent.pointerDown(tnb0);
    fireEvent.pointerUp(tnb0);
    fireEvent.pointerDown(maint2, { ctrlKey: true });
    fireEvent.pointerUp(maint2);
    await waitFor(() => expect(selected(maint2)).toBe(true));
    expect(selected(tnb0)).toBe(true);

    fireEvent.keyDown(gridRegion(), { key: "c", ctrlKey: true });
    expect(writeText).not.toHaveBeenCalled(); // never silently flattened
    expect(toast.info).toHaveBeenCalled(); // cue shown
  });
});
