import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NewInvoiceDrawer, familyBadgeText } from "../new-invoice-drawer";

describe("familyBadgeText (derived, read-only)", () => {
  it("pay_back_landlord → Owner's — pay back", () => {
    expect(familyBadgeText("pay_back_landlord")).toBe("Owner's — pay back");
  });
  it("tenant_income and owner_income → KAEN income", () => {
    expect(familyBadgeText("tenant_income")).toBe("KAEN income");
    expect(familyBadgeText("owner_income")).toBe("KAEN income");
  });
  it("undefined family → null (nothing to derive)", () => {
    expect(familyBadgeText(undefined)).toBeNull();
  });
});

// Mock the category source + create mutation (no network for those).
vi.mock("../../../api/charge-categories", () => ({
  useChargeCategories: () => ({
    data: {
      items: [
        { id: "c1", name: "Monthly rental", family: "pay_back_landlord", code: "rental", docType: "debit_note", seriesCode: "DEP", active: true },
        { id: "c2", name: "Cleaning", family: "tenant_income", code: "cleaning_tenant", docType: "invoice", seriesCode: "IVTEN", active: true },
      ],
    },
  }),
}));
vi.mock("../../../api/accounting", () => ({ useCreateManualInvoice: () => ({ mutate: vi.fn(), isPending: false }) }));

// The party + unit pickers fetch through apiFetch (mirroring ChargeForm). Mock it
// so the dropdowns populate from /parties/{tenants,owners} + /inventory/apartments.
vi.mock("@/lib/api-client", () => ({
  apiFetch: vi.fn(async (url: string) => {
    if (url.includes("/parties/owners")) return { data: [{ id: "o1", displayName: "Owner One" }] };
    if (url.includes("/parties/tenants")) return { data: [{ id: "t1", displayName: "Tenant One" }] };
    if (url.includes("/inventory/apartments")) return { data: [{ id: "a1", unitCode: "A-08-02", propertyName: "Kaen Tower" }] };
    return { data: [] };
  }),
  ApiError: class ApiError extends Error {},
}));

function renderDrawer(props: Record<string, unknown> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <NewInvoiceDrawer open onClose={() => {}} {...props} />
    </QueryClientProvider>,
  );
}

it("uses a party PICKER (not a raw UUID input) and populates from /parties", async () => {
  renderDrawer();
  // The raw 'Party UUID' text input must be gone.
  expect(screen.queryByPlaceholderText(/party uuid/i)).toBeNull();
  // A Tenant/Owner 'Bill to' selector is present.
  expect(screen.getByLabelText(/bill to/i)).toBeInTheDocument();
  // The party dropdown is populated by name from /parties/tenants (default type).
  expect(await screen.findByRole("option", { name: "Tenant One" })).toBeInTheDocument();
});

it("offers a Unit selector (optional apartmentId) and inline line rows", async () => {
  renderDrawer();
  expect(screen.getByLabelText(/unit/i)).toBeInTheDocument();
  expect(await screen.findByRole("option", { name: /A-08-02/ })).toBeInTheDocument();
});

it("renders the derived family badge when a category is selected on a line", () => {
  renderDrawer({ defaultPartyId: "p1" });
  const select = screen.getByLabelText(/category/i);
  fireEvent.change(select, { target: { value: "c1" } });
  expect(screen.getByText("Owner's — pay back")).toBeInTheDocument();
});
