import { describe, it, expect } from "vitest";
import {
  normalizeMyPhone,
  isValidMyPhone,
  formatMyPhoneDisplay,
  readPhoneAnyFormat,
} from "../phone";

describe("normalizeMyPhone", () => {
  it("normalizes various input formats to canonical 60XXXXXXXXX", () => {
    expect(normalizeMyPhone("0123456789")).toBe("60123456789");
    expect(normalizeMyPhone("+60123456789")).toBe("60123456789");
    expect(normalizeMyPhone("60123456789")).toBe("60123456789");
    expect(normalizeMyPhone("012-345 6789")).toBe("60123456789");
    expect(normalizeMyPhone("+60 12-345 6789")).toBe("60123456789");
    expect(normalizeMyPhone("  012 345 6789  ")).toBe("60123456789");
  });

  it("accepts all valid mobile prefixes", () => {
    expect(normalizeMyPhone("0102323513")).toBe("60102323513");
    expect(normalizeMyPhone("0123456789")).toBe("60123456789");
    expect(normalizeMyPhone("0193456789")).toBe("60193456789");
    expect(normalizeMyPhone("01112345678")).toBe("601112345678");
    expect(normalizeMyPhone("01512345678")).toBe("601512345678");
  });

  it("rejects landlines (FIXED_LINE)", () => {
    expect(normalizeMyPhone("0312345678")).toBeNull();
    expect(normalizeMyPhone("0412345678")).toBeNull();
  });

  it("rejects non-MY country codes", () => {
    expect(normalizeMyPhone("+12025551234")).toBeNull();
    expect(normalizeMyPhone("+447911123456")).toBeNull();
  });

  it("rejects invalid input", () => {
    expect(normalizeMyPhone("")).toBeNull();
    expect(normalizeMyPhone("abc")).toBeNull();
    expect(normalizeMyPhone("123")).toBeNull();
    expect(normalizeMyPhone("60099999999")).toBeNull();
  });

  it("is idempotent", () => {
    const inputs = ["0123456789", "+60 12-345 6789", "60123456789"];
    for (const input of inputs) {
      const once = normalizeMyPhone(input);
      const twice = once === null ? null : normalizeMyPhone(once);
      expect(twice).toBe(once);
    }
  });
});

describe("isValidMyPhone", () => {
  it("returns true for canonical valid inputs", () => {
    expect(isValidMyPhone("60123456789")).toBe(true);
    expect(isValidMyPhone("60102323513")).toBe(true);
    expect(isValidMyPhone("601112345678")).toBe(true);
  });

  it("returns false for non-canonical or invalid inputs", () => {
    expect(isValidMyPhone("+60123456789")).toBe(false);
    expect(isValidMyPhone("0123456789")).toBe(false);
    expect(isValidMyPhone("60099999999")).toBe(false);
    expect(isValidMyPhone("")).toBe(false);
    expect(isValidMyPhone("abc")).toBe(false);
  });
});

describe("formatMyPhoneDisplay", () => {
  it("formats canonical to international display", () => {
    expect(formatMyPhoneDisplay("60123456789")).toBe("+60 12-345 6789");
    expect(formatMyPhoneDisplay("60102323513")).toBe("+60 10-232 3513");
  });

  it("formats 11-digit 011/015 numbers with the hyphen after the 2-digit prefix", () => {
    // 011/015 carry an 8-digit subscriber number (canonical = 60 + 10). The
    // hyphen must sit after the "1X" prefix (2-4-4), NOT after 3 digits.
    expect(formatMyPhoneDisplay("601523456789")).toBe("+60 15-2345 6789");
    expect(formatMyPhoneDisplay("601123456789")).toBe("+60 11-2345 6789");
  });

  it("returns the input unchanged if not parseable", () => {
    expect(formatMyPhoneDisplay("invalid")).toBe("invalid");
    expect(formatMyPhoneDisplay("")).toBe("");
  });

  it("round-trips with normalizeMyPhone", () => {
    const canonical = "60123456789";
    expect(normalizeMyPhone(formatMyPhoneDisplay(canonical))).toBe(canonical);
  });

  it("returns input unchanged for parseable-but-invalid canonical (e.g. too short)", () => {
    expect(formatMyPhoneDisplay("60123")).toBe("60123");
  });
});

describe("readPhoneAnyFormat", () => {
  it("normalizes legacy +60 format", () => {
    expect(readPhoneAnyFormat("+60123456789")).toBe("60123456789");
  });
  it("returns canonical inputs unchanged", () => {
    expect(readPhoneAnyFormat("60123456789")).toBe("60123456789");
  });
  it("returns null for null/undefined/empty", () => {
    expect(readPhoneAnyFormat(null)).toBeNull();
    expect(readPhoneAnyFormat(undefined)).toBeNull();
    expect(readPhoneAnyFormat("")).toBeNull();
  });
  it("returns null for unparseable garbage", () => {
    expect(readPhoneAnyFormat("not-a-phone")).toBeNull();
  });
});
