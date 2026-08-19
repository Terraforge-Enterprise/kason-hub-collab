import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PhoneInput } from "../phone-input";

describe("PhoneInput", () => {
  it("renders with locked +60 prefix and shows national digits when given canonical value", () => {
    render(<PhoneInput value="60123456789" onChange={vi.fn()} label="Phone" />);
    expect(screen.getByText("+60")).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("123456789");
  });

  it("renders empty when value is null", () => {
    render(<PhoneInput value={null} onChange={vi.fn()} />);
    expect(screen.getByRole("textbox")).toHaveValue("");
  });

  it("calls onChange with canonical 60XXXXXXXXX on blur of valid input", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<PhoneInput value={null} onChange={onChange} />);
    const input = screen.getByRole("textbox");
    await user.type(input, "012-345 6789");
    await user.tab();
    expect(onChange).toHaveBeenLastCalledWith("60123456789");
  });

  it("calls onChange with null on blur of invalid input", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<PhoneInput value={null} onChange={onChange} />);
    await user.type(screen.getByRole("textbox"), "xyz");
    await user.tab();
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("normalizes pasted +60... immediately to national digits in display", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<PhoneInput value={null} onChange={onChange} />);
    const input = screen.getByRole("textbox");
    await user.click(input);
    await user.paste("+60123456789");
    expect(input).toHaveValue("123456789");
  });

  it("renders error message when error prop is set", () => {
    render(<PhoneInput value={null} onChange={vi.fn()} error="Required" />);
    expect(screen.getByText("Required")).toBeInTheDocument();
  });

  it("sets aria-invalid and aria-describedby when error is present", () => {
    render(<PhoneInput value={null} onChange={vi.fn()} error="Required" />);
    const input = screen.getByRole("textbox");
    expect(input).toHaveAttribute("aria-invalid", "true");
    const describedBy = input.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)).toHaveTextContent("Required");
  });

  it("forwards required to the underlying input", () => {
    render(<PhoneInput value={null} onChange={vi.fn()} required />);
    expect(screen.getByRole("textbox")).toBeRequired();
  });

  it("strips leading 0 from typed national format on blur", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<PhoneInput value={null} onChange={onChange} />);
    const input = screen.getByRole("textbox");
    await user.type(input, "0123456789");
    await user.tab();
    expect(input).toHaveValue("123456789");
    expect(onChange).toHaveBeenLastCalledWith("60123456789");
  });
});
