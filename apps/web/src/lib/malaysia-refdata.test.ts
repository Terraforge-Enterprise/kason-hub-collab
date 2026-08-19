import { describe, expect, test } from "vitest";
import {
  INDIVIDUAL_ID_TYPES,
  NATIONALITIES,
  labelOf,
  withExistingOption,
} from "./malaysia-refdata";

describe("labelOf", () => {
  test("resolves known codes", () => {
    expect(labelOf(NATIONALITIES, "MY")).toBe("Malaysian");
  });
  test("falls back to the raw value for legacy free-text", () => {
    expect(labelOf(NATIONALITIES, "Malaysian")).toBe("Malaysian");
  });
  test("returns empty string for null", () => {
    expect(labelOf(NATIONALITIES, null)).toBe("");
  });
});

describe("withExistingOption", () => {
  test("leaves list unchanged when value is canonical", () => {
    expect(withExistingOption(INDIVIDUAL_ID_TYPES, "NRIC")).toEqual(INDIVIDUAL_ID_TYPES);
  });
  test("prepends legacy value with suffix", () => {
    const result = withExistingOption(INDIVIDUAL_ID_TYPES, "ancient-id");
    expect(result[0]).toEqual({ value: "ancient-id", label: "ancient-id (legacy)" });
  });
});
