import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TextInput, SelectInput, TextAreaInput } from "@/components/form-ui";

describe("form-ui disabled styling", () => {
  it("TextInput reads as locked (opacity + not-allowed cursor) when disabled", () => {
    render(<TextInput aria-label="x" disabled />);
    const input = screen.getByLabelText("x");
    expect(input.className).toContain("disabled:opacity-60");
    expect(input.className).toContain("disabled:cursor-not-allowed");
  });

  it("SelectInput reads as locked (opacity + not-allowed cursor) when disabled", () => {
    render(<SelectInput aria-label="y" disabled />);
    const select = screen.getByLabelText("y");
    expect(select.className).toContain("disabled:opacity-60");
    expect(select.className).toContain("disabled:cursor-not-allowed");
  });

  it("TextAreaInput reads as locked (opacity + not-allowed cursor) when disabled", () => {
    render(<TextAreaInput aria-label="z" disabled />);
    const textarea = screen.getByLabelText("z");
    expect(textarea.className).toContain("disabled:opacity-60");
    expect(textarea.className).toContain("disabled:cursor-not-allowed");
  });
});
