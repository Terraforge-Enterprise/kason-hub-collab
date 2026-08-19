import { describe, it, expect } from "vitest";
import {
  createTierMappingSchema,
  createClaimSchema,
  saveDraftSchema,
  createRoomTypeSchema,
  updateRoomTypeSchema,
  commissionClaimItemSubmitSchema,
} from "../schemas/commissions";

describe("createTierMappingSchema — valid claim types", () => {
  it("accepts tenant_listing_portion (restored per business case)", () => {
    const r = createTierMappingSchema.safeParse({
      claimType: "tenant_listing_portion",
      agentLevel: "new_agent",
      percentage: "70",
    });
    expect(r.success).toBe(true);
  });

  it("rejects an unknown claim type", () => {
    const r = createTierMappingSchema.safeParse({
      claimType: "something_bogus",
      agentLevel: "new_agent",
      percentage: "70",
    });
    expect(r.success).toBe(false);
  });
});

describe("createClaimSchema", () => {
  const validItem = {
    propertyId: "11111111-1111-4111-8111-111111111111",
    condoName: "Seri Kembangan Heights",
    unitCode: "A-08-02",
    roomType: "Master",
    tenantName: "T",
    salesDate: "2026-04-19",
    moveInDate: "2026-04-20",
    moveOutDate: "2027-04-30",
    monthlyRental: "1000.00",
    commissionPercentage: "50",
    tenancyChargesByAgent: "500",
    tenancyChargesByKaen: "216",
  };

  it("rejects an item without propertyId", () => {
    const { propertyId: _p, ...withoutFk } = validItem;
    const result = createClaimSchema.safeParse({
      claimType: "tenant_portion",
      items: [withoutFk],
    });
    expect(result.success).toBe(false);
  });

  it("accepts an item with a valid propertyId", () => {
    const result = createClaimSchema.safeParse({
      claimType: "tenant_portion",
      items: [validItem],
    });
    expect(result.success).toBe(true);
  });
});

describe("createClaimSchema — remark + claim type", () => {
  const baseItem = {
    propertyId: "11111111-1111-4111-8111-111111111111",
    condoName: "X",
    unitCode: "A-1",
    roomType: "Master",
    tenantName: "T",
    salesDate: "2026-04-20",
    moveInDate: "2026-04-21",
    moveOutDate: "2027-04-30",
    monthlyRental: "1000.00",
    commissionPercentage: "50",
    tenancyChargesByAgent: "500",
    tenancyChargesByKaen: "216",
  };

  it("accepts the tenant_listing_portion value (restored per business case)", () => {
    const result = createClaimSchema.safeParse({
      claimType: "tenant_listing_portion",
      items: [baseItem],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a remark up to 1000 chars", () => {
    const r = createClaimSchema.safeParse({
      claimType: "tenant_portion",
      items: [{ ...baseItem, remark: "x".repeat(1000) }],
    });
    expect(r.success).toBe(true);
  });

  it("rejects a remark over 1000 chars", () => {
    const r = createClaimSchema.safeParse({
      claimType: "tenant_portion",
      items: [{ ...baseItem, remark: "x".repeat(1001) }],
    });
    expect(r.success).toBe(false);
  });

  it("trims whitespace and normalises empty remark to undefined", () => {
    const r = createClaimSchema.safeParse({
      claimType: "tenant_portion",
      items: [{ ...baseItem, remark: "   " }],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.items[0].remark).toBeUndefined();
    }
  });
});

describe("createRoomTypeSchema (global — no propertyId)", () => {
  it("rejects when propertyId is supplied", () => {
    const r = createRoomTypeSchema.safeParse({
      propertyId: "11111111-1111-4111-8111-111111111111",
      name: "Master",
    });
    expect(r.success).toBe(false);
  });

  it("accepts { name, sortOrder?, isActive? }", () => {
    const r = createRoomTypeSchema.safeParse({
      name: "Master",
      sortOrder: 2,
      isActive: true,
    });
    expect(r.success).toBe(true);
  });

  it("rejects empty name", () => {
    const r = createRoomTypeSchema.safeParse({ name: "" });
    expect(r.success).toBe(false);
  });
});

describe("updateRoomTypeSchema — accepts sortOrder", () => {
  it("accepts sortOrder", () => {
    const r = updateRoomTypeSchema.safeParse({ sortOrder: 5 });
    expect(r.success).toBe(true);
  });
});

describe("createClaimSchema — tenancyChargesByKaen money format + claimType gate", () => {
  const baseItem = {
    propertyId: "11111111-1111-4111-8111-111111111111",
    condoName: "X",
    unitCode: "A-1",
    roomType: "Master",
    tenantName: "T",
    salesDate: "2026-04-20",
    moveInDate: "2026-04-21",
    moveOutDate: "2027-04-30",
    monthlyRental: "1000.00",
    commissionPercentage: "50",
    tenancyChargesByAgent: "500",
    tenancyChargesByKaen: "216",
  };

  it("accepts any positive money value for tenancyChargesByKaen (server validates against TaTier)", () => {
    const out = createClaimSchema.safeParse({
      claimType: "tenant_portion",
      items: [{ ...baseItem, tenancyChargesByKaen: "250.00" }],
    });
    expect(out.success).toBe(true);
  });

  it("allows TA fields on listing_portion claims", () => {
    const out = createClaimSchema.safeParse({
      claimType: "listing_portion",
      items: [{ ...baseItem, tenancyChargesByAgent: "300", tenancyChargesByKaen: "216" }],
    });
    expect(out.success).toBe(true);
  });

  it("accepts tenancyChargesByKaen=0 on listing_portion (passive income)", () => {
    const out = createClaimSchema.safeParse({
      claimType: "listing_portion",
      items: [{ ...baseItem, tenancyChargesByAgent: "0", tenancyChargesByKaen: "0" }],
    });
    expect(out.success).toBe(true);
  });

  it("rejects tenancyChargesByKaen=0 on tenant_portion (must be > 0)", () => {
    const out = createClaimSchema.safeParse({
      claimType: "tenant_portion",
      items: [{ ...baseItem, tenancyChargesByKaen: "0" }],
    });
    expect(out.success).toBe(false);
    if (!out.success) {
      const issue = out.error.issues.find(
        (i) => i.path.join(".") === "items.0.tenancyChargesByKaen",
      );
      expect(issue?.message).toBe("Must be > 0");
    }
  });

  it("rejects tenancyChargesByKaen=0 on tenant_listing_portion", () => {
    const out = createClaimSchema.safeParse({
      claimType: "tenant_listing_portion",
      items: [{ ...baseItem, tenancyChargesByKaen: "0" }],
    });
    expect(out.success).toBe(false);
  });

  it("allows tenant_listing_portion to populate TA", () => {
    const out = createClaimSchema.safeParse({
      claimType: "tenant_listing_portion",
      items: [{ ...baseItem, tenancyChargesByAgent: "300", tenancyChargesByKaen: "216" }],
    });
    expect(out.success).toBe(true);
  });

  it("does NOT accept isCobroke from client (server-derived)", () => {
    const out = createClaimSchema.safeParse({
      claimType: "tenant_portion",
      items: [baseItem],
      isCobroke: true,
    } as any);
    if (out.success) expect((out.data as any).isCobroke).toBeUndefined();
  });
});

describe("saveDraftSchema — listing_portion accepts TA fields", () => {
  const draftItem = {
    propertyId: "11111111-1111-4111-8111-111111111111",
    tenancyChargesByAgent: "300",
    tenancyChargesByKaen: "216",
  };

  it("allows TA fields on listing_portion draft", () => {
    const out = saveDraftSchema.safeParse({
      claimType: "listing_portion",
      items: [draftItem],
    });
    expect(out.success).toBe(true);
  });

  it("allows listing_portion draft with zero/absent TA values", () => {
    const out = saveDraftSchema.safeParse({
      claimType: "listing_portion",
      items: [{ propertyId: "11111111-1111-4111-8111-111111111111" }],
    });
    expect(out.success).toBe(true);
  });
});

describe("TA share + cobroke intent", () => {
  const baseItem = {
    propertyId: "11111111-1111-4111-8111-111111111111",
    condoName: "X",
    unitCode: "A-1",
    roomType: "Master",
    tenantName: "T",
    salesDate: "2026-04-20",
    moveInDate: "2026-04-21",
    moveOutDate: "2027-04-30",
    monthlyRental: "1000.00",
    commissionPercentage: "50",
    tenancyChargesByAgent: "500",
    tenancyChargesByKaen: "216",
  };

  it("accepts cobroke item with taSharePercent", () => {
    const out = createClaimSchema.safeParse({
      claimType: "tenant_portion",
      items: [{ ...baseItem, hasCobrokeIntent: true, commissionPercentage: "70", taSharePercent: "50" }],
    });
    expect(out.success).toBe(true);
  });

  it("rejects cobroke item without taSharePercent", () => {
    const out = createClaimSchema.safeParse({
      claimType: "tenant_portion",
      items: [{ ...baseItem, hasCobrokeIntent: true, commissionPercentage: "70" }],
    });
    expect(out.success).toBe(false);
    if (!out.success) {
      expect(out.error.issues.some((i) => i.message.includes("TA share"))).toBe(true);
    }
  });

  it("allows taSharePercent on listing_portion when cobroke is checked", () => {
    const out = createClaimSchema.safeParse({
      claimType: "listing_portion",
      items: [{ ...baseItem, hasCobrokeIntent: true, taSharePercent: "50" }],
    });
    expect(out.success).toBe(true);
  });

  it("defaults hasCobrokeIntent=false when omitted", () => {
    const out = createClaimSchema.safeParse({
      claimType: "tenant_portion",
      items: [{ ...baseItem }],
    });
    expect(out.success).toBe(true);
    if (out.success) expect(out.data.items[0].hasCobrokeIntent).toBe(false);
  });
});

describe("createClaimSchema — salesDate vs moveInDate ordering", () => {
  const base = {
    propertyId: "11111111-1111-4111-8111-111111111111",
    condoName: "X",
    unitCode: "A-1",
    roomType: "Master",
    tenantName: "T",
    monthlyRental: "1000.00",
    commissionPercentage: "50",
    tenancyChargesByAgent: "500",
    tenancyChargesByKaen: "216",
    moveOutDate: "2027-04-13",
  };

  it("rejects salesDate after moveInDate", () => {
    const out = createClaimSchema.safeParse({
      claimType: "tenant_portion",
      items: [{ ...base, salesDate: "2026-04-20", moveInDate: "2026-04-14" }],
    });
    expect(out.success).toBe(false);
    if (!out.success) {
      expect(
        out.error.issues.some(
          (i) => i.path.join(".") === "items.0.salesDate" && /move-in/i.test(i.message),
        ),
      ).toBe(true);
    }
  });

  it("accepts salesDate equal to moveInDate", () => {
    const out = createClaimSchema.safeParse({
      claimType: "tenant_portion",
      items: [{ ...base, salesDate: "2026-04-14", moveInDate: "2026-04-14" }],
    });
    expect(out.success).toBe(true);
  });

  it("accepts salesDate before moveInDate", () => {
    const out = createClaimSchema.safeParse({
      claimType: "tenant_portion",
      items: [{ ...base, salesDate: "2026-04-10", moveInDate: "2026-04-14" }],
    });
    expect(out.success).toBe(true);
  });

  it("rejects malformed salesDate not matching YYYY-MM-DD", () => {
    const out = createClaimSchema.safeParse({
      claimType: "tenant_portion",
      items: [{ ...base, salesDate: "20-04-2026", moveInDate: "2026-04-14" }],
    });
    expect(out.success).toBe(false);
  });
});

describe("Tenant profile (B1) fields", () => {
  const baseItem = {
    propertyId: "550e8400-e29b-41d4-a716-446655440000",
    condoName: "Bangsar South",
    unitCode: "A-12-01",
    roomType: "Studio",
    tenantName: "Ahmad bin Abdullah",
    salesDate: "2026-04-25",
    moveInDate: "2026-05-01",
    moveOutDate: "2027-04-30",
    monthlyRental: "1000",
    commissionPercentage: "100",
    tenancyChargesByAgent: "300",
    tenancyChargesByKaen: "216",
  };

  it("accepts an item with all 5 tenant-profile fields populated", () => {
    const out = commissionClaimItemSubmitSchema.safeParse({
      ...baseItem,
      tenantEmail: "ahmad@example.com",
      tenantPhone: "+60123456789",
      tenantLinkedinUrl: "https://www.linkedin.com/in/ahmad-abdullah/",
      tenantInstagramHandle: "ahmad_a",
      tenantJobPosition: "Software Engineer",
    });
    expect(out.success).toBe(true);
  });

  it("accepts an item with all 5 tenant-profile fields omitted (all optional)", () => {
    const out = commissionClaimItemSubmitSchema.safeParse(baseItem);
    expect(out.success).toBe(true);
  });

  it("rejects malformed tenantEmail", () => {
    const out = commissionClaimItemSubmitSchema.safeParse({ ...baseItem, tenantEmail: "not-an-email" });
    expect(out.success).toBe(false);
    if (!out.success) {
      expect(out.error.issues.some((i) => i.path.includes("tenantEmail"))).toBe(true);
    }
  });

  it("rejects tenantLinkedinUrl that is not a LinkedIn URL", () => {
    const out = commissionClaimItemSubmitSchema.safeParse({ ...baseItem, tenantLinkedinUrl: "https://twitter.com/ahmad" });
    expect(out.success).toBe(false);
  });

  it("normalizes tenantInstagramHandle by stripping a leading @", () => {
    const out = commissionClaimItemSubmitSchema.safeParse({ ...baseItem, tenantInstagramHandle: "@ahmad_a" });
    expect(out.success).toBe(true);
    if (out.success) {
      expect(out.data.tenantInstagramHandle).toBe("ahmad_a");
    }
  });
});

describe("createRoomTypeSchema — kind", () => {
  it("accepts kind=WHOLE", () => {
    const r = createRoomTypeSchema.safeParse({ name: "Studio", kind: "WHOLE" });
    expect(r.success).toBe(true);
  });
  it("accepts kind=PARTITION", () => {
    const r = createRoomTypeSchema.safeParse({ name: "Master", kind: "PARTITION" });
    expect(r.success).toBe(true);
  });
  it("rejects invalid kind", () => {
    const r = createRoomTypeSchema.safeParse({ name: "Master", kind: "other" });
    expect(r.success).toBe(false);
  });
  it("accepts missing kind (server defaults to PARTITION)", () => {
    const r = createRoomTypeSchema.safeParse({ name: "Master" });
    expect(r.success).toBe(true);
  });
});

describe("updateRoomTypeSchema — kind", () => {
  it("accepts kind change", () => {
    const r = updateRoomTypeSchema.safeParse({ kind: "WHOLE" });
    expect(r.success).toBe(true);
  });
  it("rejects invalid kind", () => {
    const r = updateRoomTypeSchema.safeParse({ kind: "other" });
    expect(r.success).toBe(false);
  });
});
