import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PropertyTypeSelect } from "@/components/property-type-select";

const OPTIONS = [{ id: "t1", name: "Condominium" }, { id: "t2", name: "Landed" }];

describe("PropertyTypeSelect", () => {
  it("lists exactly the catalog options plus the placeholder when value is empty", () => {
    render(<PropertyTypeSelect value="" onChange={() => {}} options={OPTIONS} placeholder="Pick a type…" />);
    const opts = screen.getAllByRole("option").map((o) => o.textContent);
    expect(opts).toEqual(["Pick a type…", "Condominium", "Landed"]);
  });

  it("renders an off-catalog value as a synthetic '(current)' selected option", () => {
    render(<PropertyTypeSelect value="shophouse" onChange={() => {}} options={OPTIONS} />);
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select.value).toBe("shophouse");
    expect(screen.getByRole("option", { name: "shophouse (current)" })).toBeTruthy();
  });

  it("does NOT duplicate the value option when it is already in the catalog", () => {
    render(<PropertyTypeSelect value="Landed" onChange={() => {}} options={OPTIONS} />);
    expect(screen.getAllByRole("option", { name: "Landed" })).toHaveLength(1);
    expect(screen.queryByRole("option", { name: "Landed (current)" })).toBeNull();
  });

  it("calls onChange with the selected name", () => {
    const onChange = vi.fn();
    render(<PropertyTypeSelect value="" onChange={onChange} options={OPTIONS} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "Landed" } });
    expect(onChange).toHaveBeenCalledWith("Landed");
  });
});
