import { describe, expect, it } from "vitest";
import { centsToString, toCents } from "../money-cents";

describe("toCents / centsToString — negative-amount round-trip (Task 6 Part A)", () => {
  it("parses a negative 2dp string to negative cents, round-tripping back through centsToString", () => {
    expect(toCents("-60.00")).toBe(-6000);
    expect(centsToString(-6000)).toBe("-60.00");
  });

  it("normalises a negative-zero amount to plain +0, never -0 (Object.is-sensitive)", () => {
    // toBe uses Object.is — Object.is(-0, 0) is false, so a naive sign-then-add
    // implementation that returns -0 here would fail this exact assertion.
    expect(toCents("-0.00")).toBe(0);
    expect(Object.is(toCents("-0.00"), -0)).toBe(false);
  });

  // Sign-then-magnitude regression pin: a naive "peel the sign, add whole*100 to
  // frac" done in the WRONG order (applying the sign to `whole` alone instead of
  // to the combined total) silently corrupts any negative amount whose fractional
  // part is non-zero — e.g. "-60.01" would compute -6000+1=-5999 instead of
  // -6001, and "-0.99" would sign-flip entirely to +99 instead of -99. Both
  // pinned exactly so a future refactor can't reintroduce that bug unnoticed.
  it("computes the correct magnitude for negative amounts with a non-zero fractional part (sign-then-magnitude, not sign-then-whole)", () => {
    expect(toCents("-60.01")).toBe(-6001);
    expect(toCents("-0.99")).toBe(-99);
  });

  // Regression pins below: same observable outcome (throw) both BEFORE and AFTER
  // the negative-amount widening — these do not exercise a behavioral delta (no
  // RED phase), they guard against the widened regex ALSO accidentally loosening
  // the max-2dp / numeric-only constraints.
  it("still rejects a negative amount with more than 2 decimal places", () => {
    expect(() => toCents("-60.005")).toThrow(/invalid money amount/);
  });

  it("still rejects non-numeric garbage, including a bare sign with no digits", () => {
    expect(() => toCents("-abc")).toThrow(/invalid money amount/);
    expect(() => toCents("-")).toThrow(/invalid money amount/);
    expect(() => toCents("--60.00")).toThrow(/invalid money amount/);
  });

  it("still parses positive amounts unchanged (superset — no regression)", () => {
    expect(toCents("200.16")).toBe(20016);
    expect(toCents(1500)).toBe(150000);
  });
});
