/**
 * Route-level tests for the owner-portal financials surface (Task E1).
 *
 * Mirrors the owner-billing route-test harness (modules/owner-billing/__tests__):
 * the repository is mocked so the DB is never reached, and the financials router
 * is mounted under the SAME portalUserTypeGuard("owner") the portal index applies,
 * so the 403 path is exercised the way production wires it.
 *
 * The flag-OFF case is the BYTE-IDENTICAL regression guard: with
 * ENABLE_PHASE2_OWNER_BILLING off, the route MUST call the EXISTING getFinancials
 * and return its exact shape (deep-equalled against a fixture). With the flag on,
 * the route calls getFinancialsExtended and the response carries the additive
 * totals.mgmtFeeDeducted/expenses/netRemittance + feeBreakdown.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { Hono } from "hono";
import type { PortalEnv, PortalSessionPayload } from "../../auth/portal.auth.types";

// Mock the repository so the DB is never reached — route tested in isolation.
vi.mock("../portal.financials.repository", () => ({
  getFinancials: vi.fn(),
  getFinancialsExtended: vi.fn(),
}));

import { portalFinancialsRoutes } from "../portal.financials.routes";
import { getFinancials, getFinancialsExtended } from "../portal.financials.repository";
import { portalUserTypeGuard } from "../../portal.middleware";

const OWNER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function ownerSession(partyId: string): PortalSessionPayload {
  return {
    userId: `user-${partyId.slice(0, 4)}`,
    orgId: "org-1",
    role: "viewer",
    userType: "owner",
    partyId,
    iat: 0,
    absoluteExp: 0,
  };
}

const agentSession: PortalSessionPayload = {
  userId: "user-agent",
  orgId: "org-1",
  role: "viewer",
  userType: "agent",
  partyId: "agent-party",
  iat: 0,
  absoluteExp: 0,
};

/** Build the app the way portal/index.ts mounts financials: owner-guard + router. */
function makeApp(session: PortalSessionPayload | null) {
  const app = new Hono<PortalEnv>();
  app.use("*", async (c, next) => {
    if (session) c.set("session", session);
    await next();
  });
  app.use("/financials/*", portalUserTypeGuard("owner"));
  app.route("/financials", portalFinancialsRoutes);
  return app;
}

// The EXACT shape today's getFinancials returns — the byte-identical fixture.
const baseFinancials = {
  month: "2026-06",
  properties: [
    {
      id: "prop-1",
      name: "Annex Residence",
      totalUnits: 2,
      occupiedUnits: 1,
      expectedRent: 2000,
      collectedRent: 1500,
      units: [
        { unitCode: "A-1", tenantName: "Tan", expectedRent: 2000, paidAmount: 1500, status: "partial" },
      ],
    },
  ],
  totals: { expectedRent: 2000, collectedRent: 1500, collectionRate: 0.75 },
};

// The flag-ON extended shape for OWNER A — base + additive breakdown.
const extendedFinancialsA = {
  ...baseFinancials,
  totals: {
    ...baseFinancials.totals,
    mgmtFeeDeducted: "200.00",
    expenses: "100.00",
    netRemittance: "1184.00",
  },
  feeBreakdown: { percentLabel: "10%", base: "200.00", sst: "16.00", total: "216.00" },
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  delete process.env.ENABLE_PHASE2_OWNER_BILLING;
});

describe("GET /financials — flag OFF (byte-identical regression guard)", () => {
  it("returns the EXISTING getFinancials shape exactly, never calling the extension", async () => {
    delete process.env.ENABLE_PHASE2_OWNER_BILLING;
    vi.mocked(getFinancials).mockResolvedValue(baseFinancials as never);

    const res = await makeApp(ownerSession(OWNER_A)).request("/financials?month=2026-06");
    expect(res.status).toBe(200);
    const body = await res.json();

    // Deep-equal against the fixture — the response is byte-identical to today's.
    expect(body).toEqual({ data: baseFinancials });
    // The base function was called; the extension was NOT.
    expect(getFinancials).toHaveBeenCalledTimes(1);
    expect(getFinancialsExtended).not.toHaveBeenCalled();
    // No additive fields leak when the flag is off.
    expect(body.data.totals).not.toHaveProperty("mgmtFeeDeducted");
    expect(body.data.totals).not.toHaveProperty("expenses");
    expect(body.data.totals).not.toHaveProperty("netRemittance");
    expect(body.data).not.toHaveProperty("feeBreakdown");
  });

  it("forwards month + propertyId to getFinancials with the session scope", async () => {
    delete process.env.ENABLE_PHASE2_OWNER_BILLING;
    vi.mocked(getFinancials).mockResolvedValue(baseFinancials as never);

    await makeApp(ownerSession(OWNER_A)).request("/financials?month=2026-05&propertyId=prop-9");
    expect(getFinancials).toHaveBeenCalledWith(
      { partyId: OWNER_A, orgId: "org-1" },
      "2026-05",
      "prop-9",
    );
  });
});

describe("GET /financials — flag ON (additive owner-billing breakdown)", () => {
  it("returns base + totals.mgmtFeeDeducted/expenses/netRemittance + feeBreakdown", async () => {
    process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
    vi.mocked(getFinancialsExtended).mockResolvedValue(extendedFinancialsA as never);

    const res = await makeApp(ownerSession(OWNER_A)).request("/financials?month=2026-06");
    expect(res.status).toBe(200);
    const body = await res.json();

    // The extension was called (not the bare base function).
    expect(getFinancialsExtended).toHaveBeenCalledTimes(1);
    expect(getFinancials).not.toHaveBeenCalled();

    // Base shape preserved untouched.
    expect(body.data.month).toBe("2026-06");
    expect(body.data.properties).toEqual(baseFinancials.properties);
    expect(body.data.totals.expectedRent).toBe(2000);
    expect(body.data.totals.collectedRent).toBe(1500);
    expect(body.data.totals.collectionRate).toBe(0.75);

    // Additive fields present and matching the owner's statement.
    expect(body.data.totals.mgmtFeeDeducted).toBe("200.00");
    expect(body.data.totals.expenses).toBe("100.00");
    expect(body.data.totals.netRemittance).toBe("1184.00");
    expect(body.data.feeBreakdown).toEqual({
      percentLabel: "10%",
      base: "200.00",
      sst: "16.00",
      total: "216.00",
    });
  });

  it("owner A's request resolves ONLY owner A's data — owner B's statement is never seen", async () => {
    process.env.ENABLE_PHASE2_OWNER_BILLING = "1";

    // The extension resolution is owner-scoped: it is invoked with owner A's
    // partyId, so the data returned is A's. Owner B's statement is excluded by
    // the partyId scope and never reaches this caller.
    const extendedForA = { ...extendedFinancialsA };
    vi.mocked(getFinancialsExtended).mockImplementation(async (scope) => {
      expect(scope.partyId).toBe(OWNER_A);
      expect(scope.partyId).not.toBe(OWNER_B);
      return extendedForA as never;
    });

    const res = await makeApp(ownerSession(OWNER_A)).request("/financials?month=2026-06");
    expect(res.status).toBe(200);
    const body = await res.json();
    // The extension was scoped to owner A.
    expect(getFinancialsExtended).toHaveBeenCalledWith(
      { partyId: OWNER_A, orgId: "org-1" },
      "2026-06",
      undefined,
    );
    expect(body.data.totals.mgmtFeeDeducted).toBe("200.00");
  });
});

describe("GET /financials — userType guard", () => {
  it("403 for a non-owner userType (agent)", async () => {
    process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
    const res = await makeApp(agentSession).request("/financials?month=2026-06");
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual({ error: "Forbidden" });
    // Neither resolver runs when the guard rejects.
    expect(getFinancials).not.toHaveBeenCalled();
    expect(getFinancialsExtended).not.toHaveBeenCalled();
  });

  it("403 when there is no session at all", async () => {
    process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
    const res = await makeApp(null).request("/financials?month=2026-06");
    expect(res.status).toBe(403);
  });
});
