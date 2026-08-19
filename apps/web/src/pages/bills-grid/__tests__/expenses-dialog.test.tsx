// UI Task 6 — ExpensesDialog. 6 acceptance rows per the brief. A stateful
// listExpenses/createExpenses mock (rather than canned fixtures) proves the
// "total only" round-trip: Save writes into the same store listExpenses reads
// back from, so the post-save cell genuinely reflects the 3 saved lines
// instead of a pre-baked second response.
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ComponentProps } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthContext, type User } from "@/lib/auth";
import { GRID_QUERY_KEY_ROOT, type ExpenseListItem } from "@/api/bills-grid";
import { ExpensesDialog, type ExpensesDialogTenancyOption } from "../expenses-dialog";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const mockListExpenses = vi.fn();
const mockCreateExpenses = vi.fn();
const mockUpdateExpense = vi.fn();
const mockVoidExpense = vi.fn();
// T1 Task 6 — the per-line attachment client fns are also stubbed so the
// real raw-`fetch`/`gridFetch` never fires when <LineAttachments> mounts on a
// row (its list query becomes enabled the moment a row gains an id via the A1
// auto-save-on-attach path). Existing tests never persist a new row via attach,
// so their <LineAttachments> stays null-id (list disabled) — these stubs are inert
// for them; the A1 describe block below drives them.
const mockUploadLineAttachments = vi.fn();
const mockListLineAttachments = vi.fn();
vi.mock("@/api/bills-grid", async () => {
  const actual = await vi.importActual<typeof import("@/api/bills-grid")>("@/api/bills-grid");
  return {
    ...actual,
    listExpenses: (params: unknown) => mockListExpenses(params),
    createExpenses: (body: unknown) => mockCreateExpenses(body),
    updateExpense: (id: string, body: unknown) => mockUpdateExpense(id, body),
    voidExpense: (id: string) => mockVoidExpense(id),
    uploadLineAttachments: (expenseId: string, files: File[]) => mockUploadLineAttachments(expenseId, files),
    listLineAttachments: (expenseId: string) => mockListLineAttachments(expenseId),
  };
});

// Category picker (T3, flag-gated on ENABLE_PHASE2_BILLING_DOCS) — mirrors
// charge-form.tsx's own flag + useChargeCategories reads. Both mocked modules
// are controlled per-test via `.mockReturnValue` (not a static vi.mock literal)
// so the SAME describe-file can exercise flag ON and flag OFF without
// vi.resetModules() gymnastics.
const mockIsPhase2FlagEnabled = vi.fn();
vi.mock("@/lib/feature-flags", () => ({
  isPhase2FlagEnabled: (flag: string) => mockIsPhase2FlagEnabled(flag),
}));

const mockUseChargeCategories = vi.fn();
vi.mock("@/api/charge-categories", () => ({
  useChargeCategories: (opts: unknown) => mockUseChargeCategories(opts),
}));

function activeItem(overrides: Partial<ExpenseListItem> = {}): ExpenseListItem {
  return {
    id: "exp-1",
    apartmentId: "apt-1",
    periodMonth: "2026-07",
    bearer: "owner",
    description: "Aircond repair",
    amount: "100.00",
    withSST: false,
    partyId: null,
    partyName: null,
    status: "active",
    updatedAt: "2026-07-01T00:00:00.000Z",
    chargeCategoryId: null,
    category: null,
    nature: null,
    // The live API always sends this (ExpenseListItem.settlement is REQUIRED server-side),
    // so the default fixture mirrors a real payload for a line nothing has been paid
    // against — the editable case every pre-existing test in this file assumes. The
    // ABSENT case is deliberately NOT the default: it means "this payload predates the
    // field", is treated as locked, and is exercised by its own test below.
    settlement: "none",
    ...overrides,
  };
}

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
}

function renderDialog(role: User["role"], props: Partial<ComponentProps<typeof ExpensesDialog>> = {}) {
  const queryClient = makeQueryClient();
  const user: User = { id: "u1", fullName: "Test", email: "t@t.com", role, orgId: "org-1" };
  const result = render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={{ user, setAuth: () => {}, clearAuth: () => {}, isAuthenticated: true }}>
        <ExpensesDialog apartmentId="apt-1" periodMonth="2026-07" bearer="tenant" {...props} />
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
  return { ...result, queryClient };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: flag OFF, no categories — matches every pre-existing test in this
  // file (written before the picker existed) so they need zero changes.
  mockIsPhase2FlagEnabled.mockReturnValue(false);
  mockUseChargeCategories.mockReturnValue({ data: { items: [] }, isLoading: false });
  // T1 Task 6 defaults — inert unless a test drives the A1 attach path.
  mockUploadLineAttachments.mockResolvedValue({ data: [{ id: "att-1", storageKey: "k" }] });
  mockListLineAttachments.mockResolvedValue({ items: [] });
});

describe("ExpensesDialog", () => {
  it("total only — 3 lines saved shows only the summed total on the grid cell", async () => {
    const stored: ExpenseListItem[] = [];
    mockListExpenses.mockImplementation(() =>
      Promise.resolve({
        items: [...stored],
        total: stored.reduce((s, i) => s + Number(i.amount), 0).toFixed(2),
      }),
    );
    mockCreateExpenses.mockImplementation(
      (body: { items: Array<{ description: string; amount: string; withSST: boolean }> }) => {
        body.items.forEach((item, idx) => {
          stored.push(
            activeItem({ id: `exp-new-${idx}`, description: item.description, amount: item.amount, withSST: item.withSST }),
          );
        });
        return Promise.resolve({ ids: stored.map((s) => s.id), total: "300.00" });
      },
    );

    const userEv = userEvent.setup();
    renderDialog("editor", { bearer: "owner" });

    await waitFor(() => expect(screen.getByText("0 MYR")).toBeInTheDocument());

    // Line 1 fields are present on open — no "Add expense" click needed.
    await userEv.type(await screen.findByLabelText("Line 1 description"), "Cleaning");
    await userEv.type(screen.getByLabelText("Line 1 amount"), "100");

    await userEv.click(screen.getByRole("button", { name: /Add line/ }));
    await userEv.type(screen.getByLabelText("Line 2 description"), "Repair");
    await userEv.type(screen.getByLabelText("Line 2 amount"), "100");

    await userEv.click(screen.getByRole("button", { name: /Add line/ }));
    await userEv.type(screen.getByLabelText("Line 3 description"), "Painting");
    await userEv.type(screen.getByLabelText("Line 3 amount"), "100");

    await userEv.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mockCreateExpenses).toHaveBeenCalledTimes(1));
    // GAP 2 (T7 review): flag-off / no-category creates now OMIT the
    // chargeCategoryId key entirely (matching the pre-T7 wire shape) rather
    // than sending it as an inert `null` — no item here has `chargeCategoryId`
    // as an own property.
    expect(mockCreateExpenses).toHaveBeenCalledWith(
      expect.objectContaining({
        bearer: "owner",
        items: [
          { description: "Cleaning", amount: "100.00", withSST: false },
          { description: "Repair", amount: "100.00", withSST: false },
          { description: "Painting", amount: "100.00", withSST: false },
        ],
      }),
    );
    for (const item of mockCreateExpenses.mock.calls[0][0].items) {
      expect(item).not.toHaveProperty("chargeCategoryId");
    }

    // Post-save: the total updates to the summed 300, and the inline form
    // reseeds from server truth — the saved lines return as editable, id-bearing
    // rows, so a second Save can't re-create them (no duplicate-create window).
    await waitFor(() => expect(screen.getByText("300 MYR")).toBeInTheDocument());
    expect(await screen.findByLabelText("Line 1 description")).toHaveValue("Cleaning");
    expect(screen.getByLabelText("Line 2 description")).toHaveValue("Repair");
    expect(screen.getByLabelText("Line 3 description")).toHaveValue("Painting");

    // No duplicate-create window: a second Save with no new rows re-POSTs
    // nothing (the reseeded rows are id-bearing, so createExpenses never fires).
    mockCreateExpenses.mockClear();
    await userEv.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByText("300 MYR")).toBeInTheDocument());
    expect(mockCreateExpenses).not.toHaveBeenCalled();
  });

  it("eye icon — the inline form is editable by default; the eye opens a SEPARATE read-only view", async () => {
    const items = [
      activeItem({ id: "exp-1", description: "Cleaning", amount: "100.00" }),
      activeItem({ id: "exp-2", description: "Repair", amount: "50.00" }),
      activeItem({ id: "exp-3", description: "Painting", amount: "75.00" }),
    ];
    mockListExpenses.mockResolvedValue({ items, total: "225.00" });

    const userEv = userEvent.setup();
    renderDialog("manager", { bearer: "owner" });

    await waitFor(() => expect(screen.getByText("225 MYR")).toBeInTheDocument());

    // The active lines render as editable inputs immediately — no Edit click.
    expect(await screen.findByLabelText("Line 1 description")).toHaveValue("Cleaning");

    // The eye opens a SEPARATE read-only view listing every line as text.
    await userEv.click(screen.getByRole("button", { name: "View expense lines" }));
    const view = await screen.findByRole("dialog");
    expect(within(view).getByText("Cleaning")).toBeInTheDocument();
    expect(within(view).getByText("Repair")).toBeInTheDocument();
    expect(within(view).getByText("Painting")).toBeInTheDocument();
    // Read-only: the view popup itself contains no editable inputs.
    expect(within(view).queryByLabelText("Line 1 description")).not.toBeInTheDocument();
  });

  it("search — tenant popup reached from a tenant record auto-fills the name; the picker searches by name / unit / phone", async () => {
    mockListExpenses.mockResolvedValue({ items: [], total: "0.00" });
    const userEv = userEvent.setup();

    // Scenario A — reached from a tenant record: name auto-fills, no search box.
    const scenarioA = renderDialog("editor", {
      initialTenancy: { tenancyId: "ten-1", partyName: "Ahmad bin Ali" },
    });
    expect(await screen.findByText("Ahmad bin Ali")).toBeInTheDocument();
    expect(screen.queryByLabelText("Search tenant by name, unit or phone")).not.toBeInTheDocument();
    scenarioA.unmount();

    // Scenario B — no tenant-record context: the picker searches candidates by
    // name / unit / phone (client-side filter over the caller-supplied list).
    const options: ExpensesDialogTenancyOption[] = [
      { tenancyId: "ten-2", partyName: "Nurul Huda", unitCode: "A-3-12", phone: "60123456789" },
      { tenancyId: "ten-3", partyName: "Siti Aminah", unitCode: "B-5-01", phone: "60198887777" },
    ];
    renderDialog("editor", { tenancyOptions: options });

    const search = await screen.findByLabelText("Search tenant by name, unit or phone");

    // Search by unit.
    await userEv.type(search, "A-3-12");
    expect(screen.getByRole("button", { name: /Nurul Huda/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Siti Aminah/ })).not.toBeInTheDocument();

    // Search by phone.
    await userEv.clear(search);
    await userEv.type(search, "8887777");
    expect(screen.getByRole("button", { name: /Siti Aminah/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Nurul Huda/ })).not.toBeInTheDocument();

    // Search by name.
    await userEv.clear(search);
    await userEv.type(search, "Nurul");
    await userEv.click(screen.getByRole("button", { name: /Nurul Huda/ }));
    expect(await screen.findByText("Nurul Huda")).toBeInTheDocument();
  });

  it("all-or-nothing — one line with an empty description blocks the whole save", async () => {
    mockListExpenses.mockResolvedValue({ items: [], total: "0.00" });
    const userEv = userEvent.setup();
    renderDialog("editor", { bearer: "owner" });

    await userEv.type(await screen.findByLabelText("Line 1 description"), "Cleaning");
    await userEv.type(screen.getByLabelText("Line 1 amount"), "100");

    await userEv.click(screen.getByRole("button", { name: /Add line/ }));
    // Line 2 amount is filled but its description is left EMPTY.
    await userEv.type(screen.getByLabelText("Line 2 amount"), "50");

    await userEv.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Description is required")).toBeInTheDocument();
    expect(mockCreateExpenses).not.toHaveBeenCalled();
    // No partial persist — the popup stays open with both lines intact.
    expect(screen.getByLabelText("Line 1 description")).toHaveValue("Cleaning");
    expect(screen.getByLabelText("Line 2 amount")).toHaveValue("50");
  });

  it("invalid amount — a formula or a zero amount is rejected inline and blocks save", async () => {
    mockListExpenses.mockResolvedValue({ items: [], total: "0.00" });
    const userEv = userEvent.setup();
    renderDialog("editor", { bearer: "owner" });

    await userEv.type(await screen.findByLabelText("Line 1 description"), "Cleaning");
    await userEv.type(screen.getByLabelText("Line 1 amount"), "=SUM(A1)");

    await userEv.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Amounts only")).toBeInTheDocument();
    expect(mockCreateExpenses).not.toHaveBeenCalled();

    await userEv.clear(screen.getByLabelText("Line 1 amount"));
    await userEv.type(screen.getByLabelText("Line 1 amount"), "0");
    await userEv.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Enter an amount greater than 0")).toBeInTheDocument();
    expect(mockCreateExpenses).not.toHaveBeenCalled();
  });

  it("I-1 regression — a rejected updateExpense aborts the save before any create fires (no duplicate-create window on retry)", async () => {
    const existing = activeItem({ id: "exp-1", description: "Aircond repair", amount: "100.00" });
    mockListExpenses.mockResolvedValue({ items: [existing], total: "100.00" });
    mockUpdateExpense.mockRejectedValue(new Error("ENTRY_LOCKED"));
    mockCreateExpenses.mockResolvedValue({ ids: ["exp-new-0"], total: "0.00" });

    const userEv = userEvent.setup();
    renderDialog("editor", { bearer: "owner" });

    await waitFor(() => expect(screen.getByText("100 MYR")).toBeInTheDocument());
    // Dirty the existing (persisted) row.
    const desc1 = await screen.findByLabelText("Line 1 description");
    await userEv.clear(desc1);
    await userEv.type(desc1, "Aircond repair (redo)");

    // Add a brand-new, second row alongside it.
    await userEv.click(screen.getByRole("button", { name: /Add line/ }));
    await userEv.type(screen.getByLabelText("Line 2 description"), "Extra part");
    await userEv.type(screen.getByLabelText("Line 2 amount"), "50");

    await userEv.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mockUpdateExpense).toHaveBeenCalledTimes(1));
    // Updates run before the create step (I-1 fix): a rejected update aborts
    // the save before createExpenses ever fires, so no orphan create can
    // exist to be duplicated when the user retries Save.
    expect(mockCreateExpenses).not.toHaveBeenCalled();
  });

  it("void line excluded from total — the cell total excludes void lines; the itemised view still shows them", async () => {
    const items = [
      activeItem({ id: "exp-1", description: "Cleaning", amount: "100.00", status: "active" }),
      activeItem({ id: "exp-2", description: "Old repair", amount: "40.00", status: "void" }),
    ];
    mockListExpenses.mockResolvedValue({ items, total: "140.00" });

    const userEv = userEvent.setup();
    renderDialog("manager", { bearer: "owner" });

    // The cell total excludes the void line's 40.00 — only the active
    // 100.00 line is summed.
    await waitFor(() => expect(screen.getByText("100 MYR")).toBeInTheDocument());

    await userEv.click(screen.getByRole("button", { name: "View expense lines" }));

    // The itemised view still displays the void line, with its void label.
    // Scope to the view dialog: the inline form also shows the active line with
    // its own manager "Void" button, so an unscoped getByText("Void") matches both.
    const view = await screen.findByRole("dialog");
    expect(within(view).getByText("Cleaning")).toBeInTheDocument();
    expect(within(view).getByText("Old repair")).toBeInTheDocument();
    expect(within(view).getByText("Void")).toBeInTheDocument();
  });

  it("trash — the Remove control is limited to new (unsaved) rows; a persisted row retires via Void only", async () => {
    const items = [activeItem({ id: "exp-1", description: "Cleaning", amount: "100.00" })];
    mockListExpenses.mockResolvedValue({ items, total: "100.00" });

    const userEv = userEvent.setup();
    renderDialog("manager", { bearer: "owner" });

    await waitFor(() => expect(screen.getByText("100 MYR")).toBeInTheDocument());
    await screen.findByLabelText("Line 1 description");
    // Persisted row: no Trash control — it retires only via Void.
    expect(screen.queryByRole("button", { name: "Remove line 1" })).not.toBeInTheDocument();

    // A brand-new row DOES get the Trash control.
    await userEv.click(screen.getByRole("button", { name: /Add line/ }));
    expect(screen.getByRole("button", { name: "Remove line 2" })).toBeInTheDocument();
  });

  it("editor cannot void — the Void control is absent for an editor (present for a manager)", async () => {
    const items = [activeItem({ id: "exp-1", description: "Cleaning", amount: "100.00" })];
    mockListExpenses.mockResolvedValue({ items, total: "100.00" });

    const asEditor = renderDialog("editor", { bearer: "owner" });

    await waitFor(() => expect(screen.getByText("100 MYR")).toBeInTheDocument());
    await screen.findByLabelText("Line 1 description");
    expect(screen.queryByRole("button", { name: "Void" })).not.toBeInTheDocument();
    expect(mockVoidExpense).not.toHaveBeenCalled();
    asEditor.unmount();

    // Contrast: a manager DOES see the Void control on the same data.
    renderDialog("manager", { bearer: "owner" });
    await waitFor(() => expect(screen.getByText("100 MYR")).toBeInTheDocument());
    expect(await screen.findByRole("button", { name: "Void" })).toBeInTheDocument();
  });

  // R6 — an expense save must re-derive the grid's cell/badge live (no
  // manual refresh). Asserts against the SAME QueryClient instance the
  // dialog renders under, not a fresh one, so this proves the component
  // actually calls invalidateQueries on it (mirrors setting-drawer.test.tsx's
  // R5 guard).
  it("invalidates the grid — a successful expense save also invalidates the grid root query key", async () => {
    mockListExpenses.mockResolvedValue({ items: [], total: "0.00" });
    mockCreateExpenses.mockResolvedValue({ ids: ["exp-new-0"], total: "100.00" });

    const userEv = userEvent.setup();
    const { queryClient } = renderDialog("editor", { bearer: "owner" });
    const spy = vi.spyOn(queryClient, "invalidateQueries");

    await userEv.type(await screen.findByLabelText("Line 1 description"), "Cleaning");
    await userEv.type(screen.getByLabelText("Line 1 amount"), "100");
    await userEv.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mockCreateExpenses).toHaveBeenCalledTimes(1));
    expect(spy).toHaveBeenCalledWith({ queryKey: GRID_QUERY_KEY_ROOT });
    // The expenses' own key is still invalidated too (unchanged behavior).
    expect(spy).toHaveBeenCalledWith({ queryKey: ["bills-grid", "expenses", "apt-1", "2026-07", "owner"] });
  });

  // R6 — voiding an expense line must also re-derive the grid live: the
  // active total on the cell excludes voided lines, so the grid's cached
  // total goes stale the same way an edited/created line would.
  it("invalidates the grid — voiding an expense line also invalidates the grid root query key", async () => {
    const items = [activeItem({ id: "exp-1", description: "Cleaning", amount: "100.00" })];
    mockListExpenses.mockResolvedValue({ items, total: "100.00" });
    mockVoidExpense.mockResolvedValue({ ok: true });

    const userEv = userEvent.setup();
    const { queryClient } = renderDialog("manager", { bearer: "owner" });
    const spy = vi.spyOn(queryClient, "invalidateQueries");

    await waitFor(() => expect(screen.getByText("100 MYR")).toBeInTheDocument());
    await screen.findByLabelText("Line 1 description");
    await userEv.click(screen.getByRole("button", { name: "Void" }));

    await waitFor(() => expect(mockVoidExpense).toHaveBeenCalledWith("exp-1"));
    expect(spy).toHaveBeenCalledWith({ queryKey: GRID_QUERY_KEY_ROOT });
  });

  // T2 — the editable form renders on open with no intermediate button; the
  // old two-step ("Add expense"/"Edit" → nested drawer) is gone.
  it("form on open — fields are visible immediately, no Add-expense/Edit button to click first", async () => {
    mockListExpenses.mockResolvedValue({ items: [], total: "0.00" });
    renderDialog("editor", { bearer: "owner" });

    // A blank starter line is present on open — no click required.
    expect(await screen.findByLabelText("Line 1 description")).toBeInTheDocument();
    expect(screen.getByLabelText("Line 1 amount")).toBeInTheDocument();
    // The old two-step triggers no longer exist.
    expect(screen.queryByRole("button", { name: "Add expense" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    // Save is available inline.
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });

  // Regression (review finding): voiding a persisted line must not discard
  // in-progress edits to OTHER rows — the form drops only the voided row.
  it("void keeps unsaved sibling rows — voiding one line does not discard a new unsaved line", async () => {
    const items = [activeItem({ id: "exp-1", description: "Cleaning", amount: "100.00" })];
    mockListExpenses.mockResolvedValue({ items, total: "100.00" });
    mockVoidExpense.mockResolvedValue({ ok: true });

    const userEv = userEvent.setup();
    renderDialog("manager", { bearer: "owner" });

    await waitFor(() => expect(screen.getByText("100 MYR")).toBeInTheDocument());
    await screen.findByLabelText("Line 1 description");

    // Add a new, unsaved sibling line, then void the persisted line 1.
    await userEv.click(screen.getByRole("button", { name: /Add line/ }));
    await userEv.type(screen.getByLabelText("Line 2 description"), "Extra part");
    await userEv.click(screen.getByRole("button", { name: "Void" }));

    await waitFor(() => expect(mockVoidExpense).toHaveBeenCalledWith("exp-1"));
    // The unsaved sibling survives the void (old code remounted and lost it).
    expect(await screen.findByDisplayValue("Extra part")).toBeInTheDocument();
  });
});

// One active ChargeCategoryDto fixture, shaped like charge-categories-section.test.tsx's.
const CAT_CLEANING = {
  id: "cat-cleaning",
  code: "cleaning",
  name: "Cleaning",
  family: "owner_income",
  docType: "invoice",
  seriesId: "s-1",
  seriesCode: "IVOWN",
  defaultSstRate: "0",
  eInvoiceEligible: false,
  ledgerCategory: null,
  isSystem: false,
  active: true,
  sortOrder: 0,
  description: null,
  profitExpense: "expense",
  updatedAt: "2026-07-02T00:00:00.000Z",
};

// T3 — per-line category picker, flag-gated on ENABLE_PHASE2_BILLING_DOCS.
// Purely additive: flag dark means the picker is entirely absent (byte-for-byte
// old behavior, proven by the "ExpensesDialog" describe block above, which never
// touches these two mocks' non-default return values).
describe("ExpensesDialog category picker (T3)", () => {
  it("flag OFF — no Line 1 category select is shown and useChargeCategories is not enabled", async () => {
    mockListExpenses.mockResolvedValue({ items: [], total: "0.00" });
    renderDialog("editor", { bearer: "owner" });

    await screen.findByLabelText("Line 1 description");
    expect(screen.queryByLabelText(/Line 1 category/)).not.toBeInTheDocument();
    expect(mockUseChargeCategories).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  });

  it("flag ON — picking a category on Line 1 threads chargeCategoryId into the create payload", async () => {
    mockIsPhase2FlagEnabled.mockReturnValue(true);
    mockUseChargeCategories.mockReturnValue({ data: { items: [CAT_CLEANING] }, isLoading: false });
    mockListExpenses.mockResolvedValue({ items: [], total: "0.00" });
    mockCreateExpenses.mockResolvedValue({ ids: ["exp-new-0"], total: "100.00" });

    const userEv = userEvent.setup();
    renderDialog("editor", { bearer: "owner" });

    await userEv.type(await screen.findByLabelText("Line 1 description"), "Cleaning");
    await userEv.type(screen.getByLabelText("Line 1 amount"), "100");
    await userEv.selectOptions(screen.getByLabelText("Line 1 category"), "cat-cleaning");

    await userEv.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mockCreateExpenses).toHaveBeenCalledTimes(1));
    expect(mockCreateExpenses).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [expect.objectContaining({ description: "Cleaning", amount: "100.00", chargeCategoryId: "cat-cleaning" })],
      }),
    );
  });

  // Dirty-check extension: description/amount/withSST are ALL left untouched —
  // only the category picker is changed — and updateExpense must still fire.
  // Pre-T3 the dirty-check had no way to detect this edit at all (it would
  // have silently no-op'd the Save).
  it("category-only edit on an existing line still PATCHes with the new chargeCategoryId", async () => {
    mockIsPhase2FlagEnabled.mockReturnValue(true);
    mockUseChargeCategories.mockReturnValue({ data: { items: [CAT_CLEANING] }, isLoading: false });
    const existing = activeItem({ id: "exp-1", description: "Aircond repair", amount: "100.00", withSST: false, chargeCategoryId: null });
    mockListExpenses.mockResolvedValue({ items: [existing], total: "100.00" });
    mockUpdateExpense.mockResolvedValue({ id: "exp-1", updatedAt: "2026-07-05T00:00:00.000Z" });

    const userEv = userEvent.setup();
    renderDialog("editor", { bearer: "owner" });

    await waitFor(() => expect(screen.getByText("100 MYR")).toBeInTheDocument());
    // Seeded from server truth with no category — proves rowsFromActive maps
    // chargeCategoryId (not just description/amount/withSST).
    const select = (await screen.findByLabelText("Line 1 category")) as HTMLSelectElement;
    expect(select.value).toBe("");
    expect(screen.getByLabelText("Line 1 description")).toHaveValue("Aircond repair");

    // ONLY the category changes — description/amount/withSST are untouched.
    await userEv.selectOptions(select, "cat-cleaning");
    await userEv.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mockUpdateExpense).toHaveBeenCalledTimes(1));
    expect(mockUpdateExpense).toHaveBeenCalledWith(
      "exp-1",
      expect.objectContaining({
        description: "Aircond repair",
        amount: "100.00",
        withSST: false,
        chargeCategoryId: "cat-cleaning",
      }),
    );
    // No new line was added — this is a pure PATCH, no createExpenses.
    expect(mockCreateExpenses).not.toHaveBeenCalled();
  });

  // GAP 1 regression (adversarial review, T7): a line saved with a category
  // that has SINCE been deactivated seeds that stale id into row state via
  // rowsFromActive, but the picker's active-only options (ExpensesDialog
  // filters to c.active) never include it — the <select> renders blank while
  // state still holds "cat-old-deactivated". An unrelated description-only
  // edit must NOT resend that stale id: the API's inactive-category guard
  // (Task 4) would 400 CATEGORY_INACTIVE on ANY payload carrying it, rejecting
  // the whole all-or-nothing save even though the user never touched the
  // category. Pre-T7 this line had no chargeCategoryId in the body at all and
  // saved fine — the fix must restore that by omitting the key when unchanged.
  it("stale/inactive category on an existing line — editing only the description omits chargeCategoryId from the PATCH", async () => {
    mockIsPhase2FlagEnabled.mockReturnValue(true);
    // Active options do NOT include "cat-old-deactivated" — mirrors
    // ExpensesDialog's activeCategories filter after the category was
    // deactivated server-side.
    mockUseChargeCategories.mockReturnValue({ data: { items: [CAT_CLEANING] }, isLoading: false });
    const existing = activeItem({
      id: "exp-1",
      description: "Aircond repair",
      amount: "100.00",
      withSST: false,
      chargeCategoryId: "cat-old-deactivated",
    });
    mockListExpenses.mockResolvedValue({ items: [existing], total: "100.00" });
    mockUpdateExpense.mockResolvedValue({ id: "exp-1", updatedAt: "2026-07-05T00:00:00.000Z" });

    const userEv = userEvent.setup();
    renderDialog("editor", { bearer: "owner" });

    await waitFor(() => expect(screen.getByText("100 MYR")).toBeInTheDocument());
    // ONLY the description changes — category is never touched by the user.
    const desc = await screen.findByLabelText("Line 1 description");
    await userEv.clear(desc);
    await userEv.type(desc, "Aircond repair (updated)");
    await userEv.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mockUpdateExpense).toHaveBeenCalledTimes(1));
    const [, patchBody] = mockUpdateExpense.mock.calls[0] as [string, Record<string, unknown>];
    // The stale category id must NOT be resent — the server would 400
    // CATEGORY_INACTIVE on it and reject the entire (unrelated) edit.
    expect(patchBody).not.toHaveProperty("chargeCategoryId");
    expect(patchBody).toMatchObject({ description: "Aircond repair (updated)" });
  });

  // Sabotage counterpart, inline: an UNCHANGED category must NOT trigger a
  // PATCH — proves the dirty-check's new OR-clause doesn't fire spuriously on
  // an untouched row that already has a category (the false-positive the
  // adversarial review flagged if rowsFromActive ever seeded `undefined`
  // instead of the real chargeCategoryId).
  it("an untouched existing line with a category already set does NOT re-PATCH on an unrelated no-op Save", async () => {
    mockIsPhase2FlagEnabled.mockReturnValue(true);
    mockUseChargeCategories.mockReturnValue({ data: { items: [CAT_CLEANING] }, isLoading: false });
    const existing = activeItem({ id: "exp-1", description: "Cleaning", amount: "100.00", withSST: false, chargeCategoryId: "cat-cleaning" });
    mockListExpenses.mockResolvedValue({ items: [existing], total: "100.00" });

    const userEv = userEvent.setup();
    renderDialog("editor", { bearer: "owner" });

    await waitFor(() => expect(screen.getByText("100 MYR")).toBeInTheDocument());
    const select = (await screen.findByLabelText("Line 1 category")) as HTMLSelectElement;
    // Seeded WITH the category already selected — proves rowsFromActive's seed
    // matches original.chargeCategoryId exactly (not undefined).
    expect(select.value).toBe("cat-cleaning");

    // Save with NOTHING touched at all.
    await userEv.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.getByText("100 MYR")).toBeInTheDocument());
    expect(mockUpdateExpense).not.toHaveBeenCalled();
  });
});

// T1 Task 6 — per-line attachments wired into each expense row, with A1
// auto-save-on-attach. The two highest-value, money-adjacent invariants:
//   (a) no-double-create — attaching to an unsaved line single-creates it and
//       writes the returned id IN PLACE, so a later batch Save treats the row
//       as existing (UPDATE, never a SECOND create).
//   (b) rapid-pick — a synchronous `useRef` in-flight lock keyed by row.key
//       means two rapid picks on the SAME unsaved row fire createExpenses only
//       ONCE (the second sees the ref populated and returns null).
// A stateful listExpenses starting empty mirrors the real "new sheet" case so
// the reseed after the auto-save reads server truth.
describe("ExpensesDialog per-line attachments + A1 auto-save-on-attach (T6)", () => {
  // The hidden per-line <input type=file> carries no accessible label
  // (aria-hidden); <LineAttachments>'s Upload button clicks it. Firing a change
  // on the input directly is the test-side equivalent of picking a file, and it
  // bypasses the button's `disabled` so the rapid-pick race is reachable.
  function pickPhoto(input: Element, name = "receipt.jpg") {
    const file = new File([new Uint8Array([1, 2, 3])], name, { type: "image/jpeg" });
    fireEvent.change(input, { target: { files: [file] } });
  }

  it("no-double-create — attaching to a valid unsaved tenant line single-creates it, writes the id in place, and a later Save does NOT re-create", async () => {
    // Empty sheet — no existing lines; a tenant is pre-resolved so the tenant
    // precondition (bearer === "tenant" → tenancy set) is satisfied.
    mockListExpenses.mockResolvedValue({ items: [], total: "0.00" });
    mockCreateExpenses.mockResolvedValue({ ids: ["exp-1"], total: "100.00" });

    const { container } = renderDialog("editor", {
      bearer: "tenant",
      initialTenancy: { tenancyId: "ten-1", partyName: "Ahmad bin Ali" },
    });
    const userEv = userEvent.setup();

    // Fill line 1 so it is valid to persist (non-empty description + amount>0).
    await userEv.type(await screen.findByLabelText("Line 1 description"), "Aircond repair");
    await userEv.type(screen.getByLabelText("Line 1 amount"), "100");

    // Pick a photo on the (still unsaved) line → A1 auto-save single-creates it.
    const fileInput = container.querySelector('input[type="file"]');
    expect(fileInput).not.toBeNull();
    pickPhoto(fileInput as Element);

    // createExpenses fires exactly ONCE, with the SAME body shape the batch
    // Save uses (tenancyId for the tenant bearer; a single item).
    await waitFor(() => expect(mockCreateExpenses).toHaveBeenCalledTimes(1));
    expect(mockCreateExpenses).toHaveBeenCalledWith(
      expect.objectContaining({
        apartmentId: "apt-1",
        billingMonth: "2026-07",
        bearer: "tenant",
        tenancyId: "ten-1",
        items: [{ description: "Aircond repair", amount: "100.00", withSST: false }],
      }),
    );
    // The upload targets the just-minted id (proves it was written in place).
    await waitFor(() => expect(mockUploadLineAttachments).toHaveBeenCalledWith("exp-1", expect.any(Array)));

    // Now Save. The row carries id "exp-1" → the save treats it as EXISTING, so
    // createExpenses must NOT fire a second time (no double-create).
    mockCreateExpenses.mockClear();
    await userEv.click(screen.getByRole("button", { name: "Save" }));
    // Give the save a beat to run its mutationFn.
    await waitFor(() => expect(mockListExpenses).toHaveBeenCalled());
    expect(mockCreateExpenses).not.toHaveBeenCalled();
    // NOTHING was edited after the attach → the auto-created row is unchanged
    // from its created baseline, so the save fires NO redundant updateExpense
    // either (the baseline-map dirty-check must not spuriously PATCH). This
    // guards the no-op edge of the money-path fix below (regression: an
    // unconditional-update approach would PATCH here on every save).
    expect(mockUpdateExpense).not.toHaveBeenCalled();
  });

  // Money-path regression (adversarial review, T1): editing an auto-created
  // (attached) line's AMOUNT after the attach, then Save, MUST persist the edit.
  // The attach single-creates the line and writes its id in place, but never
  // refreshes listQuery — so the created id is absent from `items`. The batch
  // save's existing-rows loop does `const original = items.find(i => i.id ===
  // r.id); if (!original) continue;` → for this row `original` is undefined and
  // the row is SKIPPED: neither updated nor created. The user's money edit is
  // silently dropped (save toasts success; the reseed reverts to the created
  // value). The fix makes the save fall back to a per-row created-value baseline
  // so the dirty-check fires and the edit is PATCHed via updateExpense — never a
  // SECOND createExpenses (the no-double-create invariant must still hold).
  it("edit after attach — editing an auto-created line's amount then Save persists it via updateExpense (no second create)", async () => {
    mockListExpenses.mockResolvedValue({ items: [], total: "0.00" });
    mockCreateExpenses.mockResolvedValue({ ids: ["exp-1"], total: "100.00" });
    mockUpdateExpense.mockResolvedValue({ id: "exp-1", updatedAt: "2026-07-05T00:00:00.000Z" });

    const { container } = renderDialog("editor", {
      bearer: "tenant",
      initialTenancy: { tenancyId: "ten-1", partyName: "Ahmad bin Ali" },
    });
    const userEv = userEvent.setup();

    // Fill line 1 (amount X = 100), then pick a photo → A1 auto-creates it as exp-1.
    await userEv.type(await screen.findByLabelText("Line 1 description"), "Aircond repair");
    const amount = screen.getByLabelText("Line 1 amount");
    await userEv.type(amount, "100");

    const fileInput = container.querySelector('input[type="file"]') as Element;
    pickPhoto(fileInput);

    await waitFor(() => expect(mockCreateExpenses).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockUploadLineAttachments).toHaveBeenCalledWith("exp-1", expect.any(Array)));

    // AFTER the attach, edit the amount X → Y (250). This is the money edit that
    // must not be lost.
    await userEv.clear(amount);
    await userEv.type(amount, "250");

    // Save. The edit must persist via updateExpense on the auto-created id, with
    // the normalized (2-dp) new amount — and createExpenses must NOT fire again.
    mockCreateExpenses.mockClear();
    await userEv.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mockUpdateExpense).toHaveBeenCalledTimes(1));
    expect(mockUpdateExpense).toHaveBeenCalledWith(
      "exp-1",
      expect.objectContaining({ description: "Aircond repair", amount: "250.00", withSST: false }),
    );
    // No double-create — the row already has an id, so it is UPDATED, not re-created.
    expect(mockCreateExpenses).not.toHaveBeenCalled();
  });

  it("rapid-pick (R7.4) — two picks on the SAME unsaved line before the first create resolves fire createExpenses exactly ONCE", async () => {
    mockListExpenses.mockResolvedValue({ items: [], total: "0.00" });
    // Deferred create — held open until AFTER both picks fire, so the second
    // pick must contend with the first still in flight (the ref-lock case).
    let resolveCreate!: (v: { ids: string[]; total: string }) => void;
    mockCreateExpenses.mockReturnValue(
      new Promise((res) => {
        resolveCreate = res;
      }),
    );

    const { container } = renderDialog("editor", {
      bearer: "tenant",
      initialTenancy: { tenancyId: "ten-1", partyName: "Ahmad bin Ali" },
    });
    const userEv = userEvent.setup();

    await userEv.type(await screen.findByLabelText("Line 1 description"), "Aircond repair");
    await userEv.type(screen.getByLabelText("Line 1 amount"), "100");

    const fileInput = container.querySelector('input[type="file"]') as Element;
    // Two rapid, synchronous picks on the same unsaved row — before the create
    // promise resolves. The synchronous `persistingRef` lock must let only the
    // first through.
    pickPhoto(fileInput, "a.jpg");
    pickPhoto(fileInput, "b.jpg");

    // Exactly one create, even though two picks fired.
    await waitFor(() => expect(mockCreateExpenses).toHaveBeenCalledTimes(1));
    // Let the in-flight create settle and the lock release.
    resolveCreate({ ids: ["exp-1"], total: "100.00" });
    await waitFor(() => expect(mockUploadLineAttachments).toHaveBeenCalled());
    // Still exactly one create after everything drains.
    expect(mockCreateExpenses).toHaveBeenCalledTimes(1);
  });

  it("guard — an unsaved line missing its amount shows the Upload disabled with the matching hint", async () => {
    mockListExpenses.mockResolvedValue({ items: [], total: "0.00" });

    renderDialog("editor", {
      bearer: "tenant",
      initialTenancy: { tenancyId: "ten-1", partyName: "Ahmad bin Ali" },
    });
    const userEv = userEvent.setup();

    // Description only — amount is left empty → not valid to persist.
    await userEv.type(await screen.findByLabelText("Line 1 description"), "Aircond repair");

    const uploadBtn = screen.getByRole("button", { name: /Upload/ });
    expect(uploadBtn).toBeDisabled();
    expect(screen.getByText("Add a description and amount to attach")).toBeInTheDocument();
  });

  it("R8 coexistence — wiring per-line attachments leaves the existing save/void form behavior intact (a valid line still saves via the batch create)", async () => {
    mockListExpenses.mockResolvedValue({ items: [], total: "0.00" });
    mockCreateExpenses.mockResolvedValue({ ids: ["exp-1"], total: "100.00" });

    renderDialog("editor", {
      bearer: "tenant",
      initialTenancy: { tenancyId: "ten-1", partyName: "Ahmad bin Ali" },
    });
    const userEv = userEvent.setup();

    await userEv.type(await screen.findByLabelText("Line 1 description"), "Aircond repair");
    await userEv.type(screen.getByLabelText("Line 1 amount"), "100");
    // Save WITHOUT attaching — the ordinary batch-create path must still work.
    await userEv.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mockCreateExpenses).toHaveBeenCalledTimes(1));
    expect(mockCreateExpenses).toHaveBeenCalledWith(
      expect.objectContaining({
        bearer: "tenant",
        tenancyId: "ten-1",
        items: [{ description: "Aircond repair", amount: "100.00", withSST: false }],
      }),
    );
  });
});

// Item 1 — partitioned-room tenant-expense owner visibility.
describe("ExpensesDialog — owner visibility (Item 1)", () => {
  const opts: ExpensesDialogTenancyOption[] = [
    { tenancyId: "t-leo", partyName: "Leo" },
    { tenancyId: "t-jacky", partyName: "Jacky" },
  ];

  it("R2/R6: existing lines are grouped under 'Expense owner: <name>' headers, read from each line's own owner", async () => {
    mockListExpenses.mockResolvedValue({
      items: [
        activeItem({ id: "e1", bearer: "tenant", description: "Aircon", amount: "80.00", partyId: "p-leo", partyName: "Leo" }),
        activeItem({ id: "e2", bearer: "tenant", description: "Cleaning", amount: "30.00", partyId: "p-leo", partyName: "Leo" }),
        activeItem({ id: "e3", bearer: "tenant", description: "Plumbing", amount: "45.00", partyId: "p-jacky", partyName: "Jacky" }),
      ],
      total: "155.00",
    });

    renderDialog("editor", { bearer: "tenant", tenancyOptions: opts });

    const groups = await screen.findAllByTestId("expense-owner-group");
    expect(groups).toHaveLength(2);
    expect(within(groups[0]).getByTestId("expense-owner-header").textContent).toBe("Expense owner: Leo");
    expect(within(groups[0]).getByDisplayValue("Aircon")).toBeInTheDocument();
    expect(within(groups[0]).getByDisplayValue("Cleaning")).toBeInTheDocument();
    expect(within(groups[1]).getByTestId("expense-owner-header").textContent).toBe("Expense owner: Jacky");
    expect(within(groups[1]).getByDisplayValue("Plumbing")).toBeInTheDocument();

    // Per-owner subtotals in each group header (Leo 80+30=110, Jacky 45) — the
    // "who owes what" figure that used to require mental math. Scoped to the
    // group so it can't accidentally match the summary chip of the same amount.
    expect(within(groups[0]).getByText("110 MYR")).toBeInTheDocument();
    expect(within(groups[1]).getByText("45 MYR")).toBeInTheDocument();
    // Summary card: grand total + the ownerBreakdown-derived line/tenant count.
    expect(screen.getByText("155 MYR")).toBeInTheDocument();
    expect(screen.getByText(/3 lines across 2 tenants/i)).toBeInTheDocument();
  });

  it("Item 1: 'Line N' numbers follow rendered top-to-bottom order, not raw server order", async () => {
    // Server rows are INTERLEAVED by owner (Leo, Jacky, Jacky, Leo). The old
    // raw-array numbering surfaced the documented scramble (Leo would read Line 1
    // & Line 4, Jacky Line 2 & Line 3); displayIndexByKey renumbers by rendered
    // order so each group reads 1..N down the sheet. A grouped-order fixture
    // (the R2/R6 test) can't tell the two apart — this interleaved one can.
    mockListExpenses.mockResolvedValue({
      items: [
        activeItem({ id: "e1", bearer: "tenant", description: "Leo-A", amount: "10.00", partyId: "p-leo", partyName: "Leo" }),
        activeItem({ id: "e2", bearer: "tenant", description: "Jacky-A", amount: "20.00", partyId: "p-jacky", partyName: "Jacky" }),
        activeItem({ id: "e3", bearer: "tenant", description: "Jacky-B", amount: "30.00", partyId: "p-jacky", partyName: "Jacky" }),
        activeItem({ id: "e4", bearer: "tenant", description: "Leo-B", amount: "40.00", partyId: "p-leo", partyName: "Leo" }),
      ],
      total: "100.00",
    });

    renderDialog("editor", { bearer: "tenant", tenancyOptions: opts });

    const groups = await screen.findAllByTestId("expense-owner-group");
    // Leo group first (first-seen): its two lines are Line 1 & Line 2 (not 1 & 4).
    expect(within(groups[0]).getByText("Line 1")).toBeInTheDocument();
    expect(within(groups[0]).getByText("Line 2")).toBeInTheDocument();
    // Jacky group next: Line 3 & Line 4 (not 2 & 3).
    expect(within(groups[1]).getByText("Line 3")).toBeInTheDocument();
    expect(within(groups[1]).getByText("Line 4")).toBeInTheDocument();
  });

  it("R4: a single active tenant is auto-selected — a fixed label, not the search picker", async () => {
    mockListExpenses.mockResolvedValue({ items: [], total: "0.00" });

    renderDialog("editor", { bearer: "tenant", tenancyOptions: [{ tenancyId: "t-solo", partyName: "Solo Tenant" }] });

    // Auto-selected: the tenant renders as a fixed label with a Change affordance,
    // and the manual search picker is ABSENT (nothing to select).
    expect(await screen.findByText("Solo Tenant")).toBeInTheDocument();
    expect(screen.getByText("Change")).toBeInTheDocument();
    expect(screen.queryByLabelText("Search tenant by name, unit or phone")).not.toBeInTheDocument();
  });

  it("R5: with multiple tenants, saving a new line without selecting one is blocked", async () => {
    mockListExpenses.mockResolvedValue({ items: [], total: "0.00" });
    const userEv = userEvent.setup();

    renderDialog("editor", { bearer: "tenant", tenancyOptions: opts });

    // Not auto-selected (2 options) → the search picker is shown.
    expect(await screen.findByLabelText("Search tenant by name, unit or phone")).toBeInTheDocument();
    await userEv.type(screen.getByLabelText("Line 1 description"), "Aircon");
    await userEv.type(screen.getByLabelText("Line 1 amount"), "50");
    await userEv.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Select a tenant before saving")).toBeInTheDocument();
    expect(mockCreateExpenses).not.toHaveBeenCalled();
  });

  it("R7: a legacy line with no resolved owner groups under 'Unassigned'", async () => {
    mockListExpenses.mockResolvedValue({
      items: [activeItem({ id: "e-legacy", bearer: "tenant", description: "Legacy line", amount: "10.00", partyId: null, partyName: null })],
      total: "10.00",
    });

    renderDialog("editor", { bearer: "tenant", tenancyOptions: opts });

    const headers = await screen.findAllByTestId("expense-owner-header");
    expect(headers.some((h) => h.textContent === "Expense owner: Unassigned")).toBe(true);
  });
});

// ── Per-line edit lock ───────────────────────────────────────────────────────
//
// The bug: the dialog rendered a live <input> over EVERY line, including ones the
// server had already frozen (`entryHasActivePayment` → 409 ENTRY_LOCKED). An admin
// retyped a paid line's description, hit Save, and got a rejection with nothing on
// screen that could have predicted it. A paid line must read as a record, not a form.
describe("ExpensesDialog — per-line edit lock", () => {
  it("a PAID line renders its values as text, with no description or amount input", async () => {
    mockListExpenses.mockResolvedValue({
      items: [activeItem({ id: "exp-paid", description: "WiFi", amount: "100.00", settlement: "paid" })],
      total: "100.00",
    });

    renderDialog("manager", { bearer: "owner" });

    // The values are still SHOWN — the line is a record, not hidden.
    expect(await screen.findByText("WiFi")).toBeInTheDocument();
    expect(screen.getByText("100.00")).toBeInTheDocument();
    // …but not as anything typeable.
    expect(screen.queryByLabelText("Line 1 description")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Line 1 amount")).not.toBeInTheDocument();
    expect(screen.getByTestId("expense-line-lock")).toHaveTextContent("Paid");
  });

  it("a PART-PAID line is frozen too, and says so", async () => {
    // An SST-bearing line whose base settled but whose SST sibling has not still has
    // real tax outstanding — and the server freezes the whole month on ANY payment.
    mockListExpenses.mockResolvedValue({
      items: [activeItem({ id: "exp-part", description: "Cleaning", amount: "50.00", settlement: "partial" })],
      total: "50.00",
    });

    renderDialog("manager", { bearer: "owner" });

    expect(await screen.findByTestId("expense-line-lock")).toHaveTextContent("Part paid");
    expect(screen.queryByLabelText("Line 1 amount")).not.toBeInTheDocument();
  });

  it("a BILLED-BUT-UNPAID line stays fully editable", async () => {
    // The whole point of the 2026-08-17 billed-but-unpaid unlock: no money has arrived,
    // so the admin amends and re-Bills. Locking here would re-break that workflow.
    mockListExpenses.mockResolvedValue({
      items: [activeItem({ id: "exp-open", description: "Repair", amount: "80.00", settlement: "unpaid" })],
      total: "80.00",
    });

    renderDialog("manager", { bearer: "owner" });

    expect(await screen.findByLabelText("Line 1 description")).toHaveValue("Repair");
    expect(screen.getByLabelText("Line 1 amount")).toHaveValue("80.00");
    expect(screen.queryByTestId("expense-line-lock")).not.toBeInTheDocument();
  });

  it("fails CLOSED — a payload with no settlement field is locked, not editable", async () => {
    // An older cached payload. Rendering it editable would recreate the exact bug: an
    // edit that looks accepted and dies at the server. It is labelled neutrally, never
    // "Paid", because we have no fact saying the tenant paid.
    const { settlement: _omitted, ...noSettlement } = activeItem({ id: "exp-stale", description: "Stale", amount: "12.00" });
    mockListExpenses.mockResolvedValue({ items: [noSettlement], total: "12.00" });

    renderDialog("manager", { bearer: "owner" });

    expect(await screen.findByTestId("expense-line-lock")).toHaveTextContent("Locked");
    expect(screen.queryByLabelText("Line 1 description")).not.toBeInTheDocument();
  });

  it("hides Void on a locked line — the server would refuse it", async () => {
    // voidExpenseService carries the same ENTRY_LOCKED guard as the edit path, so
    // offering Void here is offering a button that can only fail.
    mockListExpenses.mockResolvedValue({
      items: [
        activeItem({ id: "exp-paid", description: "WiFi", amount: "100.00", settlement: "paid" }),
        activeItem({ id: "exp-open", description: "Repair", amount: "80.00", settlement: "unpaid" }),
      ],
      total: "180.00",
    });

    renderDialog("manager", { bearer: "owner" });

    // Exactly one Void button, and it belongs to the unpaid line.
    await screen.findByText("WiFi");
    expect(screen.getAllByRole("button", { name: "Void" })).toHaveLength(1);
  });

  it("a locked line never PATCHes, even when an unlocked sibling is saved", async () => {
    // The save is all-or-nothing: a 409 on the paid line would fail the WHOLE batch and
    // lose the admin's edit to the line they were actually allowed to change.
    mockListExpenses.mockResolvedValue({
      items: [
        activeItem({ id: "exp-paid", description: "WiFi", amount: "100.00", settlement: "paid" }),
        activeItem({ id: "exp-open", description: "Repair", amount: "80.00", settlement: "unpaid" }),
      ],
      total: "180.00",
    });
    mockUpdateExpense.mockResolvedValue({ id: "exp-open" });

    const userEv = userEvent.setup();
    renderDialog("manager", { bearer: "owner" });

    const desc = await screen.findByLabelText("Line 2 description");
    await userEv.clear(desc);
    await userEv.type(desc, "Repair v2");
    await userEv.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mockUpdateExpense).toHaveBeenCalledTimes(1));
    expect(mockUpdateExpense).toHaveBeenCalledWith("exp-open", expect.objectContaining({ description: "Repair v2" }));
    expect(mockUpdateExpense).not.toHaveBeenCalledWith("exp-paid", expect.anything());
  });
});
