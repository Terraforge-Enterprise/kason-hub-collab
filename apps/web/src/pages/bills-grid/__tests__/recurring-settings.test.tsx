// Recurring settings editor (Task 7) — the preview→confirm→apply gate and the 409-conflict
// surface. Mirrors setting-drawer.test.tsx's QueryClient + AuthContext + client-mock harness.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthContext, type User } from "@/lib/auth";
import { RecurringSettings } from "../recurring-settings";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
import { toast } from "sonner";

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

async function openDraftAndPreview() {
  renderEditor();
  const u = userEvent.setup();
  await u.click(await screen.findByRole("button", { name: /Add/ }));
  await u.type(screen.getByPlaceholderText("e.g. Service fee"), "Service fee");
  await u.type(screen.getByPlaceholderText("0.00"), "50.00");
  await u.click(screen.getByRole("button", { name: /Preview & apply/ }));
  return u;
}

describe("RecurringSettings (Task 7)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockList.mockResolvedValue({ definitions: [] });
  });

  it("preview → confirm gate: the modal shows counts and NOTHING applies until Confirm", async () => {
    mockPreview.mockResolvedValue({
      willUpdate: [{ period: "2026-05-01" }, { period: "2026-06-01" }, { period: "2026-07-01" }],
      willCreateOnOpen: 1,
      excluded: [{ period: "2026-04-01", reason: "billed" }],
      conflicts: [],
    });
    mockApply.mockResolvedValue({ applied: 3, excluded: 1, conflicts: [] });

    const u = await openDraftAndPreview();
    // Preview modal appears with the affected/excluded counts; apply has NOT fired.
    expect(await screen.findByText(/Apply this change/)).toBeInTheDocument();
    expect(screen.getByText("Open updated").previousSibling).toHaveTextContent("3");
    expect(mockApply).not.toHaveBeenCalled();

    // Confirm → apply fires.
    await u.click(screen.getByRole("button", { name: /Confirm & apply/ }));
    expect(mockApply).toHaveBeenCalledTimes(1);
  });

  it("amount round-trip: the typed amount is serialized faithfully into the apply body (not zeroed)", async () => {
    mockPreview.mockResolvedValue({ willUpdate: [{ period: "2026-07-01" }], willCreateOnOpen: 0, excluded: [], conflicts: [] });
    mockApply.mockResolvedValue({ applied: 1, excluded: 0, conflicts: [] });

    renderEditor();
    const u = userEvent.setup();
    await u.click(await screen.findByRole("button", { name: /Add/ }));
    await u.type(screen.getByPlaceholderText("e.g. Service fee"), "Service fee");
    await u.type(screen.getByPlaceholderText("0.00"), "150");
    await u.click(screen.getByRole("button", { name: /Preview & apply/ }));
    await screen.findByText(/Apply this change/);
    await u.click(screen.getByRole("button", { name: /Confirm & apply/ }));

    expect(mockApply).toHaveBeenCalledTimes(1);
    const body = mockApply.mock.calls[0][1] as Record<string, unknown>;
    expect(body).toMatchObject({ amount: "150.00", enabled: true, confirm: true, kind: "CUSTOM", name: "Service fee" });
  });

  it("read-back: a saved definition renders its latest revision amount, never blank", async () => {
    mockList.mockResolvedValue({
      definitions: [
        {
          id: "d1", kind: "CUSTOM", code: "custom-abc", name: "Service fee", archivedAt: null,
          revisions: [{ id: "r1", amount: "150.00", bearer: "owner", categoryId: "c1", effectiveFromMonth: "2026-07-01", effectiveToMonth: null, enabled: true }],
        },
      ],
    });
    renderEditor();
    expect(await screen.findByText("Service fee")).toBeInTheDocument();
    expect(screen.getByText(/150/)).toBeInTheDocument();
  });

  it("409 conflict: the editor surfaces the per-period conflicts and does NOT claim success", async () => {
    mockPreview.mockResolvedValue({ willUpdate: [{ period: "2026-05-01" }], willCreateOnOpen: 0, excluded: [], conflicts: [] });
    // apply rejects with the RecurringConflictError shape (isRecurringConflict → true).
    mockApply.mockRejectedValue({ status: 409, conflicts: [{ apartmentId: "apt-1", period: "2026-05-01", reason: "tenant_unresolved" }], message: "recurring_conflict" });

    const u = await openDraftAndPreview();
    await screen.findByText(/Apply this change/);
    await u.click(screen.getByRole("button", { name: /Confirm & apply/ }));

    // The conflict is shown, and no success toast fired.
    expect(await screen.findByText(/Conflicts — nothing applied/)).toBeInTheDocument();
    expect(await screen.findByText(/2026-05-01: tenant_unresolved/)).toBeInTheDocument();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("Save-disabled hint: an empty amount disables 'Preview & apply' and says why", async () => {
    renderEditor();
    const u = userEvent.setup();
    await u.click(await screen.findByRole("button", { name: /Add/ }));

    // A brand-new draft opens with an EMPTY amount (the "0.00" is only placeholder text).
    // The primary button must be disabled AND the reason must be visible — the exact trap
    // that made the greyed button look broken.
    const save = screen.getByRole("button", { name: /Preview & apply/ });
    expect(save).toBeDisabled();
    expect(screen.getByText("Enter an amount to save.")).toBeInTheDocument();

    // Typing a valid amount clears the hint and enables the button.
    await u.type(screen.getByPlaceholderText("0.00"), "120.00");
    expect(screen.queryByText("Enter an amount to save.")).not.toBeInTheDocument();
    expect(save).toBeEnabled();
  });

  // The Type selector has been read-only since 2026-07-27 (a new definition is always
  // CUSTOM; Cleaning/WiFi come from the unit's Owner/Tenant toggle). Rendering all three
  // chips on a control that cannot select them advertised two dead choices, so it now
  // renders ONLY the definition's own kind.
  describe("Type selector shows only the definition's own kind", () => {
    function defn(kind: string, name: string) {
      return {
        definitions: [
          { id: "def-1", kind, name, revisions: [{ amount: "120.00", bearer: "owner", nature: "profit", enabled: true }] },
        ],
      };
    }

    it("a CUSTOM definition offers Custom only — no Cleaning/WiFi chips", async () => {
      mockList.mockResolvedValue(defn("CUSTOM", "TEST RECURRING"));
      renderEditor();
      const u = userEvent.setup();

      await u.click(await screen.findByRole("button", { name: /TEST RECURRING/ }));

      const kindGroup = screen.getByRole("radiogroup", { name: "Recurring kind" });
      const chips = within(kindGroup).getAllByRole("radio");
      expect(chips).toHaveLength(1);
      expect(chips[0]).toHaveTextContent("Custom");
      expect(within(kindGroup).queryByText("Cleaning")).not.toBeInTheDocument();
      expect(within(kindGroup).queryByText("WiFi")).not.toBeInTheDocument();
    });

    // 2026-07-31: CLEANING/WIFI are no longer listed here at all. The unit's own row in
    // the drawer above carries their bearer, recurring tick AND amount, and saves via the
    // same applyRecurring endpoint — so listing them again rendered ONE definition as TWO
    // entries, which reads as a duplicate charge on a money screen.
    it("a CLEANING definition is NOT listed — its row above is the single surface", async () => {
      mockList.mockResolvedValue(defn("CLEANING", "Cleaning fee"));
      renderEditor();

      await waitFor(() =>
        expect(screen.getByText(/No recurring charges configured/i)).toBeInTheDocument(),
      );
      expect(screen.queryByRole("button", { name: /Cleaning fee/ })).toBeNull();
    });

    it("a WIFI definition is NOT listed either", async () => {
      mockList.mockResolvedValue(defn("WIFI", "WiFi fee"));
      renderEditor();

      await waitFor(() =>
        expect(screen.getByText(/No recurring charges configured/i)).toBeInTheDocument(),
      );
      expect(screen.queryByRole("button", { name: /WiFi fee/ })).toBeNull();
    });

    it("CUSTOM definitions are still listed — only the governed kinds are hidden", async () => {
      // Guards over-filtering: hiding everything would silently strip real custom fees.
      mockList.mockResolvedValue(defn("CUSTOM", "Recurring Owner"));
      renderEditor();

      expect(await screen.findByRole("button", { name: /Recurring Owner/ })).toBeInTheDocument();
    });

    // 2026-08-06 client report: the drawer's Maintenance row (scalar engine) writes a
    // MAINTENANCE definition through the same applyRecurring API, and the old deny-pair
    // filter (!== CLEANING && !== WIFI) let it through — one setting rendered as two
    // entries again, this time "Maintenance … 300" above AND "Maintenance maintenance"
    // below. The filter is now the allow-list `kind === "CUSTOM"` (the caption already
    // says "Custom fixed monthly fees"), so EVERY scalar kind stays on its own row.
    it("a MAINTENANCE definition is NOT listed — its scalar row above is the single surface", async () => {
      mockList.mockResolvedValue(defn("MAINTENANCE", "Maintenance"));
      renderEditor();

      await waitFor(() =>
        expect(screen.getByText(/No recurring charges configured/i)).toBeInTheDocument(),
      );
      expect(screen.queryByRole("button", { name: /Maintenance/ })).toBeNull();
    });

    it("TNB and AIR definitions are NOT listed either (future-proof: every scalar kind)", async () => {
      mockList.mockResolvedValue({
        definitions: [
          { id: "def-t", kind: "TNB", name: "TNB fee", revisions: [{ amount: "50.00", bearer: "owner", nature: "profit", enabled: true }] },
          { id: "def-a", kind: "AIR", name: "Aircond fee", revisions: [{ amount: "40.00", bearer: "owner", nature: "profit", enabled: true }] },
        ],
      });
      renderEditor();

      await waitFor(() =>
        expect(screen.getByText(/No recurring charges configured/i)).toBeInTheDocument(),
      );
      expect(screen.queryByRole("button", { name: /TNB fee/ })).toBeNull();
      expect(screen.queryByRole("button", { name: /Aircond fee/ })).toBeNull();
    });
  });
});
