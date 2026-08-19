import { describe, it, expect } from "vitest";

// mapStatement surfaces Invoice.apartmentId on the read DTO. The owner statement
// is COMBINED-ONLY now (generation always persists apartmentId=null), but the
// column stays nullable and mapStatement must still echo it faithfully — null for
// the combined statement, and any value present on a row (defensive, e.g. a
// historical/per-unit Invoice voided by the cleanup) → mapStatement(inv).apartmentId.
//
// NOTE: this file previously also asserted per-apartment statement GENERATION
// (apartment-scoped idempotency key / invoice number / persisted apartmentId).
// That path is RETIRED — the statement is combined-only — so those cases were
// removed. The assembler's apartment FILTER (reused by the on-demand Receipt) is
// covered separately in owner-billing.statement-sections.per-unit.test.ts.
import { mapStatement } from "../owner-billing.service";

describe("mapStatement — apartmentId in read DTO", () => {
  const ISO = "2026-06-01T00:00:00.000Z";
  const baseInvoice = {
    id: "inv-1",
    organizationId: "org",
    invoiceNumber: "OS-202606-11111111",
    partyId: "owner",
    ownerPartyId: "owner",
    tenancyId: null,
    propertyId: null,
    invoiceType: "owner_statement",
    status: "draft",
    invoiceDate: new Date(ISO),
    dueDate: null,
    periodMonth: new Date(Date.UTC(2026, 5, 1)),
    totalAmount: { toString: () => "300" },
    sstAmount: null,
    currency: "MYR",
    pdfKey: null,
    attachmentKeys: [],
    idempotencyKey: "owner:owner:2026-06",
    approvedBy: null,
    approvedAt: null,
    createdAt: new Date(ISO),
    updatedAt: new Date(ISO),
    charges: [],
  };

  it("echoes a non-null apartmentId present on the invoice", () => {
    const inv = { ...baseInvoice, apartmentId: "apt-42" };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = mapStatement(inv as any);
    expect(row).toHaveProperty("apartmentId", "apt-42");
  });

  it("returns null apartmentId for the combined owner statement", () => {
    const inv = { ...baseInvoice, apartmentId: null };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = mapStatement(inv as any);
    expect(row).toHaveProperty("apartmentId", null);
  });

  it("returns null apartmentId when the field is absent on the invoice", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inv = { ...baseInvoice } as any;
    delete inv.apartmentId;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = mapStatement(inv as any);
    expect(row).toHaveProperty("apartmentId", null);
  });
});
