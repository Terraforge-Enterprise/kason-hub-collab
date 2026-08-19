import { describe, it, expect } from "vitest";
import { CHARGE_TYPE_TO_CATEGORY_CODE, resolveCategoryCode } from "./backfill-charge-categories";

describe("resolveCategoryCode", () => {
  it("maps the contract chargeType → category-code table exactly", () => {
    expect(CHARGE_TYPE_TO_CATEGORY_CODE).toEqual({
      rent: "rental",
      rental: "rental",
      utility: "utility_tnb",
      aircond: "aircond",
      carpark: "carpark",
      cleaning: "cleaning_tenant",
      management_fee: "management_fee",
      access_card: "access_card_replacement",
      tnb: "utility_tnb",
      wifi: "utility_wifi",
    });
  });

  it("normalizes case/whitespace and buckets unknowns into legacy_other", () => {
    expect(resolveCategoryCode("Rent ")).toBe("rental");
    expect(resolveCategoryCode("UTILITY")).toBe("utility_tnb");
    expect(resolveCategoryCode("mystery_fee")).toBe("legacy_other");
    expect(resolveCategoryCode("")).toBe("legacy_other");
  });

  it("maps observed tnb/wifi literals to utility categories instead of legacy_other", () => {
    expect(resolveCategoryCode("tnb")).toBe("utility_tnb");
    expect(resolveCategoryCode("TNB")).toBe("utility_tnb");
    expect(resolveCategoryCode("wifi")).toBe("utility_wifi");
    expect(resolveCategoryCode(" WiFi ")).toBe("utility_wifi");
  });
});
