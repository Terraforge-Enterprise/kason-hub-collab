import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Sheet, SheetContent, SheetTitle, sheetSizes, type SheetSize } from "../sheet";

const SIZES: SheetSize[] = ["sm", "md", "lg", "xl", "full"];

describe("Sheet — size tokens", () => {
  it.each(SIZES)("renders a %s drawer with the matching width class", (size) => {
    render(
      <Sheet open>
        <SheetContent size={size}>
          <SheetTitle>title</SheetTitle>
          <div>content</div>
        </SheetContent>
      </Sheet>,
    );
    const popup = screen.getByText("content").closest("[data-slot='sheet-content']");
    expect(popup).not.toBeNull();
    expect(popup!.className).toContain(sheetSizes[size]);
  });

  it("falls back to size=md (520 px) when size is omitted", () => {
    render(
      <Sheet open>
        <SheetContent>
          <SheetTitle>title</SheetTitle>
          <div>content</div>
        </SheetContent>
      </Sheet>,
    );
    const popup = screen.getByText("content").closest("[data-slot='sheet-content']");
    expect(popup!.className).toContain("md:w-[520px]");
  });

  it("does not include the legacy width when a semantic size is chosen", () => {
    render(
      <Sheet open>
        <SheetContent size="lg">
          <SheetTitle>title</SheetTitle>
          <div>content</div>
        </SheetContent>
      </Sheet>,
    );
    const popup = screen.getByText("content").closest("[data-slot='sheet-content']");
    expect(popup!.className).not.toContain("md:w-[480px]");
    expect(popup!.className).toContain("md:w-[720px]");
  });

  it("composes a caller-supplied className alongside the size token", () => {
    render(
      <Sheet open>
        <SheetContent size="md" className="overflow-y-auto">
          <SheetTitle>title</SheetTitle>
          <div>content</div>
        </SheetContent>
      </Sheet>,
    );
    const popup = screen.getByText("content").closest("[data-slot='sheet-content']");
    expect(popup!.className).toContain("md:w-[520px]");
    expect(popup!.className).toContain("overflow-y-auto");
  });
});
