import { describe, expect, it } from "vitest";
import { endDateBeforeRenewalStart } from "../tenancy.repository";

describe("renewal tenancy boundaries", () => {
  it("ends the previous tenancy one calendar day before the renewed tenancy starts", () => {
    expect(endDateBeforeRenewalStart(new Date("2027-08-25T00:00:00.000Z")).toISOString())
      .toBe("2027-08-24T00:00:00.000Z");
  });

  it("works across a month boundary", () => {
    expect(endDateBeforeRenewalStart(new Date("2027-09-01T00:00:00.000Z")).toISOString())
      .toBe("2027-08-31T00:00:00.000Z");
  });
});
