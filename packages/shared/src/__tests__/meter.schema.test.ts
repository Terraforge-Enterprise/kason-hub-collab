import { describe, it, expect } from "vitest";
import { createReadingSchema, updateReadingSchema } from "../schemas/meter";

describe("reading schemas — editable previousReading", () => {
  it("createReadingSchema accepts an optional previousReading", () => {
    const parsed = createReadingSchema.parse({
      unitId: "11111111-1111-4111-8111-111111111111",
      periodMonth: "2026-06-01",
      previousReading: "70.00",
      currentReading: "100.00",
    });
    expect(parsed.previousReading).toBe("70.00");
  });

  it("createReadingSchema still parses WITHOUT previousReading (back-compat)", () => {
    const parsed = createReadingSchema.parse({
      unitId: "11111111-1111-4111-8111-111111111111",
      periodMonth: "2026-06-01",
      currentReading: "100.00",
    });
    expect(parsed.previousReading).toBeUndefined();
  });

  it("updateReadingSchema accepts previousReading", () => {
    const parsed = updateReadingSchema.parse({ previousReading: "25.50" });
    expect(parsed.previousReading).toBe("25.50");
  });

  it("rejects a non-numeric previousReading", () => {
    expect(() =>
      createReadingSchema.parse({
        unitId: "11111111-1111-4111-8111-111111111111",
        periodMonth: "2026-06-01",
        previousReading: "abc",
        currentReading: "100.00",
      }),
    ).toThrow();
  });
});
