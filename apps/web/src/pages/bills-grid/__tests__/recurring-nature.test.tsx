// Task 9 (charge-nature-expense-profit-routing) — Expense/Profit selector in the recurring
// editor, gated by ENABLE_CHARGE_NATURE_ROUTING. The editor's single Draft/kind form covers
// CUSTOM lines AND the Cleaning/WiFi rows (recurring-settings.tsx), so one selector on that
// form covers all three. Flag ON: the selector renders, defaults to "profit" (the API 422s
// NATURE_REQUIRED — routes.ts — if `nature` is ever omitted while the flag is ON, so the
// default must be a concrete value, never undefined), and "nature" rides the apply POST body.
// Flag OFF: no selector, apply body unchanged (no `nature` key at all).
// Mirrors recurring-settings.test.tsx's QueryClient + AuthContext + client-mock harness, and
// owner-statement-page.test.tsx's vi.stubEnv-per-test flag mechanism (isPhase2FlagEnabled reads
// import.meta.env fresh each call, so no vi.resetModules is needed).
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthContext, type User } from "@/lib/auth";
import { RecurringSettings, defaultNatureForKind } from "../recurring-settings";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const mockList = vi.fn();
const mockPreview = vi.fn();
const mockApply = vi.fn();
vi.mock("@/api/bills-grid-recurring", async () => {
  const actual = await vi.importActual<typeof import("@/api/bills-grid-recurring")>("@/api/bills-grid-recurring");
  return {
    ...actual, // keep real RECURRING_QUERY_KEY_ROOT + isRecurringConflict
    listRecurring: (...a: unknown[]) => mockList(...a),
    previewRecurring: (...a: unknown[]) => mockPreview(...a),
    applyRecurring: (...a: unknown[]) => mockApply(...a),
  };
});

const NATURE_FLAG = "VITE_ENABLE_CHARGE_NATURE_ROUTING";

function renderEditor() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  const user: User = { id: "u1", fullName: "Mgr", email: "m@t.com", role: "manager", orgId: "org-1" };
  render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={{ user, setAuth: () => {}, clearAuth: () => {}, isAuthenticated: true }}>
        <RecurringSettings apartmentId="apt-1" />
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

/** Opens the Add draft and fills the minimum required fields (mirrors recurring-settings.test.tsx). */
async function openDraft() {
  renderEditor();
  const u = userEvent.setup();
  await u.click(await screen.findByRole("button", { name: /Add/ }));
  await u.type(screen.getByPlaceholderText("e.g. Service fee"), "Service fee");
  await u.type(screen.getByPlaceholderText("0.00"), "50.00");
  return u;
}

async function previewAndConfirm(u: ReturnType<typeof userEvent.setup>) {
  await u.click(screen.getByRole("button", { name: /Preview & apply/ }));
  await screen.findByText(/Apply this change/);
  await u.click(screen.getByRole("button", { name: /Confirm & apply/ }));
}

describe("Recurring editor — Expense/Profit nature (Task 9)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockList.mockResolvedValue({ definitions: [] });
    mockPreview.mockResolvedValue({ willUpdate: [{ period: "2026-07-01" }], willCreateOnOpen: 0, excluded: [], conflicts: [] });
    mockApply.mockResolvedValue({ applied: 1, excluded: 0, conflicts: [] });
    // Default OFF so pre-existing behavior is exercised unless a test opts in.
    vi.stubEnv(NATURE_FLAG, "false");
  });

  it("flag OFF: no Expense/Profit selector renders (unchanged UI), and the apply body carries no `nature` key", async () => {
    const u = await openDraft();

    expect(screen.queryByRole("radiogroup", { name: "Recurring nature" })).not.toBeInTheDocument();
    // Sibling controls on the same form are untouched.
    expect(screen.getByRole("radiogroup", { name: "Recurring bearer" })).toBeInTheDocument();

    await previewAndConfirm(u);

    expect(mockApply).toHaveBeenCalledTimes(1);
    const body = mockApply.mock.calls[0][1] as Record<string, unknown>;
    expect("nature" in body).toBe(false);
  });

  it("flag ON: the draft form shows a Nature selector defaulting to Profit", async () => {
    vi.stubEnv(NATURE_FLAG, "true");
    await openDraft();

    const group = screen.getByRole("radiogroup", { name: "Recurring nature" });
    // Matched by visible text (not accessible name): Field's wrapping <label> implicitly
    // captures the FIRST labelable descendant inside Segmented (a <button>), which folds the
    // Field label + Segmented aria-label into that one radio's computed name — a pre-existing
    // Field/Segmented DOM characteristic shared by every Segmented-in-Field control in this
    // file (e.g. "Borne by"), not something Task 9 introduces or should change.
    const radios = within(group).getAllByRole("radio");
    expect(radios).toHaveLength(2);
    const profit = radios.find((r) => r.textContent === "Profit")!;
    const expense = radios.find((r) => r.textContent === "Expense")!;
    expect(profit).toHaveAttribute("aria-checked", "true");
    expect(expense).toHaveAttribute("aria-checked", "false");
  });

  it('flag ON, no interaction: saving defaults nature to "profit" (never undefined — the API 422s NATURE_REQUIRED otherwise)', async () => {
    vi.stubEnv(NATURE_FLAG, "true");
    const u = await openDraft();

    await previewAndConfirm(u);

    expect(mockApply).toHaveBeenCalledTimes(1);
    const body = mockApply.mock.calls[0][1] as Record<string, unknown>;
    expect(body.nature).toBe("profit");
  });

  it('flag ON: picking Expense sends nature: "expense" in the apply body', async () => {
    vi.stubEnv(NATURE_FLAG, "true");
    const u = await openDraft();
    const group = screen.getByRole("radiogroup", { name: "Recurring nature" });
    const expense = within(group).getAllByRole("radio").find((r) => r.textContent === "Expense")!;
    await u.click(expense);

    await previewAndConfirm(u);

    expect(mockApply).toHaveBeenCalledTimes(1);
    const body = mockApply.mock.calls[0][1] as Record<string, unknown>;
    expect(body.nature).toBe("expense");
  });

  // Kind-aware default (charge-nature routing): WiFi is a cost the OWNER bears — NOT an IVOWN
  // line under the locked "IVOWN = mgmt + cleaning only" redesign decision — so it defaults to
  // Expense (owner-rent deduction). Cleaning IS owner revenue billed on the Owner Invoice
  // (IVOWN) → it defaults to Profit (stays a line on the invoice), NOT Expense (which would
  // divert it off the invoice into a deduction). Custom fees can be a genuine KAEN charge → Profit.
  describe("kind-aware Nature default", () => {
    // The kind-aware nature default is asserted DIRECTLY now. It used to be driven by
    // clicking a CLEANING/WIFI row in this list — a path that no longer exists, since those
    // kinds are owned by the unit's own row in the drawer above. The money semantics still
    // matter (Cleaning stays an IVOWN line; WiFi becomes an owner deduction), so they are
    // pinned on the function rather than lost with the removed UI path.
    it("Cleaning defaults to Profit and WiFi to Expense", () => {
      expect(defaultNatureForKind("CLEANING")).toBe("profit");
      expect(defaultNatureForKind("WIFI")).toBe("expense");
      expect(defaultNatureForKind("CUSTOM")).toBe("profit");
    });

    // The two "a NEW WIFI/CLEANING row defaults to X" cases that lived here are GONE with the
    // custom-only change (2026-07-27): a new definition can no longer BE Cleaning or WiFi, so
    // there is no new-row kind default left to assert. The EXISTING-definition read-back cases
    // above still cover the kind-aware seeding that legacy CLEANING/WIFI rows depend on.
    it("a NEW definition offers no kind choice — recurring is custom-only (Cleaning/WiFi live on the drawer's Owner/Tenant toggle)", async () => {
      vi.stubEnv(NATURE_FLAG, "true");
      renderEditor();
      const u = userEvent.setup();
      await u.click(await screen.findByRole("button", { name: /Add/ }));

      expect(screen.queryByRole("radiogroup", { name: "Recurring kind" })).toBeNull();
      // The CUSTOM-only "Name" field is the tell that the draft really is CUSTOM.
      expect(screen.getByLabelText("Name")).toBeInTheDocument();
    });

    

    it("flag ON: a NEW custom fee's Nature selector defaults to Profit", async () => {
      vi.stubEnv(NATURE_FLAG, "true");
      renderEditor();
      const u = userEvent.setup();
      await u.click(await screen.findByRole("button", { name: /Add/ }));

      const natureGroup = screen.getByRole("radiogroup", { name: "Recurring nature" });
      const radios = within(natureGroup).getAllByRole("radio");
      const profit = radios.find((r) => r.textContent === "Profit")!;
      const expense = radios.find((r) => r.textContent === "Expense")!;
      expect(profit).toHaveAttribute("aria-checked", "true");
      expect(expense).toHaveAttribute("aria-checked", "false");
    });

    
  });
});
