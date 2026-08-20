import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { UnitChip, unitInitial, unitTone } from "../unit-chip";

describe("unitInitial", () => {
  it("takes the block letter before the first separator", () => {
    expect(unitInitial("A-08-02")).toBe("A");
    expect(unitInitial("B15")).toBe("B");
    expect(unitInitial("c-1")).toBe("C");
  });
  it("falls back to # for an empty code", () => {
    expect(unitInitial("")).toBe("#");
  });
});

describe("unitTone", () => {
  it("is deterministic — same property always maps to the same tone", () => {
    expect(unitTone("Seri Kembangan Heights")).toBe(unitTone("Seri Kembangan Heights"));
  });
  it("returns a non-empty class string", () => {
    expect(unitTone("Vista Residence").length).toBeGreaterThan(0);
  });
});

describe("UnitChip", () => {
  it("renders the block-letter circle plus 'code · property' text", () => {
    render(<UnitChip unit={{ unitCode: "A-08-02", propertyName: "Seri Kembangan Heights" }} />);
    expect(screen.getByText("A")).toBeInTheDocument();
    expect(screen.getByText("A-08-02 · Seri Kembangan Heights")).toBeInTheDocument();
  });
});
