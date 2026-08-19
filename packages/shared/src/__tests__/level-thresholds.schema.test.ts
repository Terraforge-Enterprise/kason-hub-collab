import { describe, it, expect } from "vitest";
import {
  updateLevelThresholdSchema,
  levelThresholdPreviewSchema,
  agentLevelEnum,
} from "../schemas/level-thresholds";

describe("agentLevelEnum", () => {
  it("accepts the three valid levels", () => {
    expect(agentLevelEnum.safeParse("new_agent").success).toBe(true);
    expect(agentLevelEnum.safeParse("pre_leader").success).toBe(true);
    expect(agentLevelEnum.safeParse("leader").success).toBe(true);
  });
  it("rejects unknown levels", () => {
    expect(agentLevelEnum.safeParse("superleader").success).toBe(false);
    expect(agentLevelEnum.safeParse("").success).toBe(false);
  });
});

describe("updateLevelThresholdSchema", () => {
  const base = {
    agentLevel: "pre_leader" as const,
    minCumulativeCommission: "10000",
    updatedAt: "2026-04-20T10:00:00.000Z",
  };

  it("accepts a well-formed payload", () => {
    expect(updateLevelThresholdSchema.safeParse(base).success).toBe(true);
  });

  it("accepts decimal values with 0, 1, or 2 decimal places", () => {
    for (const v of ["10000", "10000.0", "10000.50", "0.01"]) {
      expect(updateLevelThresholdSchema.safeParse({ ...base, minCumulativeCommission: v }).success).toBe(true);
    }
  });

  it("rejects 3+ decimal places", () => {
    expect(updateLevelThresholdSchema.safeParse({ ...base, minCumulativeCommission: "10000.123" }).success).toBe(false);
  });

  it("rejects negatives and non-numeric", () => {
    for (const v of ["-1", "-100.00", "abc", "", "1e5"]) {
      expect(updateLevelThresholdSchema.safeParse({ ...base, minCumulativeCommission: v }).success).toBe(false);
    }
  });

  it("rejects malformed updatedAt", () => {
    expect(updateLevelThresholdSchema.safeParse({ ...base, updatedAt: "not-a-date" }).success).toBe(false);
  });

  it("rejects unknown agentLevel", () => {
    expect(updateLevelThresholdSchema.safeParse({ ...base, agentLevel: "nope" as never }).success).toBe(false);
  });
});

describe("levelThresholdPreviewSchema", () => {
  it("accepts a well-formed payload (no updatedAt required)", () => {
    expect(levelThresholdPreviewSchema.safeParse({
      agentLevel: "leader",
      minCumulativeCommission: "25000",
    }).success).toBe(true);
  });
});
