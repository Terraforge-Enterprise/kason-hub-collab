import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

vi.mock("@/lib/api-client", () => ({ apiFetch: vi.fn() }));
import { apiFetch } from "@/lib/api-client";
import { UnitPicker, ApartmentPicker } from "../unit-picker";

const apiFetchMock = vi.mocked(apiFetch);

function withQuery(node: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>;
}

beforeEach(() => vi.clearAllMocks());

describe("UnitPicker — pick by label, submit the id (frontend §15/§16)", () => {
  it("searches /inventory/units, disambiguates rooms by type, submits id + 'code · property' label", async () => {
    apiFetchMock.mockResolvedValue({
      data: [{ id: "u-1", unitCode: "A-08-02", propertyName: "Bangsar South", unitType: "master" }],
    } as unknown as ReturnType<typeof apiFetch>);
    const onSelect = vi.fn();
    render(withQuery(<UnitPicker value={null} displayName="" onSelect={onSelect} onClear={vi.fn()} />));

    const input = screen.getByPlaceholderText(/unit code/i);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "A-08" } });

    const opt = await screen.findByText("A-08-02");
    expect(screen.getByText("Bangsar South · master")).toBeInTheDocument(); // room disambiguator
    fireEvent.click(opt);

    expect(onSelect).toHaveBeenCalledWith("u-1", "A-08-02 · Bangsar South");
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith(expect.stringContaining("/inventory/units?q=A-08")),
    );
  });

  it("with a selected value: shows the label read-only and a working Clear", () => {
    const onClear = vi.fn();
    render(
      withQuery(<UnitPicker value="u-1" displayName="A-08-02 · Bangsar South" onSelect={vi.fn()} onClear={onClear} />),
    );
    const input = screen.getByDisplayValue("A-08-02 · Bangsar South");
    expect(input).toHaveAttribute("readonly");
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(onClear).toHaveBeenCalled();
  });
});

describe("ApartmentPicker — hits the apartment search endpoint", () => {
  it("searches /inventory/apartments with the typed query", async () => {
    apiFetchMock.mockResolvedValue({
      data: [{ id: "a-1", unitCode: "A-08-02", propertyName: "Bangsar South" }],
    } as unknown as ReturnType<typeof apiFetch>);
    render(withQuery(<ApartmentPicker value={null} displayName="" onSelect={vi.fn()} onClear={vi.fn()} />));

    const input = screen.getByPlaceholderText(/apartment code/i);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "A-08" } });

    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith(expect.stringContaining("/inventory/apartments?q=A-08")),
    );
  });
});
