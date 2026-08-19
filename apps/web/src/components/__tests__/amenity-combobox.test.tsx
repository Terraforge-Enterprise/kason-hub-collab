import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { AmenityCombobox } from "../amenity-combobox";

const CATALOG = [
  { id: "a1", name: "Air Conditioning" },
  { id: "a2", name: "Balcony" },
  { id: "a3", name: "Gym" },
  { id: "a4", name: "Pool" },
];

function wrap(ui: React.ReactElement) {
  return <MemoryRouter>{ui}</MemoryRouter>;
}

describe("AmenityCombobox", () => {
  it("renders all catalog options when nothing typed", async () => {
    render(wrap(<AmenityCombobox value={[]} onChange={vi.fn()} catalog={CATALOG} />));
    await userEvent.click(screen.getByRole("combobox"));
    expect(screen.getByText("Air Conditioning")).toBeInTheDocument();
    expect(screen.getByText("Pool")).toBeInTheDocument();
  });

  it("filters options by case-insensitive substring of typed text", async () => {
    render(wrap(<AmenityCombobox value={[]} onChange={vi.fn()} catalog={CATALOG} />));
    const input = screen.getByRole("combobox");
    await userEvent.click(input);
    await userEvent.type(input, "po");
    expect(screen.getByText("Pool")).toBeInTheDocument();
    expect(screen.queryByText("Gym")).toBeNull();
  });

  it("clicking an option calls onChange with the new ID added to the value", async () => {
    const onChange = vi.fn();
    render(wrap(<AmenityCombobox value={["a3"]} onChange={onChange} catalog={CATALOG} />));
    await userEvent.click(screen.getByRole("combobox"));
    await userEvent.click(screen.getByText("Pool"));
    expect(onChange).toHaveBeenCalledWith(["a3", "a4"]);
  });

  it("clicking a selected chip's X removes that ID from value", async () => {
    const onChange = vi.fn();
    render(wrap(<AmenityCombobox value={["a3", "a4"]} onChange={onChange} catalog={CATALOG} />));
    const removeBtn = screen.getByLabelText("Remove Gym");
    await userEvent.click(removeBtn);
    expect(onChange).toHaveBeenCalledWith(["a4"]);
  });

  it("renders selected chips for IDs in value (resolved from catalog)", () => {
    render(wrap(<AmenityCombobox value={["a3", "a4"]} onChange={vi.fn()} catalog={CATALOG} />));
    expect(screen.getByText("Gym")).toBeInTheDocument();
    expect(screen.getByText("Pool")).toBeInTheDocument();
  });

  it("renders empty-catalog callout with link to settings when catalog is []", () => {
    render(wrap(<AmenityCombobox value={[]} onChange={vi.fn()} catalog={[]} />));
    expect(screen.getByText(/no amenities defined yet/i)).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /inventory.*settings/i });
    expect(link).toHaveAttribute("href", "/settings/inventory");
  });

  it("disabled state: input is disabled, can't pick or remove", async () => {
    const onChange = vi.fn();
    render(wrap(<AmenityCombobox value={["a3"]} onChange={onChange} catalog={CATALOG} disabled />));
    expect(screen.getByRole("combobox")).toBeDisabled();
    const removeBtn = screen.queryByLabelText("Remove Gym");
    expect(removeBtn).toBeNull();
  });
});
