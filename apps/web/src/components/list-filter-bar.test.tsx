import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import { ListFilterBar } from "./list-filter-bar";

// ListFilterState requires `order: "asc" | "desc"` in addition to search/sort/from/to/extras.
const baseValue = {
  search: "",
  sort: "",
  order: "asc" as const,
  from: undefined,
  to: undefined,
  extras: {},
};

describe("ListFilterBar", () => {
  test("renders search input", () => {
    render(
      <ListFilterBar
        value={baseValue}
        onChange={() => {}}
        searchPlaceholder="Search things"
      />
    );
    expect(screen.getByPlaceholderText("Search things")).toBeInTheDocument();
  });

  test("debounces search input before calling onChange", async () => {
    const onChange = vi.fn();
    render(
      <ListFilterBar
        value={baseValue}
        onChange={onChange}
      />
    );
    await userEvent.type(screen.getByRole("textbox"), "abc");
    // Debounce is 300ms — the call should not have fired yet.
    expect(onChange).not.toHaveBeenCalled();
  });
});
