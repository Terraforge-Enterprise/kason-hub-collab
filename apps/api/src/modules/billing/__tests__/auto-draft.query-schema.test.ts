/**
 * Guards the draft-approvals queue's FE↔BE contract. The queue loads a whole
 * period in one shot (no pagination) and bulk-approves up to 200 at a time, so it
 * requests `limit=200`. This was previously capped at 100 → every load 400'd with
 * "Failed to load invoices". Keep the cap/default >= 200.
 */
import { describe, it, expect } from "vitest";
import { invoiceQueueQuerySchema } from "@kason/shared";

describe("invoiceQueueQuerySchema (approvals queue contract)", () => {
  it("accepts the queue's own limit=200 request", () => {
    const r = invoiceQueueQuerySchema.safeParse({ status: "draft", periodMonth: "2026-07", limit: "200" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.limit).toBe(200);
  });

  it("still rejects an over-cap limit (> 200)", () => {
    expect(invoiceQueueQuerySchema.safeParse({ limit: "201" }).success).toBe(false);
  });

  it("defaults limit high enough to load a full period at once", () => {
    const r = invoiceQueueQuerySchema.parse({});
    expect(r.limit).toBeGreaterThanOrEqual(200);
    expect(r.status).toBe("draft");
  });
});
