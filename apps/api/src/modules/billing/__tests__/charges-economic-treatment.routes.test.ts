import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { BillingSession } from "../billing.types";

// Spec 1 (Phase 1, R26): PATCH /charges/:id/economic-treatment — unissued only.
// getDb() is mocked so the route logic (guard + update) is tested without a DB.
const charge = { findFirst: vi.fn(), update: vi.fn() };
const billingDocumentLine = { findFirst: vi.fn() };
const fakeDb = { charge, billingDocumentLine, $transaction: (fn: (tx: unknown) => unknown) => fn({ charge, billingDocumentLine }) };
vi.mock("@kason/db", () => ({ getDb: () => fakeDb }));

// The other billing services are unused here but the route file imports them; mock to no-ops.
vi.mock("../billing.service", () => ({
  getChargesService: vi.fn(), createChargeService: vi.fn(), postChargeService: vi.fn(),
  voidChargeService: vi.fn(), getChargeByIdService: vi.fn(), getChargesGroupedService: vi.fn(),
  getChargesSummaryService: vi.fn(),
}));

import { billingRoutes } from "../billing.routes";

const session: BillingSession = { userId: "u1", orgId: "org-1", role: "admin" };
const CID = "22222222-2222-4222-8222-222222222222";

function patch(body: unknown) {
  const app = new Hono<{ Variables: { session: BillingSession } }>();
  app.use("*", async (c, next) => { c.set("session", session); await next(); });
  app.route("/", billingRoutes);
  return app.request(`/charges/${CID}/economic-treatment`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}

beforeEach(() => { vi.clearAllMocks(); });

describe("PATCH /charges/:id/economic-treatment (R26)", () => {
  it("200 on an UNISSUED charge; clears the fail-closed marker", async () => {
    charge.findFirst.mockResolvedValueOnce({ id: CID });
    billingDocumentLine.findFirst.mockResolvedValueOnce(null); // not issued
    charge.update.mockResolvedValueOnce({ id: CID, commercialPurpose: "RENT", fundedBy: "tenant_funded", revenueRecognition: "third_party_collection", settlementRecipient: "owner", nonBillable: false });
    const res = await patch({ commercialPurpose: "RENT", fundedBy: "tenant_funded", revenueRecognition: "third_party_collection", settlementRecipient: "owner" });
    expect(res.status).toBe(200);
    expect(charge.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ commercialPurpose: "RENT", economicClassificationStatus: null }),
    }));
  });

  it("409 CHARGE_ALREADY_ISSUED when a document line references the charge", async () => {
    charge.findFirst.mockResolvedValueOnce({ id: CID });
    billingDocumentLine.findFirst.mockResolvedValueOnce({ id: "line-1" }); // issued
    const res = await patch({ commercialPurpose: "RENT" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("CHARGE_ALREADY_ISSUED");
    expect(charge.update).not.toHaveBeenCalled();
  });

  it("404 when the charge is not in the org", async () => {
    charge.findFirst.mockResolvedValueOnce(null);
    const res = await patch({ commercialPurpose: "RENT" });
    expect(res.status).toBe(404);
  });

  it("400 on an empty patch body", async () => {
    const res = await patch({});
    expect(res.status).toBe(400);
  });
});
