import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, it, expect, vi } from "vitest";
import { OwnerConfirmCard } from "../owner-confirm-card";

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

const base = {
  ownerName: "TAN AH KOW",
  ownerPhone: "+60 11-234 5678",
  onChange: vi.fn(),
};

describe("<OwnerConfirmCard>", () => {
  it("shows owner name and phone", () => {
    render(wrap(<OwnerConfirmCard {...base} />));
    expect(screen.getByText("TAN AH KOW")).toBeInTheDocument();
    expect(screen.getByText("+60 11-234 5678")).toBeInTheDocument();
  });

  it("shows — when phone is absent", () => {
    render(wrap(<OwnerConfirmCard ownerName="TAN AH KOW" ownerPhone={null} onChange={vi.fn()} />));
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("Change owner fires the onChange callback", async () => {
    const onChange = vi.fn();
    render(wrap(<OwnerConfirmCard {...base} onChange={onChange} />));
    await userEvent.click(screen.getByRole("button", { name: /change owner/i }));
    expect(onChange).toHaveBeenCalled();
  });

  it("does NOT have a Reveal IC button", () => {
    render(wrap(<OwnerConfirmCard {...base} />));
    expect(screen.queryByRole("button", { name: /reveal ic/i })).not.toBeInTheDocument();
  });
});
