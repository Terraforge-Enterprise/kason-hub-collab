import { describe, it, expect } from "vitest";
import { ClaimError, isClaimError } from "../claim-errors";

const ruleCKey = {
  propertyId: "11111111-1111-4111-8111-111111111111",
  unitCodeLower: "a-08-02",
  roomTypeLower: "master",
  moveInDate: "2026-04-20",
};

describe("ClaimError", () => {
  it("carries a stable code and a message", () => {
    const err = new ClaimError("rule_c_sum_exceeded", {
      message: "Available max: 30.00%",
      availableMax: "30.00",
      existingPct: "0.00",
      proposedPct: "0.00",
      totalPct: "0.00",
      key: ruleCKey,
    });
    expect(err.code).toBe("rule_c_sum_exceeded");
    expect(err.message).toBe("Available max: 30.00%");
    expect((err.data as { availableMax: string }).availableMax).toBe("30.00");
  });

  it("is detectable via isClaimError() across realms", () => {
    const err = new ClaimError("validation", { message: "Bad input" });
    expect(isClaimError(err)).toBe(true);
    expect(isClaimError(new Error("plain"))).toBe(false);
    expect(isClaimError(null)).toBe(false);
  });

  it("isClaimError narrows the type", () => {
    const e: unknown = new ClaimError("not_found", { message: "gone" });
    if (isClaimError(e)) {
      expect(e.code).toBe("not_found");
    }
  });

  it("rejects wrong payload pairings at the type level", () => {
    // @ts-expect-error wrong payload for code — rule_a_duplicate needs keyIndex, not priorClaimNumber
    new ClaimError("rule_a_duplicate", { message: "x", priorClaimNumber: "y" });
  });
});

describe("toResponseBody", () => {
  it("flattens data into error and does not duplicate message", () => {
    const err = new ClaimError("rule_c_sum_exceeded", {
      message: "exceed",
      availableMax: "30.00",
      existingPct: "0.00",
      proposedPct: "0.00",
      totalPct: "0.00",
      key: ruleCKey,
    });
    const body = err.toResponseBody();
    expect(body).toEqual({
      error: {
        code: "rule_c_sum_exceeded",
        message: "exceed",
        availableMax: "30.00",
        existingPct: "0.00",
        proposedPct: "0.00",
        totalPct: "0.00",
        key: ruleCKey,
      },
    });
    // Make sure the brand symbol doesn't leak via spread
    expect(Object.getOwnPropertySymbols(body.error)).toHaveLength(0);
  });

  it("carries rule_a payload", () => {
    const err = new ClaimError("rule_a_duplicate", { message: "dup", keyIndex: 2 });
    expect(err.toResponseBody()).toEqual({
      error: { code: "rule_a_duplicate", message: "dup", keyIndex: 2 },
    });
  });

  it("serializes bare-message codes without extra fields", () => {
    const err = new ClaimError("not_found", { message: "nope" });
    expect(err.toResponseBody()).toEqual({
      error: { code: "not_found", message: "nope" },
    });
  });
});
