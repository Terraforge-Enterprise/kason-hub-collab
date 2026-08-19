import { describe, expect, it } from "vitest";
import { normalizeIc } from "../normalize-ic";

// MUST mirror the Party.idNumberNormalized generated column exactly:
//   upper(regexp_replace(coalesce("idNumber", ''), '[^A-Za-z0-9]', '', 'g'))
// See normalize-ic-column.integration.test.ts for the SQL<->TS parity proof.
describe("normalizeIc", () => {
  it("strips separators and uppercases", () => {
    expect(normalizeIc("901010-14-5581")).toBe("901010145581");
  });

  it("nullish -> empty string", () => {
    expect(normalizeIc(null)).toBe("");
    expect(normalizeIc(undefined)).toBe("");
  });

  it("uppercases lowercase passport letters", () => {
    expect(normalizeIc("a1234567b")).toBe("A1234567B");
  });

  it("empty string stays empty", () => {
    expect(normalizeIc("")).toBe("");
  });

  it("whitespace/separator-only input collapses to empty", () => {
    expect(normalizeIc("  --  ")).toBe("");
  });

  it("strips non-ASCII characters (parity with Postgres regexp_replace, which also excludes them from [A-Za-z0-9])", () => {
    expect(normalizeIc("护照a1")).toBe("A1");
  });

  it("strips Latin-1 supplement letters like sz-ligature (no locale-specific uppercasing, e.g. ss-expansion, on either side)", () => {
    expect(normalizeIc("Straße-1")).toBe("STRAE1");
  });
});
