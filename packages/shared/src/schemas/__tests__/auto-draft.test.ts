import { describe, it, expect } from "vitest";
import { draftConfigCreateSchema, draftConfigPatchSchema, triggerRunSchema, approveBulkSchema, voidInvoiceSchema, editInvoiceDatesSchema } from "../auto-draft";

describe("auto-draft schemas", () => {
  it("accepts a valid run-day patch", () => {
    expect(draftConfigPatchSchema.parse({ runDayOfMonth: 25, expectedUpdatedAt: "2026-06-18T00:00:00.000Z" }).runDayOfMonth).toBe(25);
  });
  it("rejects runDayOfMonth out of 1..28", () => {
    expect(draftConfigPatchSchema.safeParse({ runDayOfMonth: 31 }).success).toBe(false);
  });
  it("requires a YYYY-MM periodMonth on trigger", () => {
    expect(triggerRunSchema.safeParse({ periodMonth: "2026-6" }).success).toBe(false);
    expect(triggerRunSchema.parse({ periodMonth: "2026-06" }).periodMonth).toBe("2026-06");
  });
  it("approveBulk requires at least one uuid", () => {
    expect(approveBulkSchema.safeParse({ ids: [] }).success).toBe(false);
  });
  it("void reason is optional string", () => {
    expect(voidInvoiceSchema.parse({ expectedUpdatedAt: "x" }).reason).toBeUndefined();
  });
  it("editInvoiceDates rejects when neither date provided", () => {
    expect(editInvoiceDatesSchema.safeParse({ expectedUpdatedAt: "x" }).success).toBe(false);
  });
  it("dueDayOffset accepts null on create", () => {
    expect(draftConfigCreateSchema.parse({ dueDayOffset: null }).dueDayOffset).toBeNull();
  });
});
