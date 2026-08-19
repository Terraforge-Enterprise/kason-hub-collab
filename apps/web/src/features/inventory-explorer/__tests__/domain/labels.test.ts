import { describe, it, expect } from "vitest";
import { furnishingLabel, facingLabel, humanize } from "../../domain/labels";

describe("furnishingLabel", () => {
  it("maps known enum values to display labels", () => {
    expect(furnishingLabel("fully_furnished")).toBe("Fully furnished");
    expect(furnishingLabel("partially_furnished")).toBe("Partially furnished");
    expect(furnishingLabel("unfurnished")).toBe("Unfurnished");
  });

  it("falls back to humanize() for unknown values (no crash on enum drift)", () => {
    expect(furnishingLabel("semi_furnished")).toBe("Semi Furnished");
  });
});

describe("facingLabel", () => {
  it("maps single-letter cardinals to compass words", () => {
    expect(facingLabel("N")).toBe("North");
    expect(facingLabel("S")).toBe("South");
    expect(facingLabel("E")).toBe("East");
    expect(facingLabel("W")).toBe("West");
  });

  it("maps two-letter intercardinals", () => {
    expect(facingLabel("NE")).toBe("Northeast");
    expect(facingLabel("SW")).toBe("Southwest");
  });

  it("returns the raw value for anything else (don't humanize a cardinal)", () => {
    expect(facingLabel("XYZ")).toBe("XYZ");
  });
});

describe("humanize", () => {
  it("snake_case → Title Case", () => {
    expect(humanize("hello_world")).toBe("Hello World");
  });

  it("kebab-case → Title Case", () => {
    expect(humanize("hello-world")).toBe("Hello World");
  });

  it("lowercases interior letters", () => {
    expect(humanize("HELLO_WORLD")).toBe("Hello World");
  });
});
