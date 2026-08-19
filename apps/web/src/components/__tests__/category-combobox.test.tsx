import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CategoryCombobox } from "../category-combobox";

// Mock the hook so the combobox doesn't need a QueryClient in tests.
// The list mirrors the canonical seed categories so all name-based assertions hold.
vi.mock("@/hooks/use-work-categories", () => ({
  useActiveWorkCategories: vi.fn(() => ({
    data: [
      { id: "1", name: "Plumbing" },
      { id: "2", name: "Lighting" },
      { id: "3", name: "Electrical" },
      { id: "4", name: "Aircond/HVAC" },
      { id: "5", name: "Appliance" },
      { id: "6", name: "Furniture/Fittings" },
      { id: "7", name: "Wifi/Internet" },
      { id: "8", name: "Pest" },
      { id: "9", name: "Cleaning" },
      { id: "10", name: "Locks/Access" },
      { id: "11", name: "Structural" },
      { id: "12", name: "Painting" },
    ],
  })),
}));

describe("CategoryCombobox", () => {
  it("renders all canonical options", () => {
    render(<CategoryCombobox value="" onChange={() => {}} />);
    fireEvent.click(screen.getByRole("combobox"));
    expect(screen.getByRole("option", { name: "Plumbing" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Other" })).toBeInTheDocument();
  });
  it("emits the canonical label when a canonical option is chosen", () => {
    const onChange = vi.fn();
    render(<CategoryCombobox value="" onChange={onChange} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "Lighting" } });
    expect(onChange).toHaveBeenCalledWith("Lighting");
  });
  it("reveals a free-text input in Other mode and emits the typed value", () => {
    const onChange = vi.fn();
    render(<CategoryCombobox value="" onChange={onChange} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "Other" } });
    const free = screen.getByPlaceholderText(/specify/i);
    fireEvent.change(free, { target: { value: "balcony tiles" } });
    expect(onChange).toHaveBeenLastCalledWith("balcony tiles");
  });
  it("opens a legacy non-canonical value in Other mode pre-filled", () => {
    render(<CategoryCombobox value="aircond leaking" onChange={() => {}} />);
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("Other");
    expect(screen.getByDisplayValue("aircond leaking")).toBeInTheDocument();
  });
  it("opens a canonical value in select mode (not Other) on edit-load", () => {
    render(<CategoryCombobox value="Plumbing" onChange={() => {}} />);
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("Plumbing");
    expect(screen.queryByPlaceholderText(/specify/i)).not.toBeInTheDocument();
  });
  it("switches to canonical mode when the parent changes value to a canonical label", () => {
    const { rerender } = render(<CategoryCombobox value="aircond leaking" onChange={() => {}} />);
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("Other");
    rerender(<CategoryCombobox value="Lighting" onChange={() => {}} />);
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("Lighting");
    expect(screen.queryByPlaceholderText(/specify/i)).not.toBeInTheDocument();
  });
  it("disables the select, and the Other free-text input, when disabled is true", () => {
    render(<CategoryCombobox value="aircond leaking" onChange={() => {}} disabled />);
    expect(screen.getByRole("combobox")).toBeDisabled();
    expect(screen.getByDisplayValue("aircond leaking")).toBeDisabled();
  });
});
