import { describe, it, expect } from "vitest";
import { formatPeriodMonth, prettyEnumLabel } from "../format";

describe("prettyEnumLabel", () => {
  it("humanises the charge types the draft drawer renders", () => {
    // These were shown raw in the invoice drawer's Charges table.
    expect(prettyEnumLabel("rent")).toBe("Rent");
    expect(prettyEnumLabel("management_fee")).toBe("Management Fee");
    expect(prettyEnumLabel("letting_commission")).toBe("Letting Commission");
    expect(prettyEnumLabel("letting_commission_sst")).toBe("Letting Commission Sst");
  });
});

describe("formatPeriodMonth", () => {
  it("formats the full ISO timestamp the API sends for periodMonth", () => {
    // Was rendered raw as "2026-08-01T00:00:00.000Z" in the drawer.
    expect(formatPeriodMonth("2026-08-01T00:00:00.000Z")).toBe("Aug 2026");
  });

  it("also accepts a bare YYYY-MM", () => {
    expect(formatPeriodMonth("2026-08")).toBe("Aug 2026");
  });

  it("reads UTC so a UTC+8 viewer never sees the previous month", () => {
    // A local read of 2026-08-01T00:00Z in Malaysia is still 1 Aug, but for a
    // negative-offset viewer it would be 31 Jul → "Jul 2026". Pinned to UTC.
    expect(formatPeriodMonth("2026-08-01T00:00:00.000Z")).toBe("Aug 2026");
    expect(formatPeriodMonth("2026-01-01T00:00:00.000Z")).toBe("Jan 2026");
  });

  it("degrades safely", () => {
    expect(formatPeriodMonth(null)).toBe("—");
    expect(formatPeriodMonth("")).toBe("—");
    expect(formatPeriodMonth("not-a-date")).toBe("not-a-date");
  });
});
