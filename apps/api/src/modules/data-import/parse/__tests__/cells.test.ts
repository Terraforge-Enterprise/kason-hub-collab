import { describe, it, expect } from "vitest";
import {
  parseRentalExpression,
  splitMultiTenant,
  parseGender,
  parseIdType,
  parseTermMonths,
  parseDateCell,
  latestCumulativeReading,
} from "../cells";

describe("parseRentalExpression", () => {
  it("splits room+carpark", () => {
    expect(parseRentalExpression("900+120")).toEqual({ room: 900, carpark: 120 });
    expect(parseRentalExpression("650+50")).toEqual({ room: 650, carpark: 50 });
  });
  it("plain rent → room only", () => {
    expect(parseRentalExpression("1000")).toEqual({ room: 1000, carpark: null });
    expect(parseRentalExpression(1100)).toEqual({ room: 1100, carpark: null });
  });
  it("blank → null room", () => {
    expect(parseRentalExpression("")).toEqual({ room: null, carpark: null });
    expect(parseRentalExpression(null)).toEqual({ room: null, carpark: null });
  });
});

describe("splitMultiTenant", () => {
  it("splits names on newline / & / slash, primary first", () => {
    expect(splitMultiTenant("Alice\nBob")).toEqual(["Alice", "Bob"]);
    expect(splitMultiTenant("Alice & Bob")).toEqual(["Alice", "Bob"]);
    expect(splitMultiTenant("Alice / Bob")).toEqual(["Alice", "Bob"]);
  });
  it("single → one element", () => {
    expect(splitMultiTenant("Alice")).toEqual(["Alice"]);
  });
  it("blank → empty array", () => {
    expect(splitMultiTenant("")).toEqual([]);
    expect(splitMultiTenant(null)).toEqual([]);
  });
});

describe("parseGender", () => {
  it("normalizes", () => {
    expect(parseGender("Male")).toBe("male");
    expect(parseGender("FEMALE")).toBe("female");
    expect(parseGender("")).toBeNull();
    expect(parseGender("n/a")).toBeNull();
  });
});

describe("parseIdType", () => {
  it("Malaysian NRIC shape → NRIC, else passport", () => {
    expect(parseIdType("880312-10-1234")).toBe("NRIC");
    expect(parseIdType("A12345678")).toBe("passport");
    expect(parseIdType("")).toBeNull();
  });
});

describe("parseTermMonths", () => {
  it("parses 1Y / 1 YEAR / 6M", () => {
    expect(parseTermMonths("1Y")).toBe(12);
    expect(parseTermMonths("1 YEAR")).toBe(12);
    expect(parseTermMonths("2Y")).toBe(24);
    expect(parseTermMonths("6M")).toBe(6);
  });
  it("renewal chain → first term only (v1)", () => {
    expect(parseTermMonths("1Y+1Y")).toBe(12);
  });
  it("blank → null", () => {
    expect(parseTermMonths("")).toBeNull();
  });
});

describe("parseDateCell", () => {
  it("passes through a Date", () => {
    const d = new Date("2025-02-01T00:00:00Z");
    expect(parseDateCell(d)?.toISOString()).toBe(d.toISOString());
  });
  it("parses ISO-ish string", () => {
    expect(parseDateCell("2025-02-01")?.getUTCFullYear()).toBe(2025);
  });
  it("blank / junk → null", () => {
    expect(parseDateCell("")).toBeNull();
    expect(parseDateCell("n/a")).toBeNull();
  });
});

describe("latestCumulativeReading", () => {
  it("returns rightmost non-empty + monotonic flag", () => {
    expect(latestCumulativeReading([null, 64, 86.6, null, 1467.1])).toEqual({
      value: 1467.1,
      monotonic: true,
    });
  });
  it("flags non-monotonic (data noise)", () => {
    expect(latestCumulativeReading([10, 5, 12])).toEqual({ value: 12, monotonic: false });
  });
  it("all empty → null", () => {
    expect(latestCumulativeReading([null, null])).toEqual({ value: null, monotonic: true });
  });
});
