import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Segmented } from "../segmented";

const OPTIONS = [
  { value: "percent_of_purchase", label: "% of Purchase" },
  { value: "fixed", label: "Fixed RM" },
] as const;

const THREE_OPTIONS = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Beta" },
  { value: "c", label: "Gamma" },
] as const;

describe("Segmented", () => {
  it("renders all options and marks the selected one as pressed", () => {
    render(
      <Segmented value="percent_of_purchase" onChange={() => {}}
        options={[...OPTIONS]} ariaLabel="Commission type" />,
    );
    expect(screen.getByRole("radiogroup", { name: "Commission type" })).toBeInTheDocument();
    const selected = screen.getByRole("radio", { name: "% of Purchase" });
    const other = screen.getByRole("radio", { name: "Fixed RM" });
    expect(selected).toHaveAttribute("aria-checked", "true");
    expect(other).toHaveAttribute("aria-checked", "false");
  });

  it("calls onChange with the new value when an unselected option is clicked", async () => {
    const onChange = vi.fn();
    render(
      <Segmented value="percent_of_purchase" onChange={onChange}
        options={[...OPTIONS]} ariaLabel="Commission type" />,
    );
    await userEvent.click(screen.getByRole("radio", { name: "Fixed RM" }));
    expect(onChange).toHaveBeenCalledWith("fixed");
  });

  it("supports keyboard navigation: ArrowRight moves selection to next option", async () => {
    const onChange = vi.fn();
    render(
      <Segmented value="percent_of_purchase" onChange={onChange}
        options={[...OPTIONS]} ariaLabel="Commission type" />,
    );
    const first = screen.getByRole("radio", { name: "% of Purchase" });
    first.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenCalledWith("fixed");
  });

  it("ArrowLeft from the first option wraps to the last option", async () => {
    const onChange = vi.fn();
    render(
      <Segmented value="percent_of_purchase" onChange={onChange}
        options={[...OPTIONS]} ariaLabel="Commission type" />,
    );
    screen.getByRole("radio", { name: "% of Purchase" }).focus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(onChange).toHaveBeenCalledWith("fixed");
  });

  it("Home jumps to the first option, End jumps to the last", async () => {
    const onChange = vi.fn();
    render(
      <Segmented value="b" onChange={onChange}
        options={[...THREE_OPTIONS]} ariaLabel="Test" />,
    );
    screen.getByRole("radio", { name: "Beta" }).focus();
    await userEvent.keyboard("{End}");
    expect(onChange).toHaveBeenLastCalledWith("c");
    onChange.mockClear();
    screen.getByRole("radio", { name: "Gamma" }).focus();
    await userEvent.keyboard("{Home}");
    expect(onChange).toHaveBeenLastCalledWith("a");
  });

  it("clicking the already-selected option does not call onChange", async () => {
    const onChange = vi.fn();
    render(
      <Segmented value="percent_of_purchase" onChange={onChange}
        options={[...OPTIONS]} ariaLabel="Commission type" />,
    );
    await userEvent.click(screen.getByRole("radio", { name: "% of Purchase" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  describe("disabled", () => {
    it("does not call onChange on click when disabled", async () => {
      const onChange = vi.fn();
      render(
        <Segmented value="percent_of_purchase" onChange={onChange} disabled
          options={[...OPTIONS]} ariaLabel="Commission type" />,
      );
      await userEvent.click(screen.getByRole("radio", { name: "Fixed RM" }));
      expect(onChange).not.toHaveBeenCalled();
    });

    it("does not call onChange on keyboard arrow when disabled", async () => {
      const onChange = vi.fn();
      render(
        <Segmented value="percent_of_purchase" onChange={onChange} disabled
          options={[...OPTIONS]} ariaLabel="Commission type" />,
      );
      const first = screen.getByRole("radio", { name: "% of Purchase" });
      first.focus();
      await userEvent.keyboard("{ArrowRight}");
      expect(onChange).not.toHaveBeenCalled();
    });

    it("marks each option with aria-disabled=true when disabled", () => {
      render(
        <Segmented value="percent_of_purchase" onChange={() => {}} disabled
          options={[...OPTIONS]} ariaLabel="Commission type" />,
      );
      for (const opt of OPTIONS) {
        expect(screen.getByRole("radio", { name: opt.label })).toHaveAttribute(
          "aria-disabled",
          "true",
        );
      }
    });
  });
});
