// income-row-detail.test.ts
//
// Five statement lines all reading "Shared Utility" tell an owner nothing. The
// component IS on the source Charge — bills-grid mints the description as
// "<label> <YYYYMM>" (utility-spec.ts: "Electricity (TNB)", "Water (Air Selangor)",
// "Sewerage (Indah Water)", "WiFi", "Cleaning", "Maintenance") and the meter path
// as "Aircond <YYYYMM>". The trailing period is redundant next to the statement's
// own Period column, so it is stripped for display.
import { describe, it, expect } from "vitest";
import { incomeRowDetail } from "../owner-statement-sections";

describe("incomeRowDetail", () => {
  it("names each utility component behind a Shared Utility row", () => {
    expect(incomeRowDetail("Electricity (TNB) 202607")).toBe("Electricity (TNB)");
    expect(incomeRowDetail("Water (Air Selangor) 202607")).toBe("Water (Air Selangor)");
    expect(incomeRowDetail("Sewerage (Indah Water) 202607")).toBe("Sewerage (Indah Water)");
    expect(incomeRowDetail("WiFi 202607")).toBe("WiFi");
    expect(incomeRowDetail("Cleaning 202607")).toBe("Cleaning");
    expect(incomeRowDetail("Maintenance 202607")).toBe("Maintenance");
    expect(incomeRowDetail("Aircond 202607")).toBe("Aircond");
  });

  it("keeps a description that carries no trailing period", () => {
    expect(incomeRowDetail("Electricity (TNB)")).toBe("Electricity (TNB)");
    expect(incomeRowDetail("Rent for room A")).toBe("Rent for room A");
  });

  // Only a 6-digit YYYYMM at the very end is a minted period stamp. A number that
  // happens to trail a real description must survive — truncating it would rename
  // the line the owner is reading.
  it("does not strip numbers that are part of the description", () => {
    expect(incomeRowDetail("Meter 12345")).toBe("Meter 12345");
    expect(incomeRowDetail("Unit 1234567")).toBe("Unit 1234567");
    expect(incomeRowDetail("Block 2026")).toBe("Block 2026");
  });

  it("returns null for an absent or blank description rather than an empty label", () => {
    expect(incomeRowDetail(null)).toBeNull();
    expect(incomeRowDetail("")).toBeNull();
    expect(incomeRowDetail("   ")).toBeNull();
    // A description that is ONLY a period stamp leaves nothing to show.
    expect(incomeRowDetail("202607")).toBeNull();
  });
});
