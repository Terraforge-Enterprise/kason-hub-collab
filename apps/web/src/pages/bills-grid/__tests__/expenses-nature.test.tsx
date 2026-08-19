// Task B2 — per-row Expense/Profit `nature` selector on the freeform expenses dialog,
// gated by ENABLE_CHARGE_NATURE_ROUTING. Companion to recurring-nature.test.tsx (same
// flag, same Segmented control pattern) but for ExpensesDialog/ExpenseEditForm instead
// of RecurringSettings — the freeform GridExpense per-row nature Task B1 wired routing
// for. Flag ON: a per-row Segmented control renders (default "Expense" — UNLIKE the
// recurring editor's "Profit" default, because a freeform GridExpense's pre-feature
// behavior IS Expense/EB-routing, so backward-compat means defaulting there, not to
// Profit), editable per row, and `nature` rides the create/update payloads. Flag OFF:
// no selector, `nature` absent from the wire (byte-identical to pre-Task-B2).
//
// Mirrors expenses-dialog.test.tsx's mock harness (mock @/api/bills-grid + per-line
// attachment fns + @/api/charge-categories) but — per this task's instruction to force
// flags with `vi.stubEnv` — does NOT mock @/lib/feature-flags; the REAL isPhase2FlagEnabled
// runs, driven by vi.stubEnv("VITE_ENABLE_CHARGE_NATURE_ROUTING", ...) exactly like
// recurring-nature.test.tsx. ENABLE_PHASE2_BILLING_DOCS (category picker) is left
// unstubbed/falsy throughout — out of scope here — so useChargeCategories is still
// mocked to a static empty/disabled return to keep it inert.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthContext, type User } from "@/lib/auth";
import type { ExpenseListItem } from "@/api/bills-grid";
import { ExpensesDialog } from "../expenses-dialog";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const mockListExpenses = vi.fn();
const mockCreateExpenses = vi.fn();
const mockUpdateExpense = vi.fn();
const mockVoidExpense = vi.fn();
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

// Not relevant to this suite — kept statically off/empty so the T3 category picker
// never renders and its query never fires (mirrors expenses-dialog.test.tsx's default).
vi.mock("@/api/charge-categories", () => ({
  useChargeCategories: () => ({ data: { items: [] }, isLoading: false }),
}));

const NATURE_FLAG = "VITE_ENABLE_CHARGE_NATURE_ROUTING";

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
    // Mirrors a real payload: the API always sends this now. Absent means "payload
    // predates the field" and is treated as LOCKED (expense-lock.ts fails closed), which
    // would render every line here read-only and hide the controls these tests drive.
    settlement: "none",
    ...overrides,
  };
}

function renderDialog() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  const user: User = { id: "u1", fullName: "Test", email: "t@t.com", role: "editor", orgId: "org-1" };
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={{ user, setAuth: () => {}, clearAuth: () => {}, isAuthenticated: true }}>
        <ExpensesDialog apartmentId="apt-1" periodMonth="2026-07" bearer="owner" />
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUploadLineAttachments.mockResolvedValue({ data: [{ id: "att-1", storageKey: "k" }] });
  mockListLineAttachments.mockResolvedValue({ items: [] });
  // Default OFF so pre-existing behavior is exercised unless a test opts in.
  vi.stubEnv(NATURE_FLAG, "false");
});

describe("ExpensesDialog — Expense/Profit nature selector (Task B2)", () => {
  it("flag OFF: no per-row nature selector renders, and a new line's create payload carries no `nature` key", async () => {
    mockListExpenses.mockResolvedValue({ items: [], total: "0.00" });
    mockCreateExpenses.mockResolvedValue({ ids: ["exp-new-0"], total: "100.00" });
    const u = userEvent.setup();
    renderDialog();

    await screen.findByLabelText("Line 1 description");
    expect(screen.queryByRole("radiogroup", { name: "Line 1 nature" })).not.toBeInTheDocument();

    await u.type(screen.getByLabelText("Line 1 description"), "Cleaning");
    await u.type(screen.getByLabelText("Line 1 amount"), "100");
    await u.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mockCreateExpenses).toHaveBeenCalledTimes(1));
    const body = mockCreateExpenses.mock.calls[0][0] as { items: Array<Record<string, unknown>> };
    expect(body.items[0]).not.toHaveProperty("nature");
  });

  it("flag ON: a new (blank) line shows a Nature selector defaulting to Expense", async () => {
    vi.stubEnv(NATURE_FLAG, "true");
    mockListExpenses.mockResolvedValue({ items: [], total: "0.00" });
    renderDialog();

    await screen.findByLabelText("Line 1 description");
    const group = screen.getByRole("radiogroup", { name: "Line 1 nature" });
    const radios = within(group).getAllByRole("radio");
    expect(radios).toHaveLength(2);
    const profit = radios.find((r) => r.textContent === "Profit")!;
    const expense = radios.find((r) => r.textContent === "Expense")!;
    expect(expense).toHaveAttribute("aria-checked", "true"); // default is Expense, NOT Profit
    expect(profit).toHaveAttribute("aria-checked", "false");
  });

  it("flag ON, no interaction: saving a new line defaults nature to \"expense\" in the create payload", async () => {
    vi.stubEnv(NATURE_FLAG, "true");
    mockListExpenses.mockResolvedValue({ items: [], total: "0.00" });
    mockCreateExpenses.mockResolvedValue({ ids: ["exp-new-0"], total: "100.00" });
    const u = userEvent.setup();
    renderDialog();

    await u.type(await screen.findByLabelText("Line 1 description"), "Cleaning");
    await u.type(screen.getByLabelText("Line 1 amount"), "100");
    await u.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mockCreateExpenses).toHaveBeenCalledTimes(1));
    expect(mockCreateExpenses).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [expect.objectContaining({ description: "Cleaning", amount: "100.00", nature: "expense" })],
      }),
    );
  });

  it('flag ON: picking Profit on a new line sends nature: "profit" in the create payload', async () => {
    vi.stubEnv(NATURE_FLAG, "true");
    mockListExpenses.mockResolvedValue({ items: [], total: "0.00" });
    mockCreateExpenses.mockResolvedValue({ ids: ["exp-new-0"], total: "250.00" });
    const u = userEvent.setup();
    renderDialog();

    await u.type(await screen.findByLabelText("Line 1 description"), "Consulting");
    await u.type(screen.getByLabelText("Line 1 amount"), "250");
    const group = screen.getByRole("radiogroup", { name: "Line 1 nature" });
    const profit = within(group).getAllByRole("radio").find((r) => r.textContent === "Profit")!;
    await u.click(profit);

    await u.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mockCreateExpenses).toHaveBeenCalledTimes(1));
    expect(mockCreateExpenses).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [expect.objectContaining({ description: "Consulting", amount: "250.00", nature: "profit" })],
      }),
    );
  });

  it("flag ON: an existing line saved as Profit reloads with Profit selected (read-back, not silently reset to Expense)", async () => {
    vi.stubEnv(NATURE_FLAG, "true");
    const existing = activeItem({ id: "exp-1", description: "Consulting", amount: "250.00", nature: "profit" });
    mockListExpenses.mockResolvedValue({ items: [existing], total: "250.00" });
    renderDialog();

    await screen.findByLabelText("Line 1 description");
    const group = screen.getByRole("radiogroup", { name: "Line 1 nature" });
    const radios = within(group).getAllByRole("radio");
    const profit = radios.find((r) => r.textContent === "Profit")!;
    const expense = radios.find((r) => r.textContent === "Expense")!;
    expect(profit).toHaveAttribute("aria-checked", "true");
    expect(expense).toHaveAttribute("aria-checked", "false");
  });

  it("flag ON: an untouched existing Profit line does NOT resend nature on an unrelated description-only edit", async () => {
    vi.stubEnv(NATURE_FLAG, "true");
    const existing = activeItem({ id: "exp-1", description: "Consulting", amount: "250.00", nature: "profit" });
    mockListExpenses.mockResolvedValue({ items: [existing], total: "250.00" });
    mockUpdateExpense.mockResolvedValue({ id: "exp-1", updatedAt: "2026-07-05T00:00:00.000Z" });
    const u = userEvent.setup();
    renderDialog();

    const desc = await screen.findByLabelText("Line 1 description");
    await u.clear(desc);
    await u.type(desc, "Consulting (updated)");
    await u.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mockUpdateExpense).toHaveBeenCalledTimes(1));
    const [, patchBody] = mockUpdateExpense.mock.calls[0] as [string, Record<string, unknown>];
    expect(patchBody).not.toHaveProperty("nature");
    expect(patchBody).toMatchObject({ description: "Consulting (updated)" });
  });

  it('flag ON: flipping an existing Profit line to Expense sends nature: "expense" in the update PATCH', async () => {
    vi.stubEnv(NATURE_FLAG, "true");
    const existing = activeItem({ id: "exp-1", description: "Consulting", amount: "250.00", nature: "profit" });
    mockListExpenses.mockResolvedValue({ items: [existing], total: "250.00" });
    mockUpdateExpense.mockResolvedValue({ id: "exp-1", updatedAt: "2026-07-05T00:00:00.000Z" });
    const u = userEvent.setup();
    renderDialog();

    await screen.findByLabelText("Line 1 description");
    const group = screen.getByRole("radiogroup", { name: "Line 1 nature" });
    const expenseRadio = within(group).getAllByRole("radio").find((r) => r.textContent === "Expense")!;
    await u.click(expenseRadio);
    await u.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mockUpdateExpense).toHaveBeenCalledTimes(1));
    expect(mockUpdateExpense).toHaveBeenCalledWith("exp-1", expect.objectContaining({ nature: "expense" }));
  });
});

// Silent-drop interlock: the editor is gated only on ENABLE_PHASE2_BILLING_DOCS, but the
// backend only BILLS these expenses when ENABLE_BILL_EXPENSES_AS_CHARGES is ON. With that
// companion flag OFF an admin could add expenses that are saved but never billed (they vanish
// at Bill time with no indication) — the dialog must warn. Kept LAST so its BILLING_DOCS stub
// can't leak into the byte-identical (BILLING_DOCS-off) suites above.
describe("ExpensesDialog — silent-drop interlock (ENABLE_BILL_EXPENSES_AS_CHARGES)", () => {
  const BILLING_DOCS = "VITE_ENABLE_PHASE2_BILLING_DOCS";
  const EXPENSE_BILLING = "VITE_ENABLE_BILL_EXPENSES_AS_CHARGES";

  it("BILLING_DOCS on + expense-billing OFF: warns that expenses won't be billed", async () => {
    vi.stubEnv(BILLING_DOCS, "true");
    vi.stubEnv(EXPENSE_BILLING, "false");
    mockListExpenses.mockResolvedValue({ items: [], total: "0.00" });
    renderDialog();

    expect(await screen.findByText(/won't be billed/i)).toBeInTheDocument();
    expect(screen.getByText(/ENABLE_BILL_EXPENSES_AS_CHARGES/)).toBeInTheDocument();
  });

  it("BILLING_DOCS on + expense-billing ON: no silent-drop warning (expenses will bill)", async () => {
    vi.stubEnv(BILLING_DOCS, "true");
    vi.stubEnv(EXPENSE_BILLING, "true");
    mockListExpenses.mockResolvedValue({ items: [], total: "0.00" });
    renderDialog();

    await screen.findByRole("button", { name: /Add line/i });
    expect(screen.queryByText(/won't be billed/i)).not.toBeInTheDocument();
  });
});
