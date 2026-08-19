import { describe, it, expect } from "vitest";
import { deriveStageKey, isValidStageKey, createStageSchema, STAGE_CAP } from "../renovation-stages.validation";

describe("deriveStageKey", () => {
  it("lowercases", () => expect(deriveStageKey("DEMO")).toBe("demo"));
  it("trims and replaces non-alphanumerics with _", () => {
    expect(deriveStageKey(" Wiring & Electrical ")).toBe("wiring_electrical");
    expect(deriveStageKey("Demo!!")).toBe("demo");
  });
  it("strips leading/trailing underscores", () => {
    expect(deriveStageKey("--demo--")).toBe("demo");
  });
  it("caps at 60 chars", () => {
    const long = "a".repeat(80);
    expect(deriveStageKey(long).length).toBe(60);
  });
});

describe("isValidStageKey", () => {
  it("accepts lowercased letters, digits, _, -", () => {
    expect(isValidStageKey("demo")).toBe(true);
    expect(isValidStageKey("wiring_electrical")).toBe(true);
    expect(isValidStageKey("foo-bar-1")).toBe(true);
  });
  it("rejects uppercase, spaces, special chars", () => {
    expect(isValidStageKey("Demo")).toBe(false);
    expect(isValidStageKey("foo bar")).toBe(false);
    expect(isValidStageKey("foo!")).toBe(false);
    expect(isValidStageKey("")).toBe(false);
  });
});

describe("createStageSchema", () => {
  it("accepts a minimum-valid payload", () => {
    expect(createStageSchema.safeParse({ label: "Demolition" }).success).toBe(true);
  });
  it("rejects empty label", () => {
    expect(createStageSchema.safeParse({ label: "" }).success).toBe(false);
  });
  it("rejects unknown keys (strict)", () => {
    expect(createStageSchema.safeParse({ label: "Demo", weird: 1 }).success).toBe(false);
  });
});

describe("STAGE_CAP", () => {
  it("is 25", () => expect(STAGE_CAP).toBe(25));
});
