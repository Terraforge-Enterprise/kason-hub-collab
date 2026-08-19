import { describe, it, expect, vi, beforeEach } from "vitest";

const { chargeFindManyMock, tenancyFindManyMock, docLineFindManyMock } = vi.hoisted(() => ({
  chargeFindManyMock: vi.fn(),
  tenancyFindManyMock: vi.fn(),
  docLineFindManyMock: vi.fn(),
}));
vi.mock("@kason/db", () => ({
  getDb: () => ({
    charge: { findMany: chargeFindManyMock },
    tenancy: { findMany: tenancyFindManyMock },
    billingDocumentLine: { findMany: docLineFindManyMock },
  }),
}));

import { chargesSummary, listCharges } from "../billing.repository";
import { getChargesSummaryService } from "../billing.service";
import { Hono } from "hono";
import { billingRoutes } from "../billing.routes";

const ORG = "org-1";
const session = { orgId: ORG, userId: "u1", role: "admin" } as never;

function sRow(over: Record<string, unknown>) {
  return {
    status: "posted", unitId: "u-1",
    amount: { toString: () => "100" }, outstandingAmount: { toString: () => "40" },
    ...over,
  };
}

beforeEach(() => {
  chargeFindManyMock.mockReset();
  tenancyFindManyMock.mockReset().mockResolvedValue([{ unitId: "u-1" }, { unitId: "u-2" }]);
  docLineFindManyMock.mockReset().mockResolvedValue([]);
});

describe("chargesSummary", () => {
  it("summary figures", async () => {
    chargeFindManyMock.mockResolvedValue([
      sRow({}),                                        // posted, u-1
      sRow({ status: "partially_paid", unitId: "u-1" }),
      sRow({ status: "draft", unitId: "u-2", outstandingAmount: { toString: () => "100" } }),
      sRow({ status: "void", unitId: "u-2" }),
      sRow({ status: "credited", unitId: null }),
    ]);
    const s = await chargesSummary(ORG, new Date("2026-07-01T00:00:00Z"), new Date("2026-08-01T00:00:00Z"));
    expect(s.billedTotal).toBe(300);        // 3 × 100, void+credited excluded
    expect(s.postedCount).toBe(2);          // posted + partially_paid
    expect(s.outstandingTotal).toBe(80);    // 40 + 40 (draft excluded)
    expect(s.unitsBilled).toBe(1);          // only u-1 has posted-like
    expect(s.unitsWithActiveTenancy).toBe(2);
  });
});

describe("listCharges filters", () => {
  it("outstandingOnly filter", async () => {
    chargeFindManyMock.mockResolvedValue([]);
    await listCharges(ORG, undefined, { partyId: "p-1", outstandingOnly: true });
    const where = chargeFindManyMock.mock.calls[0][0].where;
    expect(where.partyId).toBe("p-1");
    expect(where.status).toEqual({ in: ["posted", "partially_paid"] });
    expect(where.outstandingAmount).toEqual({ gt: 0 });
  });
  it("legacy no-filter call keeps where = { organizationId } exactly", async () => {
    chargeFindManyMock.mockResolvedValue([]);
    await listCharges(ORG);
    expect(chargeFindManyMock.mock.calls[0][0].where).toEqual({ organizationId: ORG });
  });
});

describe("GET /billing/charges/summary route", () => {
  it("400 without month", async () => {
    const app = new Hono<{ Variables: { session: unknown } }>();
    app.use("*", async (c, next) => { c.set("session", session); await next(); });
    app.route("/billing", billingRoutes);
    const res = await app.request("/billing/charges/summary");
    expect(res.status).toBe(400);
  });
});
