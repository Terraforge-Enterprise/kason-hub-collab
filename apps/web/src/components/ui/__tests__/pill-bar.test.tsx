import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PillBar } from "../pill-bar";

describe("PillBar", () => {
  const opts = [
    { value: "a", label: "A" },
    { value: "b", label: "B" },
    { value: "c", label: "C" },
  ];

  it("renders all options as buttons", () => {
    render(<PillBar value={[]} onChange={() => {}} options={opts} ariaLabel="X" />);
    expect(screen.getAllByRole("button")).toHaveLength(3);
  });

  it("clicking an unselected option adds it", async () => {
    const onChange = vi.fn();
    render(<PillBar value={[]} onChange={onChange} options={opts} ariaLabel="X" />);
    await userEvent.click(screen.getByRole("button", { name: "B" }));
    expect(onChange).toHaveBeenCalledWith(["b"]);
  });

  it("clicking a selected option removes it", async () => {
    const onChange = vi.fn();
    render(<PillBar value={["a", "b"]} onChange={onChange} options={opts} ariaLabel="X" />);
    await userEvent.click(screen.getByRole("button", { name: "A" }));
    expect(onChange).toHaveBeenCalledWith(["b"]);
  });

  it("aria-pressed reflects selection", () => {
    render(<PillBar value={["b"]} onChange={() => {}} options={opts} ariaLabel="X" />);
    expect(screen.getByRole("button", { name: "A" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "B" })).toHaveAttribute("aria-pressed", "true");
  });

  describe("mode=\"single\"", () => {
    it("picking another option REPLACES the current one", async () => {
      // For a filter whose backend takes one value: without this the caller ends
      // up with a two-value state it cannot express in a query string.
      const onChange = vi.fn();
      render(<PillBar mode="single" value={["a"]} onChange={onChange} options={opts} ariaLabel="X" />);
      await userEvent.click(screen.getByRole("button", { name: "B" }));
      expect(onChange).toHaveBeenCalledWith(["b"]);
    });

    it("clicking the selected option clears it — 'no filter' stays reachable", async () => {
      const onChange = vi.fn();
      render(<PillBar mode="single" value={["a"]} onChange={onChange} options={opts} ariaLabel="X" />);
      await userEvent.click(screen.getByRole("button", { name: "A" }));
      expect(onChange).toHaveBeenCalledWith([]);
    });

    it("never emits more than one value even from a multi-value starting state", async () => {
      const onChange = vi.fn();
      render(<PillBar mode="single" value={["a", "b"]} onChange={onChange} options={opts} ariaLabel="X" />);
      await userEvent.click(screen.getByRole("button", { name: "C" }));
      expect(onChange).toHaveBeenCalledWith(["c"]);
    });

    it("multi mode is untouched — the default must not change for existing callers", async () => {
      const onChange = vi.fn();
      render(<PillBar value={["a"]} onChange={onChange} options={opts} ariaLabel="X" />);
      await userEvent.click(screen.getByRole("button", { name: "B" }));
      expect(onChange).toHaveBeenCalledWith(["a", "b"]);
    });
  });
});
