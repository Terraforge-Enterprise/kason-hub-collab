import { describe, it, expect } from "vitest";
import {
  chargeDisplayStatus,
  ownerCounterpartyWhere,
  OWNER_FALLBACK_CHARGE_TYPES,
  chargeTrack,
  chargeCategoryLabel,
} from "../charge-classify";
import { OWNER_CHARGE_TYPES } from "@kason/shared";

describe("chargeDisplayStatus", () => {
  it("relabels a draft owner_statement child as on_statement", () => {
    expect(
      chargeDisplayStatus({ status: "draft", invoice: { invoiceType: "owner_statement" } }),
    ).toBe("on_statement");
  });
  it("keeps a draft tenant_rental (M5) child as draft", () => {
    expect(
      chargeDisplayStatus({ status: "draft", invoice: { invoiceType: "tenant_rental" } }),
    ).toBe("draft");
  });
  it("void stays void even on an owner_statement invoice", () => {
    expect(
      chargeDisplayStatus({ status: "void", invoice: { invoiceType: "owner_statement" } }),
    ).toBe("void");
  });
  it("credited stays credited even on an owner_statement invoice", () => {
    expect(
      chargeDisplayStatus({ status: "credited", invoice: { invoiceType: "owner_statement" } }),
    ).toBe("credited");
  });
  it("passes through statuses for unattached charges", () => {
    expect(chargeDisplayStatus({ status: "posted", invoice: null })).toBe("posted");
    expect(chargeDisplayStatus({ status: "credited", invoice: null })).toBe("credited");
  });
});

describe("ownerCounterpartyWhere", () => {
  it("selects owner_income categories OR null-category fallback types", () => {
    expect(ownerCounterpartyWhere()).toEqual({
      OR: [
        { category: { family: "owner_income" } },
        { categoryId: null, chargeType: { in: [...OWNER_FALLBACK_CHARGE_TYPES] } },
      ],
    });
  });
  it("fallback types are derived from the authoritative OWNER_CHARGE_TYPES enum", () => {
    expect(OWNER_FALLBACK_CHARGE_TYPES).toEqual(OWNER_CHARGE_TYPES);
  });
  it("fallback types include all live owner generators and SST/pass-through expenses", () => {
    // Live generators: management_fee, cleaning, tnb, water, wifi
    expect(OWNER_FALLBACK_CHARGE_TYPES).toContain("management_fee");
    expect(OWNER_FALLBACK_CHARGE_TYPES).toContain("cleaning");
    expect(OWNER_FALLBACK_CHARGE_TYPES).toContain("tnb");
    expect(OWNER_FALLBACK_CHARGE_TYPES).toContain("wifi");
    expect(OWNER_FALLBACK_CHARGE_TYPES).toContain("water");
    // Pass-through expenses from the enum
    expect(OWNER_FALLBACK_CHARGE_TYPES).toContain("sewerage");
  });
  it("fallback types do NOT contain dead entries", () => {
    expect(OWNER_FALLBACK_CHARGE_TYPES).not.toContain("indah");
    expect(OWNER_FALLBACK_CHARGE_TYPES).not.toContain("sinking_fund");
    expect(OWNER_FALLBACK_CHARGE_TYPES).not.toContain("misc");
  });
});

const trackBase = { categoryId: null, category: null as { family: string } | null, chargeType: "rental", invoice: null as { invoiceType: string } | null };

describe("chargeTrack", () => {
  it("pay_back_landlord family (not on statement) → pass_through", () => {
    expect(chargeTrack({ ...trackBase, categoryId: "c", category: { family: "pay_back_landlord" } })).toBe("pass_through");
  });
  it("owner_income family → owner", () => {
    expect(chargeTrack({ ...trackBase, categoryId: "c", category: { family: "owner_income" } })).toBe("owner");
  });
  it("tenant_income family → tenant_fees", () => {
    expect(chargeTrack({ ...trackBase, categoryId: "c", category: { family: "tenant_income" } })).toBe("tenant_fees");
  });
  it("owner_statement invoice wins over pay_back_landlord family", () => {
    expect(chargeTrack({ ...trackBase, categoryId: "c", category: { family: "pay_back_landlord" }, invoice: { invoiceType: "owner_statement" } })).toBe("owner");
  });
  it("null category, chargeType 'utility' → pass_through (∉ owner fallback)", () => {
    expect(chargeTrack({ ...trackBase, chargeType: "utility" })).toBe("pass_through");
  });
  it("null category, chargeType 'tnb' → owner (∈ owner fallback)", () => {
    expect(chargeTrack({ ...trackBase, chargeType: "tnb" })).toBe("owner");
  });
});

describe("chargeCategoryLabel", () => {
  it("uses category.name when present", () => {
    expect(chargeCategoryLabel({ category: { name: "Management fee" }, chargeType: "management_fee" })).toBe("Management fee");
  });
  it("maps chargeType 'tnb' → 'TNB electricity' (not 'Tnb')", () => {
    expect(chargeCategoryLabel({ category: null, chargeType: "tnb" })).toBe("TNB electricity");
  });
  it("humanizes an unmapped chargeType, never empty/raw slug", () => {
    expect(chargeCategoryLabel({ category: null, chargeType: "foo_bar" })).toBe("Foo bar");
  });
});
