import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, it, expect, vi } from "vitest";
import { TenantConfirmCard } from "../tenant-confirm-card";
import { apiFetch } from "@/lib/api-client";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/api-client", () => ({ apiFetch: vi.fn() }));

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

const base = {
  tenantPartyId: "t1", displayName: "NURUL IZZAH",
  idType: "nric", idNumberMasked: "••••5678", phone: "+60 12-345 6789",
  onChangeTenant: vi.fn(),
};

describe("<TenantConfirmCard>", () => {
  it("shows masked IC + phone and a Reveal IC button", () => {
    render(wrap(<TenantConfirmCard {...base} />));
    expect(screen.getByText("NURUL IZZAH")).toBeInTheDocument();
    expect(screen.getByText("••••5678")).toBeInTheDocument();
    expect(screen.getByText("+60 12-345 6789")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reveal ic/i })).toBeInTheDocument();
  });

  it("calls POST /parties/:id/ic-reveal and swaps in the raw IC", async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({ partyId: "t1", idNumber: "990101-14-5678" });
    render(wrap(<TenantConfirmCard {...base} />));
    await userEvent.click(screen.getByRole("button", { name: /reveal ic/i }));
    await waitFor(() => expect(screen.getByText("990101-14-5678")).toBeInTheDocument());
    expect(vi.mocked(apiFetch)).toHaveBeenCalledWith(
      "/parties/t1/ic-reveal",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ partyId: "t1" }) }),
    );
    // button gone once revealed
    expect(screen.queryByRole("button", { name: /reveal ic/i })).not.toBeInTheDocument();
  });

  it("no Reveal button when there is no IC on file", () => {
    render(wrap(<TenantConfirmCard {...base} idNumberMasked={null} />));
    expect(screen.queryByRole("button", { name: /reveal ic/i })).not.toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("Change tenant fires the callback", async () => {
    const onChangeTenant = vi.fn();
    render(wrap(<TenantConfirmCard {...base} onChangeTenant={onChangeTenant} />));
    await userEvent.click(screen.getByRole("button", { name: /change tenant/i }));
    expect(onChangeTenant).toHaveBeenCalled();
  });
});
