import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { UnitTypeStep } from "../unit-type-step";

const options = [
  { id: "1", name: "Whole Unit", kind: "WHOLE" as const, sortOrder: 0 },
  { id: "2", name: "Master", kind: "PARTITION" as const, sortOrder: 1 },
  { id: "3", name: "Medium", kind: "PARTITION" as const, sortOrder: 2 },
];

describe("UnitTypeStep", () => {
  it("dropdown disabled until a mode is picked", () => {
    render(
      <UnitTypeStep value="" mode={null} onChange={vi.fn()} onModeChange={vi.fn()} options={options} />,
    );
    expect((screen.getByRole("combobox") as HTMLSelectElement).disabled).toBe(true);
  });

  it("whole mode locks partition options", () => {
    render(
      <UnitTypeStep value="" mode="WHOLE" onChange={vi.fn()} onModeChange={vi.fn()} options={options} />,
    );
    expect((screen.getByRole("option", { name: "Master" }) as HTMLOptionElement).disabled).toBe(true);
    expect((screen.getByRole("option", { name: "Whole Unit" }) as HTMLOptionElement).disabled).toBe(
      false,
    );
  });

  it("switching mode clears an off-mode selection", () => {
    const onChange = vi.fn();
    const onModeChange = vi.fn();
    render(
      <UnitTypeStep
        value="Whole Unit"
        mode="WHOLE"
        onChange={onChange}
        onModeChange={onModeChange}
        options={options}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /partition/i }));
    expect(onModeChange).toHaveBeenCalledWith("PARTITIONED");
    expect(onChange).toHaveBeenCalledWith("");
  });
});
