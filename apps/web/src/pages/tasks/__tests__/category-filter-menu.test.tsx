import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CategoryFilterMenu } from "../category-filter-menu";
import { UNCATEGORIZED } from "../task-filters";

describe("CategoryFilterMenu", () => {
  it("labels the trigger by selection count", () => {
    const { rerender } = render(
      <CategoryFilterMenu value={[]} onChange={vi.fn()} options={["Plumbing", "Electrical"]} />,
    );
    expect(screen.getByLabelText("Category filter")).toHaveTextContent("All categories");
    rerender(<CategoryFilterMenu value={["Plumbing"]} onChange={vi.fn()} options={["Plumbing", "Electrical"]} />);
    expect(screen.getByLabelText("Category filter")).toHaveTextContent("Plumbing");
    rerender(
      <CategoryFilterMenu value={["Plumbing", "Electrical"]} onChange={vi.fn()} options={["Plumbing", "Electrical"]} />,
    );
    expect(screen.getByLabelText("Category filter")).toHaveTextContent("2 categories");
  });

  it("lists active options + an Uncategorized item and checks selected ones", () => {
    render(
      <CategoryFilterMenu value={["Plumbing"]} onChange={vi.fn()} options={["Plumbing", "Electrical"]} />,
    );
    fireEvent.click(screen.getByLabelText("Category filter"));
    expect(screen.getByRole("menuitemcheckbox", { name: "Plumbing" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemcheckbox", { name: "Electrical" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("menuitemcheckbox", { name: "Uncategorized" })).toBeInTheDocument();
  });

  it("ticking an option adds it to the value", () => {
    const onChange = vi.fn();
    render(<CategoryFilterMenu value={[]} onChange={onChange} options={["Plumbing", "Electrical"]} />);
    fireEvent.click(screen.getByLabelText("Category filter"));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Electrical" }));
    expect(onChange).toHaveBeenCalledWith(["Electrical"]);
  });

  it("un-ticking a selected option removes it", () => {
    const onChange = vi.fn();
    render(<CategoryFilterMenu value={["Plumbing"]} onChange={onChange} options={["Plumbing"]} />);
    fireEvent.click(screen.getByLabelText("Category filter"));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Plumbing" }));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("ticking Uncategorized adds the sentinel", () => {
    const onChange = vi.fn();
    render(<CategoryFilterMenu value={[]} onChange={onChange} options={["Plumbing"]} />);
    fireEvent.click(screen.getByLabelText("Category filter"));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Uncategorized" }));
    expect(onChange).toHaveBeenCalledWith([UNCATEGORIZED]);
  });
});
