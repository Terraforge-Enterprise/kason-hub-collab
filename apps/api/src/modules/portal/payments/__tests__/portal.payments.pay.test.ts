/**
 * Route-level tests for GET /portal-api/payments/payable-charges (Task C1).
 *
 * Mirrors the owner-billing / statements route-test harness: the repository is
 * mocked so the DB is never reached, and the payments router is mounted under
 * portalUserTypeGuard("tenant") — the same guard portal/index.ts applies at
 * "/payments/*" — so the 403 path is exercised the way production wires it.
 *
 * NOTE: The tenant-only guard is applied at the PORTAL MOUNT level
 * (portal/index.ts:75 — `portalRoutes.use("/payments/*", portalUserTypeGuard("tenant")`)
 * and is NOT duplicated inside the route file. This test mounts the guard to
 * verify the combined behaviour; it does NOT test the guard in isolation.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { Hono } from "hono";
import type { PortalEnv, PortalSessionPayload } from "../../auth/portal.auth.types";

// Mock the repository so the DB is never reached — route tested in isolation.
vi.mock("../portal.payments.repository", () => ({
  listPayments: vi.fn(),
  getPaymentReceipt: vi.fn(),
  listPayableCharges: vi.fn(),
}));

import { portalPaymentsRoutes } from "../portal.payments.routes";
import { listPayableCharges } from "../portal.payments.repository";
import { portalUserTypeGuard } from "../../portal.middleware";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function tenantSession(partyId: string): PortalSessionPayload {
  return {
    userId: `user-${partyId.slice(0, 4)}`,
    orgId: "org-1",
    role: "viewer",
    userType: "tenant",
    partyId,
    iat: 0,
    absoluteExp: 0,
  };
}

const ownerSession: PortalSessionPayload = {
  userId: "user-owner",
  orgId: "org-1",
  role: "viewer",
  userType: "owner",
  partyId: "owner-party",
  iat: 0,
  absoluteExp: 0,
};

/** Build the app the way portal/index.ts mounts payments: tenant-guard + router. */
function makeApp(session: PortalSessionPayload | null) {
  const app = new Hono<PortalEnv>();
  app.use("*", async (c, next) => {
    if (session) c.set("session", session);
    await next();
  });
  app.use("/payments/*", portalUserTypeGuard("tenant"));
  app.route("/payments", portalPaymentsRoutes);
  return app;
}

const payableChargesFixture = {
  data: [
    {
      id: "charge-1",
      chargeNumber: "CHG-202606-0001",
      chargeType: "rent",
      description: "June rent",
      dueDate: "2026-06-01T00:00:00.000Z",
      amount: 900,
      outstandingAmount: 900,
      currency: "MYR",
      invoiceId: "inv-1",
      invoiceNumber: "INV-202606-0001",
    },
  ],
  pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ENABLE_PHASE2_MULTI_PAY = "true";
});

afterEach(() => {
  delete process.env.ENABLE_PHASE2_MULTI_PAY;
});

describe("GET /payments/payable-charges — flag OFF (dark)", () => {
  it("404 when ENABLE_PHASE2_MULTI_PAY is off", async () => {
    delete process.env.ENABLE_PHASE2_MULTI_PAY;
    const res = await makeApp(tenantSession(TENANT_A)).request("/payments/payable-charges");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: "not_found" });
    expect(listPayableCharges).not.toHaveBeenCalled();
  });

  it("404 when ENABLE_PHASE2_MULTI_PAY is set to 'false'", async () => {
    process.env.ENABLE_PHASE2_MULTI_PAY = "false";
    const res = await makeApp(tenantSession(TENANT_A)).request("/payments/payable-charges");
    expect(res.status).toBe(404);
    expect(listPayableCharges).not.toHaveBeenCalled();
  });
});

describe("GET /payments/payable-charges — userType guard", () => {
  it("403 for a non-tenant userType (owner) — mount-level guard blocks before flag is checked", async () => {
    const res = await makeApp(ownerSession).request("/payments/payable-charges");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
    expect(listPayableCharges).not.toHaveBeenCalled();
  });

  it("403 when there is no session at all", async () => {
    const res = await makeApp(null).request("/payments/payable-charges");
    expect(res.status).toBe(403);
    expect(listPayableCharges).not.toHaveBeenCalled();
  });
});

describe("GET /payments/payable-charges — flag ON (tenant's outstanding charges)", () => {
  it("returns the tenant's payable charges with invoiceNumber surfaced", async () => {
    vi.mocked(listPayableCharges).mockResolvedValue(payableChargesFixture as never);

    const res = await makeApp(tenantSession(TENANT_A)).request("/payments/payable-charges");
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.data).toHaveLength(1);
    expect(body.data[0].chargeNumber).toBe("CHG-202606-0001");
    expect(body.data[0].invoiceNumber).toBe("INV-202606-0001");
    expect(body.data[0].outstandingAmount).toBe(900);

    // Repository invoked with the tenant's session scope + default pagination.
    expect(listPayableCharges).toHaveBeenCalledWith(
      { partyId: TENANT_A, orgId: "org-1" },
      1,
      20,
    );
  });

  it("forwards custom pagination to the repository", async () => {
    vi.mocked(listPayableCharges).mockResolvedValue({ data: [], pagination: { page: 2, limit: 5, total: 0, totalPages: 0 } } as never);

    const res = await makeApp(tenantSession(TENANT_A)).request("/payments/payable-charges?page=2&limit=5");
    expect(res.status).toBe(200);
    expect(listPayableCharges).toHaveBeenCalledWith(
      { partyId: TENANT_A, orgId: "org-1" },
      2,
      5,
    );
  });

  it("400 for invalid pagination (page=0)", async () => {
    const res = await makeApp(tenantSession(TENANT_A)).request("/payments/payable-charges?page=0");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toHaveProperty("error");
    expect(listPayableCharges).not.toHaveBeenCalled();
  });

  it("400 for invalid pagination (limit exceeds max 50)", async () => {
    const res = await makeApp(tenantSession(TENANT_A)).request("/payments/payable-charges?limit=51");
    expect(res.status).toBe(400);
    expect(listPayableCharges).not.toHaveBeenCalled();
  });
});

describe("GET /payments/payable-charges — route order guard", () => {
  it("'payable-charges' is NOT captured as :id on the receipt route (correct route order)", async () => {
    // If route order were wrong, Hono would match /:id/receipt instead.
    // With correct order, /payable-charges hits the flag gate (returns 404 when OFF).
    delete process.env.ENABLE_PHASE2_MULTI_PAY;
    const res = await makeApp(tenantSession(TENANT_A)).request("/payments/payable-charges");
    // 404 from the flag gate = correct; any other status would indicate a routing bug.
    expect(res.status).toBe(404);
    const body = await res.json();
    // The flag-gate error body, NOT the receipt-not-found error — confirms correct routing.
    expect(body).toEqual({ error: "not_found" });
  });
});
