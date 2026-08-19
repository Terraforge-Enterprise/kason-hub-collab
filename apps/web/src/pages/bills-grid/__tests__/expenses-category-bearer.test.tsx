// The expenses drawer's Category picker is scoped to the sheet's BEARER.
//
// Before this, the picker listed every active ChargeCategory, so the OWNER expense sheet
// offered tenant-side codes like "Subsidy (tenant)" — a category that can never legitimately
// classify an owner-borne cost.
//
// The money-relevant half is the keep-current-selection rule: a line saved before the filter
// existed (or filed under the other bearer) still holds an off-side categoryId. If the filter
// dropped that option, the <select> would render blank — reading as "No category" while local
// state still held the id — and the next save would silently re-classify the line.
//
// Harness mirrors expenses-nature.test.tsx (mock @/api/bills-grid + attachments), but here
// @/api/charge-categories returns a REAL mixed-family list and ENABLE_PHASE2_BILLING_DOCS is
// stubbed on so the picker actually renders.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthContext, type User } from "@/lib/auth";
import type { ExpenseListItem } from "@/api/bills-grid";
import { ExpensesDialog } from "../expenses-dialog";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const mockListExpenses = vi.fn();
const mockListLineAttachments = vi.fn();
vi.mock("@/api/bills-grid", async () => {
  const actual = await vi.importActual<typeof import("@/api/bills-grid")>("@/api/bills-grid");
  return {
    ...actual,
    listExpenses: (params: unknown) => mockListExpenses(params),
    createExpenses: vi.fn(),
    updateExpense: vi.fn(),
    voidExpense: vi.fn(),
    uploadLineAttachments: vi.fn(),
    listLineAttachments: (expenseId: string) => mockListLineAttachments(expenseId),
  };
});

const CATEGORIES = [
  { id: "cat-sub-ten", code: "subsidy_tenant", name: "Subsidy (tenant)", family: "tenant_income", docType: "invoice", seriesId: "s1", seriesCode: "IVTEN", defaultSstRate: "0", eInvoiceEligible: false, ledgerCategory: null, isSystem: false, active: true, sortOrder: 65, description: null, profitExpense: null, updatedAt: "2026-07-01T00:00:00.000Z" },
  { id: "cat-clean-own", code: "cleaning_owner", name: "Cleaning (owner)", family: "owner_income", docType: "invoice", seriesId: "s2", seriesCode: "IVOWN", defaultSstRate: "0", eInvoiceEligible: false, ledgerCategory: "cleaning", isSystem: true, active: true, sortOrder: 110, description: null, profitExpense: null, updatedAt: "2026-07-01T00:00:00.000Z" },
  { id: "cat-rental", code: "rental", name: "Monthly rental", family: "pay_back_landlord", docType: "debit_note", seriesId: "s3", seriesCode: "RB", defaultSstRate: "0", eInvoiceEligible: false, ledgerCategory: "rental_income", isSystem: true, active: true, sortOrder: 200, description: null, profitExpense: null, updatedAt: "2026-07-01T00:00:00.000Z" },
];

vi.mock("@/api/charge-categories", () => ({
  useChargeCategories: () => ({ data: { items: CATEGORIES }, isLoading: false }),
}));

const DOCS_FLAG = "VITE_ENABLE_PHASE2_BILLING_DOCS";

function ownerItem(overrides: Partial<ExpenseListItem> = {}): ExpenseListItem {
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

function renderDialog(bearer: "owner" | "tenant") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const user: User = { id: "u1", fullName: "Test", email: "t@t.com", role: "manager", orgId: "org-1" };
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={{ user, setAuth: () => {}, clearAuth: () => {}, isAuthenticated: true }}>
        <ExpensesDialog
          apartmentId="apt-1"
          periodMonth="2026-07"
          bearer={bearer}
          initialTenancy={bearer === "tenant" ? { tenancyId: "t-1", partyName: "Tan Wei Ming" } : undefined}
        />
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

function optionLabels(select: HTMLElement): string[] {
  return within(select)
    .getAllByRole("option")
    .map((o) => o.textContent ?? "");
}

beforeEach(() => {
  vi.clearAllMocks();
  mockListLineAttachments.mockResolvedValue({ items: [] });
  vi.stubEnv(DOCS_FLAG, "true");
});

describe("ExpensesDialog — Category picker is scoped to the sheet's bearer", () => {
  it("owner sheet does not offer tenant-side categories", async () => {
    mockListExpenses.mockResolvedValue({ items: [], total: "0.00" });
    renderDialog("owner");

    const select = await screen.findByLabelText("Line 1 category");
    const labels = optionLabels(select);
    expect(labels).toContain("Cleaning (owner)");
    expect(labels).not.toContain("Subsidy (tenant)");
  });

  it("tenant sheet does not offer owner-side categories", async () => {
    mockListExpenses.mockResolvedValue({ items: [], total: "0.00" });
    renderDialog("tenant");

    const select = await screen.findByLabelText("Line 1 category");
    const labels = optionLabels(select);
    expect(labels).toContain("Subsidy (tenant)");
    expect(labels).not.toContain("Cleaning (owner)");
  });

  it("neither sheet offers the deposit/rent family", async () => {
    mockListExpenses.mockResolvedValue({ items: [], total: "0.00" });
    renderDialog("owner");

    const select = await screen.findByLabelText("Line 1 category");
    expect(optionLabels(select)).not.toContain("Monthly rental");
  });

  // MONEY SAFETY — the regression this filter could have introduced.
  it("keeps a saved line's off-side category selectable so it never silently reads as 'No category'", async () => {
    mockListExpenses.mockResolvedValue({
      items: [ownerItem({ chargeCategoryId: "cat-sub-ten" })],
      total: "100.00",
    });
    renderDialog("owner");

    const select = (await screen.findByLabelText("Line 1 category")) as HTMLSelectElement;
    // The tenant-side category this owner line was saved with is still an option…
    expect(optionLabels(select)).toContain("Subsidy (tenant)");
    // …and is still the ACTIVE selection, not silently reset to "No category".
    expect(select.value).toBe("cat-sub-ten");
  });

  it("still offers 'No category' on every sheet", async () => {
    mockListExpenses.mockResolvedValue({ items: [], total: "0.00" });
    renderDialog("owner");

    const select = await screen.findByLabelText("Line 1 category");
    expect(optionLabels(select)).toContain("No category");
  });
});
