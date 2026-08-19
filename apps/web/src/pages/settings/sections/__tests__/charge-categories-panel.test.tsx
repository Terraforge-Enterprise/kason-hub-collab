// ChargeCategoriesPanel — the charge-category registry as rendered inside Settings →
// Billing Config. Carries forward the behavioural coverage from the former standalone
// charge-categories-section page (save with the concurrency token, series reassignment,
// stale-409 toast, built-in categories not removable) and adds the new surfaces: the
// Add-category drawer and the Remove confirmation.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

const updateMutateMock = vi.fn();
const deactivateMutateMock = vi.fn();
const createMutateMock = vi.fn();
const authRole = { current: "admin" as string };

vi.mock("@/api/charge-categories", () => ({
  useChargeCategories: () => ({
    data: {
      items: [
        {
          id: "c-pest", code: "pest_control_owner", name: "Pest control (owner)", family: "owner_income",
          docType: "invoice", seriesId: "s-own", seriesCode: "IVOWN", defaultSstRate: "0",
          eInvoiceEligible: false, ledgerCategory: null, isSystem: false, active: true,
          sortOrder: 950, description: null, profitExpense: null, updatedAt: "2026-07-02T00:00:00.000Z",
        },
        {
          id: "c-mgmt", code: "management_fee", name: "Management fee", family: "owner_income",
          docType: "invoice", seriesId: "s-own", seriesCode: "IVOWN", defaultSstRate: "8",
          eInvoiceEligible: false, ledgerCategory: "management_fee", isSystem: true, active: true,
          sortOrder: 100, description: null, profitExpense: "profit", updatedAt: "2026-07-03T00:00:00.000Z",
        },
      ],
    },
    isLoading: false,
    isError: false,
  }),
  useDocumentSeries: () => ({
    data: {
      items: [
        { id: "s-ten", code: "IVTEN", prefix: "IVTEN", padding: 4, includeYear: false, active: true, updatedAt: "2026-07-01T00:00:00.000Z" },
        { id: "s-own", code: "IVOWN", prefix: "IVOWN", padding: 4, includeYear: false, active: true, updatedAt: "2026-07-01T00:00:00.000Z" },
      ],
    },
    isLoading: false,
    isError: false,
  }),
  useCreateChargeCategory: () => ({ mutate: createMutateMock, isPending: false }),
  useUpdateChargeCategory: () => ({ mutate: updateMutateMock, isPending: false }),
  useDeactivateChargeCategory: () => ({ mutate: deactivateMutateMock, isPending: false }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { role: authRole.current } }) }));

import { toast } from "sonner";
import { ChargeCategoriesPanel } from "../charge-categories-panel";

beforeEach(() => {
  updateMutateMock.mockReset();
  deactivateMutateMock.mockReset();
  createMutateMock.mockReset();
  vi.mocked(toast.error).mockReset();
  vi.mocked(toast.success).mockReset();
  authRole.current = "admin";
});

describe("ChargeCategoriesPanel — table", () => {
  it("renders one row per category with its side", () => {
    render(<ChargeCategoriesPanel />);
    expect(screen.getByText("Pest control (owner)")).toBeTruthy();
    expect(screen.getByText("Management fee")).toBeTruthy();
    expect(screen.getAllByText("Owner").length).toBeGreaterThan(0);
  });

  it("saves the profit/expense pick with the optimistic-concurrency token", async () => {
    render(<ChargeCategoriesPanel />);
    fireEvent.change(screen.getByLabelText("Pest control (owner) profit or expense"), {
      target: { value: "expense" },
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0]);
    await waitFor(() => expect(updateMutateMock).toHaveBeenCalled());
    expect(updateMutateMock.mock.calls[0][0]).toMatchObject({
      id: "c-pest",
      profitExpense: "expense",
      expectedUpdatedAt: "2026-07-02T00:00:00.000Z",
    });
  });

  it("sends the reassigned document series on save", async () => {
    render(<ChargeCategoriesPanel />);
    fireEvent.change(screen.getByLabelText("Pest control (owner) document series"), {
      target: { value: "s-ten" },
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0]);
    await waitFor(() => expect(updateMutateMock).toHaveBeenCalled());
    expect(updateMutateMock.mock.calls[0][0]).toMatchObject({ id: "c-pest", seriesId: "s-ten" });
  });

  it("surfaces a toast on a stale-token 409 instead of silently overwriting", async () => {
    updateMutateMock.mockImplementation((_vars, { onError }: { onError: (err: unknown) => void }) => {
      onError(new Error("This row changed since you loaded it — refresh and try again."));
    });
    render(<ChargeCategoriesPanel />);
    fireEvent.change(screen.getByLabelText("Pest control (owner) profit or expense"), {
      target: { value: "expense" },
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0]);
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
  });
});

describe("ChargeCategoriesPanel — remove", () => {
  // Built-ins are resolved BY CODE by auto-post flows (rent, management fee, utilities);
  // removing one breaks posting. Server enforces 409 CATEGORY_IS_SYSTEM; this is the
  // matching client gate.
  it("disables Remove for a built-in category", () => {
    render(<ChargeCategoriesPanel />);
    const removeButtons = screen.getAllByRole("button", { name: "Remove" });
    expect(removeButtons[0]).not.toBeDisabled(); // c-pest
    expect(removeButtons[1]).toBeDisabled(); // c-mgmt (isSystem)
  });

  it("does not deactivate until the confirmation is accepted", async () => {
    render(<ChargeCategoriesPanel />);
    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]);
    // Dialog is open, but nothing has been mutated yet.
    expect(await screen.findByText(/Remove “Pest control \(owner\)”\?/)).toBeTruthy();
    expect(deactivateMutateMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Remove category" }));
    await waitFor(() => expect(deactivateMutateMock).toHaveBeenCalled());
    expect(deactivateMutateMock.mock.calls[0][0]).toBe("c-pest");
  });

  it("cancelling the confirmation removes nothing", async () => {
    render(<ChargeCategoriesPanel />);
    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Remove category" })).toBeNull());
    expect(deactivateMutateMock).not.toHaveBeenCalled();
  });

  // The confirm copy is load-bearing: "Remove" is a deactivate, and an admin must be
  // told history keeps its classification rather than fearing a destructive delete.
  it("states that existing charges keep their classification", async () => {
    render(<ChargeCategoriesPanel />);
    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]);
    // findAllBy*: base-ui mirrors the description into an inert clone alongside the
    // live popup, so the copy legitimately matches more than one node.
    const copies = await screen.findAllByText(/keep that\s+classification/);
    expect(copies.length).toBeGreaterThan(0);
  });
});

describe("ChargeCategoriesPanel — add", () => {
  it("derives family, docType and series from the chosen side", async () => {
    render(<ChargeCategoriesPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Add category/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Category name"), {
      target: { value: "Pest control 2" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add category" }));

    await waitFor(() => expect(createMutateMock).toHaveBeenCalled());
    expect(createMutateMock.mock.calls[0][0]).toMatchObject({
      name: "Pest control 2",
      code: "pest_control_2", // auto-slugged from the name
      family: "owner_income", // default side = owner
      docType: "invoice",
      seriesId: "s-own", // IVOWN, resolved by code
      profitExpense: "expense",
    });
  });

  it("routes a tenant-side category to tenant_income / IVTEN", async () => {
    render(<ChargeCategoriesPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Add category/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Category side"), { target: { value: "tenant" } });
    fireEvent.change(within(dialog).getByLabelText("Category name"), { target: { value: "Late key fee" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add category" }));

    await waitFor(() => expect(createMutateMock).toHaveBeenCalled());
    expect(createMutateMock.mock.calls[0][0]).toMatchObject({
      family: "tenant_income",
      seriesId: "s-ten",
    });
  });

  it("blocks a duplicate code client-side instead of POSTing into a 409", async () => {
    render(<ChargeCategoriesPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Add category/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Category name"), {
      target: { value: "Pest control (owner)" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add category" }));

    expect(await within(dialog).findByText(/already in use|already exists/)).toBeTruthy();
    expect(createMutateMock).not.toHaveBeenCalled();
  });

  it("rejects a hand-edited code that isn't snake_case", async () => {
    render(<ChargeCategoriesPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Add category/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Category name"), { target: { value: "Valid name" } });
    fireEvent.change(within(dialog).getByLabelText("Category code"), { target: { value: "Not Valid!" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add category" }));

    expect(await within(dialog).findByText(/lowercase letters, numbers and underscores/)).toBeTruthy();
    expect(createMutateMock).not.toHaveBeenCalled();
  });

  it("offers the owner-statement bucket only for owner-side categories", async () => {
    render(<ChargeCategoriesPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Add category/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText("Owner statement bucket")).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("Category side"), { target: { value: "tenant" } });
    expect(within(dialog).queryByLabelText("Owner statement bucket")).toBeNull();
  });
});

describe("ChargeCategoriesPanel — permissions", () => {
  it("lets a manager add and remove (matches the API's manager gate)", () => {
    authRole.current = "manager";
    render(<ChargeCategoriesPanel />);
    expect(screen.getByRole("button", { name: /Add category/ })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Remove" }).length).toBeGreaterThan(0);
  });

  it("gives an editor a read-only table — no Add, no Remove, no Save", () => {
    authRole.current = "editor";
    render(<ChargeCategoriesPanel />);
    expect(screen.queryByRole("button", { name: /Add category/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    // The list itself is still visible.
    expect(screen.getByText("Pest control (owner)")).toBeTruthy();
    // …and its controls are not editable.
    expect(screen.getByLabelText("Pest control (owner) profit or expense")).toBeDisabled();
  });
});
