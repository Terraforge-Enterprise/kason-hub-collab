import { describe, it, expect } from "vitest";
import { TICKET_CATEGORIES, normalizeCategory, normalizeCategoryAgainst } from "../ticket-categories";

describe("TICKET_CATEGORIES", () => {
  it("has Other last and includes Lighting distinct from Electrical", () => {
    expect(TICKET_CATEGORIES[TICKET_CATEGORIES.length - 1]).toBe("Other");
    expect(TICKET_CATEGORIES).toContain("Lighting");
    expect(TICKET_CATEGORIES).toContain("Electrical");
  });

  it("has exactly 13 entries and all are unique", () => {
    expect(TICKET_CATEGORIES).toHaveLength(13);
    expect(new Set(TICKET_CATEGORIES).size).toBe(13);
  });
});

describe("normalizeCategory", () => {
  it("maps exact + case-insensitive + trimmed to canonical with isMapped:true", () => {
    expect(normalizeCategory("Aircond/HVAC")).toEqual({ canonical: "Aircond/HVAC", isMapped: true });
    expect(normalizeCategory("aircond/hvac")).toEqual({ canonical: "Aircond/HVAC", isMapped: true });
    expect(normalizeCategory("  Aircond/HVAC  ")).toEqual({ canonical: "Aircond/HVAC", isMapped: true });
  });
  it("routes unmapped/empty/null to Other with isMapped:false", () => {
    expect(normalizeCategory("random text")).toEqual({ canonical: "Other", isMapped: false });
    expect(normalizeCategory("")).toEqual({ canonical: "Other", isMapped: false });
    expect(normalizeCategory(null)).toEqual({ canonical: "Other", isMapped: false });
  });
  it("treats an explicit canonical 'Other' as mapped", () => {
    expect(normalizeCategory("Other")).toEqual({ canonical: "Other", isMapped: true });
  });
});

describe("normalizeCategoryAgainst", () => {
  const names = ["Plumbing", "Electricity", "Aircond/HVAC"];
  it("maps a managed name (case-insensitive, trimmed) to its canonical casing", () => {
    expect(normalizeCategoryAgainst("electricity", names)).toEqual({ canonical: "Electricity", isMapped: true });
    expect(normalizeCategoryAgainst("  Plumbing  ", names)).toEqual({ canonical: "Plumbing", isMapped: true });
  });
  it("routes a name NOT in the list to Other/unmapped (incl. hardcoded near-misses)", () => {
    expect(normalizeCategoryAgainst("Electrical", names)).toEqual({ canonical: "Other", isMapped: false });
    expect(normalizeCategoryAgainst("TEST", names)).toEqual({ canonical: "Other", isMapped: false });
  });
  it("treats empty/null as unmapped Other, explicit Other as mapped", () => {
    expect(normalizeCategoryAgainst("", names)).toEqual({ canonical: "Other", isMapped: false });
    expect(normalizeCategoryAgainst(null, names)).toEqual({ canonical: "Other", isMapped: false });
    expect(normalizeCategoryAgainst("other", names)).toEqual({ canonical: "Other", isMapped: true });
  });
});
