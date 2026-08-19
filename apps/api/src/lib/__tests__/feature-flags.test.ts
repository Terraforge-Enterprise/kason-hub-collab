// apps/api/src/lib/__tests__/feature-flags.test.ts
import { afterEach, describe, expect, it } from "vitest";
import { isPhase2FlagEnabled, isLettingCommissionEnabled } from "../feature-flags";

describe("isPhase2FlagEnabled", () => {
  afterEach(() => { delete process.env.ENABLE_PHASE2_METER; });

  it("defaults OFF when unset", () => {
    expect(isPhase2FlagEnabled("ENABLE_PHASE2_METER")).toBe(false);
  });

  it('on for "true" and "1"', () => {
    process.env.ENABLE_PHASE2_METER = "true";
    expect(isPhase2FlagEnabled("ENABLE_PHASE2_METER")).toBe(true);
    process.env.ENABLE_PHASE2_METER = "1";
    expect(isPhase2FlagEnabled("ENABLE_PHASE2_METER")).toBe(true);
  });

  it('off for anything else ("false", "0", "yes")', () => {
    for (const v of ["false", "0", "yes", ""]) {
      process.env.ENABLE_PHASE2_METER = v;
      expect(isPhase2FlagEnabled("ENABLE_PHASE2_METER")).toBe(false);
    }
  });
});

describe("isLettingCommissionEnabled (default ON, opt-OUT kill switch)", () => {
  afterEach(() => { delete process.env.ENABLE_LETTING_COMMISSION; });

  it("B40: defaults ON when unset (ship live)", () => {
    delete process.env.ENABLE_LETTING_COMMISSION;
    expect(isLettingCommissionEnabled()).toBe(true);
  });

  it("stays ON for explicit '1' / 'true'", () => {
    for (const v of ["1", "true"]) {
      process.env.ENABLE_LETTING_COMMISSION = v;
      expect(isLettingCommissionEnabled()).toBe(true);
    }
  });

  it("kill switch: OFF only for explicit '0' / 'false'", () => {
    for (const v of ["0", "false"]) {
      process.env.ENABLE_LETTING_COMMISSION = v;
      expect(isLettingCommissionEnabled()).toBe(false);
    }
  });

  it("any other value fails safe to ON", () => {
    process.env.ENABLE_LETTING_COMMISSION = "yes";
    expect(isLettingCommissionEnabled()).toBe(true);
  });
});
