import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../../../api/billing-documents", () => ({
  usePropertyOptions: () => ({ data: [{ id: "p1", name: "Seri Kembangan Heights" }], isLoading: false }),
}));

async function mount(onChange: (v: unknown) => void) {
  const { DocsFilterControls } = await import("../docs-filter-controls");
  render(
    <QueryClientProvider client={new QueryClient()}>
      <DocsFilterControls
        statusOptions={[
          { value: "all", label: "All statuses" },
          { value: "issued", label: "Issued" },
        ]}
        onChange={onChange}
      />
    </QueryClientProvider>,
  );
}

describe("DocsFilterControls", () => {
  it("renders Owner/Tenant tabs and a Property dropdown", async () => {
    await mount(() => {});
    expect(screen.getByRole("button", { name: /Tenant/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Owner/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Seri Kembangan Heights" })).toBeInTheDocument();
  });

  it("emits counterpartyType when a tab is selected (All → undefined)", async () => {
    const onChange = vi.fn();
    await mount(onChange);
    fireEvent.click(screen.getByRole("button", { name: /Owner/ }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ counterpartyType: "owner" }));
    fireEvent.click(screen.getByRole("button", { name: /^All$/ }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ counterpartyType: undefined }));
  });

  it("emits propertyId and status from the dropdowns", async () => {
    const onChange = vi.fn();
    await mount(onChange);
    fireEvent.change(screen.getByLabelText("Property"), { target: { value: "p1" } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ propertyId: "p1" }));
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "issued" } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ status: "issued" }));
  });
});
