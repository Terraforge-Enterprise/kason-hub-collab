import { describe, it, expect } from "vitest";
import { CHARGE_TYPE_TO_CATEGORY_CODE } from "../issue.service";

// The mint-on-post routing map (issue.service.ts): a posted charge with no explicit
// categoryId resolves its ChargeCategory by chargeType → code here. An UNMAPPED chargeType
// resolves to no category → DocumentCategoryUnresolvedError → the posting tx aborts
// (fail-closed). So a new billable chargeType MUST have an entry here.
describe("CHARGE_TYPE_TO_CATEGORY_CODE (mint-on-post routing)", () => {
  it("M-I3/B18: a letting_commission charge → letting_commission category (→ IVTEN, KAEN revenue)", () => {
    expect(CHARGE_TYPE_TO_CATEGORY_CODE.letting_commission).toBe("letting_commission");
  });
  it("regression: rent still routes to rental (→ RB rental bill)", () => {
    expect(CHARGE_TYPE_TO_CATEGORY_CODE.rent).toBe("rental");
  });
});
