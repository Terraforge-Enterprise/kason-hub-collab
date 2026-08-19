import { describe, it, expect } from "vitest";
import { createEmptyItem, validateItem } from "../use-claim-form";

const baseValidItem = () => ({
  ...createEmptyItem(),
  condoName: "Bangsar South",
  unitCode: "A-12-01",
  roomType: "Studio",
  tenantName: "Test Tenant",
  salesDate: "2026-04-25",
  moveInDate: "2026-05-01",
  moveOutDate: "2027-04-30",
  monthlyRental: "1000",
  tenancyChargesByAgent: "300",
  tenancyChargesByKaen: "216",
});

describe("createEmptyItem — Commission % default", () => {
  it("returns commissionPercentage: '' (no '100' default)", () => {
    const item = createEmptyItem();
    expect(item.commissionPercentage).toBe("");
  });
});

describe("validateItem — Commission % requirement", () => {
  it("rejects an item with empty Commission % using a 'required' message", () => {
    const item = baseValidItem();
    item.commissionPercentage = "";
    const errors = validateItem(item, 0);
    const commissionErr = errors.find((e) => e.field === "commissionPercentage");
    expect(commissionErr).toBeTruthy();
    expect(commissionErr!.message).toMatch(/required/i);
  });

  it("rejects whitespace-only Commission %", () => {
    const item = baseValidItem();
    item.commissionPercentage = "   ";
    const errors = validateItem(item, 0);
    expect(errors.some((e) => e.field === "commissionPercentage")).toBe(true);
  });

  it("rejects Commission % > 100 with the range message", () => {
    const item = baseValidItem();
    item.commissionPercentage = "150";
    const errors = validateItem(item, 0);
    const commissionErr = errors.find((e) => e.field === "commissionPercentage");
    expect(commissionErr).toBeTruthy();
    expect(commissionErr!.message).toMatch(/0-100/);
  });

  it("rejects Commission % < 0", () => {
    const item = baseValidItem();
    item.commissionPercentage = "-5";
    const errors = validateItem(item, 0);
    expect(errors.some((e) => e.field === "commissionPercentage")).toBe(true);
  });

  it("accepts Commission % = 100 (solo)", () => {
    const item = baseValidItem();
    item.commissionPercentage = "100";
    const errors = validateItem(item, 0);
    expect(errors.some((e) => e.field === "commissionPercentage")).toBe(false);
  });

  it("accepts Commission % = 50 (joint)", () => {
    const item = baseValidItem();
    item.commissionPercentage = "50";
    const errors = validateItem(item, 0);
    expect(errors.some((e) => e.field === "commissionPercentage")).toBe(false);
  });

  it("accepts Commission % = 70.5 (decimal share)", () => {
    const item = baseValidItem();
    item.commissionPercentage = "70.5";
    const errors = validateItem(item, 0);
    expect(errors.some((e) => e.field === "commissionPercentage")).toBe(false);
  });
});

describe("validateItem — salesDate vs moveInDate ordering", () => {
  it("rejects salesDate after moveInDate with a clear message", () => {
    const item = baseValidItem();
    item.salesDate = "2026-04-20";
    item.moveInDate = "2026-04-14";
    const errors = validateItem(item, 0);
    const dateErr = errors.find(
      (e) => e.field === "salesDate" && /move-in/i.test(e.message),
    );
    expect(dateErr).toBeTruthy();
  });

  it("accepts salesDate equal to moveInDate", () => {
    const item = baseValidItem();
    item.salesDate = "2026-04-14";
    item.moveInDate = "2026-04-14";
    const errors = validateItem(item, 0);
    expect(errors.some((e) => e.field === "salesDate")).toBe(false);
  });

  it("accepts salesDate before moveInDate", () => {
    const item = baseValidItem();
    item.salesDate = "2026-04-10";
    item.moveInDate = "2026-04-14";
    const errors = validateItem(item, 0);
    expect(errors.some((e) => e.field === "salesDate")).toBe(false);
  });

  it("does not raise the ordering error when one date is missing (uses 'required' instead)", () => {
    const item = baseValidItem();
    item.salesDate = "";
    item.moveInDate = "2026-04-14";
    const errors = validateItem(item, 0);
    const requiredErr = errors.find(
      (e) => e.field === "salesDate" && /required/i.test(e.message),
    );
    const orderingErr = errors.find(
      (e) => e.field === "salesDate" && /move-in/i.test(e.message),
    );
    expect(requiredErr).toBeTruthy();
    expect(orderingErr).toBeFalsy();
  });
});

describe("validateItem — moveOutDate", () => {
  it("rejects an item with empty moveOutDate using a 'required' message", () => {
    const item = baseValidItem();
    item.moveOutDate = "";
    const errors = validateItem(item, 0);
    const err = errors.find((e) => e.field === "moveOutDate");
    expect(err).toBeTruthy();
    expect(err!.message).toMatch(/required/i);
  });

  it("rejects moveOutDate equal to moveInDate (must be strictly after)", () => {
    const item = baseValidItem();
    item.moveInDate = "2026-05-01";
    item.moveOutDate = "2026-05-01";
    const errors = validateItem(item, 0);
    const err = errors.find(
      (e) => e.field === "moveOutDate" && /after the move-in date/i.test(e.message),
    );
    expect(err).toBeTruthy();
  });

  it("rejects moveOutDate before moveInDate", () => {
    const item = baseValidItem();
    item.moveInDate = "2026-05-01";
    item.moveOutDate = "2026-04-15";
    const errors = validateItem(item, 0);
    expect(errors.some((e) => e.field === "moveOutDate")).toBe(true);
  });

  it("accepts moveOutDate strictly after moveInDate", () => {
    const item = baseValidItem();
    item.moveInDate = "2026-05-01";
    item.moveOutDate = "2027-04-30";
    const errors = validateItem(item, 0);
    expect(errors.some((e) => e.field === "moveOutDate")).toBe(false);
  });
});

describe("validateItem — listing_portion TA fields optional", () => {
  it("rejects empty TA fields under tenant_portion (control)", () => {
    const item = baseValidItem();
    item.tenancyChargesByAgent = "";
    item.tenancyChargesByKaen = "";
    const errors = validateItem(item, 0, "tenant_portion");
    expect(errors.some((e) => e.field === "tenancyChargesByAgent")).toBe(true);
    expect(errors.some((e) => e.field === "tenancyChargesByKaen")).toBe(true);
  });

  it("accepts empty TA fields under listing_portion (passive income, no TA)", () => {
    const item = baseValidItem();
    item.tenancyChargesByAgent = "";
    item.tenancyChargesByKaen = "";
    const errors = validateItem(item, 0, "listing_portion");
    expect(errors.some((e) => e.field === "tenancyChargesByAgent")).toBe(false);
    expect(errors.some((e) => e.field === "tenancyChargesByKaen")).toBe(false);
  });

  it("still rejects empty TA fields under tenant_listing_portion", () => {
    const item = baseValidItem();
    item.tenancyChargesByAgent = "";
    item.tenancyChargesByKaen = "";
    const errors = validateItem(item, 0, "tenant_listing_portion");
    expect(errors.some((e) => e.field === "tenancyChargesByAgent")).toBe(true);
    expect(errors.some((e) => e.field === "tenancyChargesByKaen")).toBe(true);
  });
});

