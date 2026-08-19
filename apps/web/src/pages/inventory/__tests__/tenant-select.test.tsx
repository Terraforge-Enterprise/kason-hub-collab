import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, it, expect, vi } from "vitest";
import { TenantSelect } from "../unit-form-fields";
import { apiFetch } from "@/lib/api-client";

vi.mock("@/lib/api-client", () => ({ apiFetch: vi.fn() }));

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

describe("<TenantSelect>", () => {
  it("queries /parties/tenants/search and renders masked IC + phone sublabel", async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      data: [{ id: "t1", displayName: "NURUL IZZAH", primaryPhone: "60123456789",
               formattedPhone: "+60 12-345 6789", idType: "nric", idNumberMasked: "••••5678" }],
    });
    const onSelect = vi.fn();
    render(wrap(<TenantSelect value={null} displayName="" onSelect={onSelect} onClear={vi.fn()} />));

    await userEvent.type(screen.getByPlaceholderText(/search existing tenants/i), "nur");
    await waitFor(() =>
      expect(vi.mocked(apiFetch)).toHaveBeenCalledWith(
        expect.stringContaining("/parties/tenants/search?q=nur"),
      ),
    );
    expect(await screen.findByText("NURUL IZZAH")).toBeInTheDocument();
    expect(screen.getByText(/••••5678/)).toBeInTheDocument();
    expect(screen.getByText(/\+60 12-345 6789/)).toBeInTheDocument();

    await userEvent.click(screen.getByText("NURUL IZZAH"));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "t1", idNumberMasked: "••••5678" }));
  });

  it("renders a 'create in Parties first' empty state, never an auto-create option", async () => {
    vi.mocked(apiFetch).mockResolvedValue({ data: [] });
    render(wrap(<TenantSelect value={null} displayName="" onSelect={vi.fn()} onClear={vi.fn()} />));
    await userEvent.type(screen.getByPlaceholderText(/search existing tenants/i), "zzz");
    expect(await screen.findByText(/create the tenant in parties first/i)).toBeInTheDocument();
  });

  it("shows the selected name read-only with a Clear button", async () => {
    const onClear = vi.fn();
    render(wrap(<TenantSelect value="t1" displayName="NURUL IZZAH" onSelect={vi.fn()} onClear={onClear} />));
    const input = screen.getByDisplayValue("NURUL IZZAH") as HTMLInputElement;
    expect(input.readOnly).toBe(true);
    await userEvent.click(screen.getByText("Clear"));
    expect(onClear).toHaveBeenCalled();
  });
});
