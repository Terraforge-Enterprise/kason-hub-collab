import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DataDrivenSection } from "../../ui/data-driven-section";

const mkValues = (n: number): { id: string; name: string }[] =>
  Array.from({ length: n }, (_, i) => ({ id: `v${i}`, name: `Value ${i}` }));

describe("DataDrivenSection", () => {
  it("returns null when values.length < 2 (auto-hide)", () => {
    const { container } = render(
      <DataDrivenSection title="X" values={mkValues(1)} selected={[]} onChange={() => {}} alwaysOpen />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders chip bar when 2-6 values", () => {
    render(
      <DataDrivenSection title="X" values={mkValues(3)} selected={[]} onChange={() => {}} alwaysOpen />,
    );
    expect(screen.getByRole("group")).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(3);
  });

  it("renders checkbox list when 7-15 values", () => {
    render(
      <DataDrivenSection title="X" values={mkValues(10)} selected={[]} onChange={() => {}} alwaysOpen />,
    );
    expect(screen.getByPlaceholderText(/search/i)).toBeInTheDocument();
    expect(screen.getAllByRole("checkbox")).toHaveLength(10);
  });

  it("renders combobox trigger when 16+ values", () => {
    render(
      <DataDrivenSection title="X" values={mkValues(20)} selected={[]} onChange={() => {}} alwaysOpen />,
    );
    expect(screen.getByRole("button", { name: /select/i })).toBeInTheDocument();
  });

  it("clicking a chip toggles selection", async () => {
    const onChange = vi.fn();
    render(
      <DataDrivenSection title="X" values={mkValues(3)} selected={[]} onChange={onChange} alwaysOpen />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Value 1" }));
    expect(onChange).toHaveBeenCalledWith(["v1"]);
  });
});
