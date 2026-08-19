import { describe, it, expect } from "vitest";
import { upsertDefaultsSchema } from "../sales-claim-defaults.validation";

describe("upsertDefaultsSchema", () => {
  it("accepts a valid 100% percent split", () => {
    const ok = upsertDefaultsSchema.safeParse({
      commissionType: "percent_of_purchase",
      commissionValue: 2,
      splits: [{ roleLabel: "Sales Commission", splitType: "percent", splitValue: 100 }],
    });
    expect(ok.success).toBe(true);
  });

  it("rejects when percent splits don't sum to 100", () => {
    const bad = upsertDefaultsSchema.safeParse({
      commissionType: "percent_of_purchase",
      commissionValue: 2,
      splits: [
        { roleLabel: "A", splitType: "percent", splitValue: 60 },
        { roleLabel: "B", splitType: "percent", splitValue: 30 },
      ],
    });
    expect(bad.success).toBe(false);
  });

  it("rejects duplicate roleLabel (case-insensitive)", () => {
    const dup = upsertDefaultsSchema.safeParse({
      commissionType: "fixed",
      commissionValue: 1000,
      splits: [
        { roleLabel: "Sales Commission", splitType: "fixed", splitValue: 500 },
        { roleLabel: "sales commission", splitType: "fixed", splitValue: 500 },
      ],
    });
    expect(dup.success).toBe(false);
  });

  it("accepts mixed percent + fixed splits without enforcing 100% sum", () => {
    const mixed = upsertDefaultsSchema.safeParse({
      commissionType: "percent_of_purchase",
      commissionValue: 2,
      splits: [
        { roleLabel: "A", splitType: "percent", splitValue: 50 },
        { roleLabel: "B", splitType: "fixed", splitValue: 1000 },
      ],
    });
    expect(mixed.success).toBe(true);
  });
});
