// A SETTLED month must still accept a NEW charge — the "tenant paid, then broke
// something" case.
//
// Slice 3 (cd3e0027) narrowed the grid's lock from the ROW to the CELL, but only in
// grid-table.tsx (render) and nav-cells.ts (keyboard). Every WRITE gate in
// bills-grid-page.tsx stayed row-grain on `isRowLocked`:
//
//   • handleCellEdit          — refuses to stage  ⇒ dirtyCount stays 0 ⇒ Save disabled
//   • onDelete / Save translate / Save preview
//   • billableRows            — no Bill checkbox  ⇒ the amendment can never be re-Billed
//
// So the admin sees a live <input> over a cell that silently swallows every keystroke,
// and a settled row with no route back onto a document — even though the server (flag ON)
// accepts both: createExpensesService's entry-wide ENTRY_LOCKED is flag-gated off, and
// rebillSupersedeTx withholds the paid lines and re-mints the rest onto a fresh proforma.
//
// The fixture is the user's actual shape: everything that WAS billed is settled, and the
// bucket for the new charge is "none" (never charged this month), which is precisely why
// isCellLocked leaves that one cell open while isRowLocked calls the whole row frozen.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

import type { GridRow, GridResponse, GridEntryDto } from "@/api/bills-grid";
import { emptySettlementCells, type SettlementBucket, type SettlementState } from "@kason/shared";
import { AuthContext, type User } from "@/lib/auth";

const savePref = vi.fn();
const loadPref = vi.fn((_ns: string, _key: string, fallback: unknown) => fallback);
vi.mock("@/lib/view-prefs", () => ({
  loadPref: (...args: [string, string, unknown]) => loadPref(...args),
  savePref: (...args: [string, string, unknown]) => savePref(...args),
  loadCellColours: () => ({}),
  saveCellColours: () => {},
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

const PROFORMA_FLAG = "VITE_ENABLE_PROFORMA_INVOICES";

/** Settlement fixture: every bucket "none" unless named. */
function settlement(status: SettlementState, cells: Partial<Record<SettlementBucket, SettlementState>>) {
  return { status, cells: { ...emptySettlementCells(), ...cells }, rooms: {}, expenseLines: {} };
}

/**
 * A unit whose July bill was issued AND fully settled. Water was never billed this
 * month (`airSelangor: null`, bucket `airOwner: "none"`), so `airOwner` is the cell the
 * per-cell lock legitimately leaves open for the repair charge.
 */
function settledRow(entryOverrides: Partial<GridEntryDto> = {}): GridRow {
  return {
    apartmentId: "APT1",
    unitCode: "PV9 A-13-13",
    propertyId: "p1",
    propertyName: "Sunway Vista",
    entryId: "APT1-entry",
    preview: null,
    previewError: null,
    warnings: [],
    subRows: [{
      listingId: "APT1-room-1", tenancyId: "APT1-ten-1", partyName: "Tenant",
      previousKwh: "100.00", currentKwh: "150.00", amount: "25.00",
      ratePerKwh: "0.5000", rateConfigured: true, rental: "1200.00",
    }],
    isWholeUnit: true,
    billedAt: "2026-07-20T00:00:00.000Z",
    // The MANUAL column is deliberately left "unpaid": real settlement is what freezes
    // the row now, and the server's saveEntry guard reads only this manual column — so a
    // save here would actually be ACCEPTED. The client is over-refusing.
    paymentStatus: "unpaid",
    settlement: settlement("paid", {
      tnbTenant: "paid", cleaningOwner: "paid", wifiOwner: "paid", maintenanceOwner: "paid",
    }),
    priorMonths: [],
    entry: {
      cleaning: "80.00", tnbTotal: "150.00", airSelangor: null, wifi: "60.00",
      maintenanceFee: "50.00", readingDate: null, paymentStatus: "unpaid",
      tnbPattern: "recharged", airPattern: "absorbed",
      cleaningBearer: "owner", wifiBearer: "owner", maintenanceFeeBearer: "owner",
      updatedAt: "2026-07-01T00:00:00.000Z", lockState: "draft",
      ...entryOverrides,
    },
    bearerConfig: {
      tnbPattern: "recharged", airPattern: "absorbed", cleaningBearer: "owner",
      wifiBearer: "owner", maintenanceFeeBearer: "owner",
      cleaningRecurringAmount: "80.00", isLocked: false,
    },
    expenses: {
      tenant: { total: "0.00", withSstTotal: "0.00", count: 0 },
      owner: { total: "0.00", withSstTotal: "0.00", count: 0 },
    },
    attachments: [],
  };
}

function gridResponse(rows: GridRow[]): GridResponse {
  return { period: "2026-07-01", periods: ["2026-07-01"], rows };
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
  vi.stubEnv(PROFORMA_FLAG, "true");
  fetchGrid.mockReset();
  saveEntry.mockReset();
  saveReadings.mockReset();
  billRows.mockReset();
  getBearerConfig.mockReset();
  listExpenses.mockReset();
  listAttachments.mockReset();
  sessionStorage.clear();
  fetchGrid.mockResolvedValue(gridResponse([settledRow()]));
  getBearerConfig.mockResolvedValue({});
  listExpenses.mockResolvedValue({ items: [] });
  listAttachments.mockResolvedValue({ items: [] });
});
afterEach(() => vi.unstubAllEnvs());

describe("settled month — amend + re-Bill (flag ON)", () => {
  it("renders a live input over the never-charged cell", async () => {
    renderPage();
    await screen.findByText("PV9 A-13-13");
    // Render half (already shipped in cd3e0027) — this is the affordance the admin sees.
    expect(within(screen.getAllByTestId("cell-airOwner")[0]).queryByRole("textbox")).not.toBeNull();
  });

  it("typing into that cell arms Save", async () => {
    renderPage();
    await screen.findByText("PV9 A-13-13");

    const airInput = within(screen.getAllByTestId("cell-airOwner")[0]).getByRole("textbox");
    fireEvent.change(airInput, { target: { value: "180.00" } });

    // THE BUG: handleCellEdit drops the stage because the ROW is settled, so dirtyCount
    // never leaves 0 and the toolbar's gold Save stays disabled. The admin's repair
    // charge is swallowed with no cue at all.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^save/i })).toBeEnabled();
    });
  });

  it("offers the settled row a Bill checkbox so the amendment can be re-Billed", async () => {
    renderPage();
    await screen.findByText("PV9 A-13-13");

    // THE BUG: billableRows filters on isRowLocked, so a settled row is excluded from the
    // billable set entirely — the checkbox is absent and Bill can never be armed, even
    // though partial re-Bill withholds the paid lines and re-mints the rest.
    expect(screen.queryByTestId("bill-select-APT1")).not.toBeNull();
  });

  it("checking that box and pressing Bill actually re-Bills the settled unit", async () => {
    billRows.mockResolvedValue({ results: [{ apartmentId: "APT1", outcome: "reinvoiced" }] });
    renderPage();
    await screen.findByText("PV9 A-13-13");

    fireEvent.click(screen.getByTestId("bill-select-APT1"));
    fireEvent.click(screen.getByRole("button", { name: /^bill/i }));

    // The whole point of the checkbox. The server decides whether this particular
    // re-Bill is allowed (it withholds the paid lines and re-mints the rest); the client's
    // job is simply to stop making the attempt impossible.
    await waitFor(() => expect(billRows).toHaveBeenCalledTimes(1));
    const [payload] = billRows.mock.calls[0] as [{ rows: { apartmentId: string }[] }];
    expect(payload.rows.map((r) => r.apartmentId)).toEqual(["APT1"]);
  });

  it("saves ONLY the unfrozen field — the settled money never reaches the wire", async () => {
    saveEntry.mockResolvedValue({ id: "E1", updatedAt: "2026-07-02T00:00:00.000Z" });
    renderPage();
    await screen.findByText("PV9 A-13-13");

    fireEvent.change(within(screen.getAllByTestId("cell-airOwner")[0]).getByRole("textbox"), {
      target: { value: "180.00" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^save/i }));
    fireEvent.click(await screen.findByTestId("save-confirm-btn"));

    await waitFor(() => expect(saveEntry).toHaveBeenCalledTimes(1));
    const [, patch] = saveEntry.mock.calls[0] as [string, Record<string, string>];
    expect(patch).toMatchObject({ airSelangor: "180.00" });
    // The settled buckets' wire fields must be absent — not merely unchanged. Sending a
    // paid component's amount is what makes the NEXT partial re-Bill refuse the month
    // (service.ts `changedPaid`), so the whole point is that they never leave the client.
    expect(patch).not.toHaveProperty("cleaning");
    expect(patch).not.toHaveProperty("wifi");
    expect(patch).not.toHaveProperty("tnbTotal");
    expect(patch).not.toHaveProperty("maintenanceFee");
  });
});

describe("settled month — the fix must NOT widen the lock", () => {
  it("a settled cell still refuses the edit and never arms Save", async () => {
    renderPage();
    await screen.findByText("PV9 A-13-13");

    // `cleaningOwner` IS paid. The render freezes it, so there is no input to type into —
    // and that is the assertion: narrowing the WRITE gate must not open a paid cell.
    expect(within(screen.getAllByTestId("cell-cleaningOwner")[0]).queryByRole("textbox")).toBeNull();
    expect(screen.getByRole("button", { name: /^save/i })).toBeDisabled();
  });

  it("a part-paid row freezes the paid cell while the unpaid one stays writable", async () => {
    const row = settledRow({ airSelangor: "40.00" });
    // Electricity settled, water outstanding — the exact case partial re-Bill exists for.
    row.settlement = settlement("partial", { tnbTenant: "paid", airOwner: "unpaid" });
    fetchGrid.mockResolvedValue(gridResponse([row]));

    renderPage();
    await screen.findByText("PV9 A-13-13");

    // Paid electricity: the TNB cell (and the meter cells that re-price it) stay frozen.
    expect(within(screen.getAllByTestId("cell-tnbOwner")[0]).queryByRole("textbox")).toBeNull();
    expect(within(screen.getAllByTestId("cell-currentKwh")[0]).queryByRole("textbox")).toBeNull();

    // Outstanding water: editable, and the edit must reach the buffer.
    fireEvent.change(within(screen.getAllByTestId("cell-airOwner")[0]).getByRole("textbox"), {
      target: { value: "55.00" },
    });
    await waitFor(() => expect(screen.getByRole("button", { name: /^save/i })).toBeEnabled());
  });
});

describe("settled month — flag OFF is unchanged", () => {
  beforeEach(() => {
    vi.stubEnv(PROFORMA_FLAG, "false");
  });

  it("keeps the whole-row freeze and offers no Bill checkbox", async () => {
    renderPage();
    await screen.findByText("PV9 A-13-13");

    // Without partial re-Bill there is no route for an edit onto a document, so the
    // never-charged cell must stay shut and the row must stay unbillable — exactly the
    // pre-slice-3 behaviour. Unlocking either here would hand the admin a 409 they could
    // not have predicted.
    expect(within(screen.getAllByTestId("cell-airOwner")[0]).queryByRole("textbox")).toBeNull();
    expect(screen.getByRole("button", { name: /^save/i })).toBeDisabled();
    expect(screen.queryByTestId("bill-select-APT1")).toBeNull();
  });
});
