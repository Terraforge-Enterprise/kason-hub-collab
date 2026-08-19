import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { PhoneInput } from "./phone-input";

describe("PhoneInput", () => {
  test("reports invalid and keeps the typed text on a bad number", () => {
    const onChange = vi.fn();
    const onValidity = vi.fn();
    render(<PhoneInput value={null} onChange={onChange} onValidityChange={onValidity} label="Phone" />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "12345" } });
    fireEvent.blur(input);
    expect(onValidity).toHaveBeenLastCalledWith("invalid");
    expect(onChange).toHaveBeenLastCalledWith(null);
    expect((input as HTMLInputElement).value).toBe("12345"); // NOT cleared
  });

  test("reports valid + canonical on a good number", () => {
    const onChange = vi.fn();
    const onValidity = vi.fn();
    render(<PhoneInput value={null} onChange={onChange} onValidityChange={onValidity} label="Phone" />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "123456789" } });
    fireEvent.blur(input);
    expect(onValidity).toHaveBeenLastCalledWith("valid");
    expect(onChange).toHaveBeenLastCalledWith("60123456789");
  });

  test("paste-recovers-validity: pasting valid number after invalid clears invalid state", () => {
    const onChange = vi.fn();
    const onValidity = vi.fn();
    render(<PhoneInput value={null} onChange={onChange} onValidityChange={onValidity} label="Phone" />);
    const input = screen.getByRole("textbox");
    // First type an invalid number and blur → validity becomes "invalid"
    fireEvent.change(input, { target: { value: "12345" } });
    fireEvent.blur(input);
    expect(onValidity).toHaveBeenLastCalledWith("invalid");
    // Now paste a valid Malaysian mobile number
    fireEvent.paste(input, { clipboardData: { getData: () => "0123456789" } });
    expect(onValidity).toHaveBeenLastCalledWith("valid");
    expect(onChange).toHaveBeenLastCalledWith("60123456789");
  });

  test("empty-branch: clearing the field and blurring reports empty and onChange(null)", () => {
    const onChange = vi.fn();
    const onValidity = vi.fn();
    render(<PhoneInput value={null} onChange={onChange} onValidityChange={onValidity} label="Phone" />);
    const input = screen.getByRole("textbox");
    // Type a value then clear it
    fireEvent.change(input, { target: { value: "123456789" } });
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(onValidity).toHaveBeenLastCalledWith("empty");
    expect(onChange).toHaveBeenLastCalledWith(null);
  });
});
