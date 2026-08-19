import { describe, it, expect } from "vitest";
import { createSalesEntrySchema } from "../portal.sales-entries.validation";

const baseValidPayload = {
  project: { mode: "existing" as const, id: "11111111-1111-4111-8111-111111111111" },
  unitNumber: "A-12-01",
  ownerPartyId: "22222222-2222-4222-8222-222222222222",
  salesDate: "2026-04-30T00:00:00.000Z",
  purpose: "own_stay" as const,
  purchasePrice: 500000,
  bedrooms: 3,
  bathrooms: 2,
  parkingLots: 1,
};

describe("createSalesEntrySchema", () => {
  it("accepts a minimum valid payload (own_stay, no renovation)", () => {
    expect(createSalesEntrySchema.safeParse(baseValidPayload).success).toBe(true);
  });

  it("accepts a valid payload with mode='new' project", () => {
    expect(createSalesEntrySchema.safeParse({
      ...baseValidPayload,
      project: { mode: "new", name: "Tower X", developer: "Dev Y" },
    }).success).toBe(true);
  });

  it("rejects mode='new' without required name/developer", () => {
    expect(createSalesEntrySchema.safeParse({
      ...baseValidPayload,
      project: { mode: "new", name: "", developer: "Dev" },
    }).success).toBe(false);
  });

  it("requires expectedRental when purpose='rent'", () => {
    const result = createSalesEntrySchema.safeParse({
      ...baseValidPayload,
      purpose: "rent",
    });
    expect(result.success).toBe(false);
  });

  it("accepts purpose='rent' with valid expectedRental", () => {
    const result = createSalesEntrySchema.safeParse({
      ...baseValidPayload,
      purpose: "rent",
      expectedRental: 2500,
    });
    expect(result.success).toBe(true);
  });

  it("rejects purpose='rent' with expectedRental <= 0", () => {
    const result = createSalesEntrySchema.safeParse({
      ...baseValidPayload,
      purpose: "rent",
      expectedRental: 0,
    });
    expect(result.success).toBe(false);
  });

  it("accepts an optional renovation block", () => {
    const result = createSalesEntrySchema.safeParse({
      ...baseValidPayload,
      renovation: {
        packageId: "33333333-3333-4333-8333-333333333333",
        packagePrice: 30000,
        paymentType: "full",
        splits: [
          { partyDisplayName: "X", roleLabel: "Sales Commission", splitType: "percent", splitValue: 100 },
        ],
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown top-level keys (strict)", () => {
    const result = createSalesEntrySchema.safeParse({ ...baseValidPayload, weird: 1 });
    expect(result.success).toBe(false);
  });

  it("rejects bathrooms outside 1-10 range", () => {
    expect(createSalesEntrySchema.safeParse({ ...baseValidPayload, bathrooms: 0 }).success).toBe(false);
    expect(createSalesEntrySchema.safeParse({ ...baseValidPayload, bathrooms: 11 }).success).toBe(false);
  });

  it("accepts bedrooms=-1 (Studio encoding)", () => {
    expect(createSalesEntrySchema.safeParse({ ...baseValidPayload, bedrooms: -1 }).success).toBe(true);
  });

  it("renovation.documents accept fileKey/kind/filename only (no mimeType/sizeBytes)", () => {
    // Spec aligns to RenovationClaimDocument schema which has only fileKey/kind/filename.
    const result = createSalesEntrySchema.safeParse({
      ...baseValidPayload,
      renovation: {
        packageId: "33333333-3333-4333-8333-333333333333",
        packagePrice: 30000,
        paymentType: "full",
        splits: [
          { partyDisplayName: "X", roleLabel: "Sales Commission", splitType: "percent", splitValue: 100 },
        ],
        documents: [
          { kind: "quotation", fileKey: "uploads/abc.pdf", filename: "quote.pdf" },
        ],
      },
    });
    expect(result.success).toBe(true);
  });
});
