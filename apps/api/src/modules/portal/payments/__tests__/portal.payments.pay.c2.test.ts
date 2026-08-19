/**
 * Task C2 tests — split into two files by mock strategy:
 *   - This file: Route tests only (mocks submitMultiPaymentService).
 *   - portal.payments.pay.c2.service.test.ts: Service tests (mocks repo fns).
 *
 * The route test verifies: flag gate, owner guard, Zod validation, status
 * passthrough (201/200/400/404), and that session.userId is forwarded.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type { PortalEnv, PortalSessionPayload } from "../../auth/portal.auth.types";

// ── mock declarations (hoisted) ────────────────────────────────────────────

vi.mock("../portal.payments.repository", () => ({
  listPayments: vi.fn(),
  getPaymentReceipt: vi.fn(),
  listPayableCharges: vi.fn(),
  findPaymentByIdempotencyKey: vi.fn(),
  submitMultiPaymentTx: vi.fn(),
}));

vi.mock("../portal.payments.service", () => ({
  submitMultiPaymentService: vi.fn(),
}));

import { submitMultiPaymentService } from "../portal.payments.service";
import { portalPaymentsRoutes } from "../portal.payments.routes";
import { portalUserTypeGuard } from "../../portal.middleware";

// ── helpers ────────────────────────────────────────────────────────────────

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG = "org-test-1";
const USER_ID = "user-test-1";

function tenantSession(partyId: string): PortalSessionPayload {
  return {
    userId: USER_ID,
    orgId: ORG,
    role: "viewer",
    userType: "tenant",
    partyId,
    iat: 0,
    absoluteExp: 0,
  };
}

const ownerSession: PortalSessionPayload = {
  userId: "user-owner",
  orgId: ORG,
  role: "viewer",
  userType: "owner",
  partyId: "owner-party",
  iat: 0,
  absoluteExp: 0,
};

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

function validPayBody(opts: { idempotencyKey?: string } = {}) {
  return JSON.stringify({
    idempotencyKey: opts.idempotencyKey ?? "11111111-1111-4111-8111-111111111111",
    paymentMethod: "bank_transfer",
    referenceNumber: "TXN-001",
    // A manual (non-FPX) payment is unverifiable without proof of transfer, so
    // the schema requires at least one slip key. Ownership of the key is
    // re-checked against the session in the service.
    attachmentKeys: ["orgs/org-1/payment-slips/party-1/aaaa-slip.jpg"],
    allocations: [
      { chargeId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", allocatedAmount: "900.00" },
    ],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ENABLE_PHASE2_MULTI_PAY = "true";
});

afterEach(() => {
  delete process.env.ENABLE_PHASE2_MULTI_PAY;
});

// ── Route tests: POST /payments/pay ────────────────────────────────────────

describe("POST /payments/pay — route", () => {
  it("flag OFF → 404", async () => {
    delete process.env.ENABLE_PHASE2_MULTI_PAY;
    const res = await makeApp(tenantSession(TENANT_A)).request("/payments/pay", {
      method: "POST",
      body: validPayBody(),
    });
    expect(res.status).toBe(404);
    expect(submitMultiPaymentService).not.toHaveBeenCalled();
  });

  it("owner session → 403 (mount-level guard)", async () => {
    const res = await makeApp(ownerSession).request("/payments/pay", {
      method: "POST",
      body: validPayBody(),
    });
    expect(res.status).toBe(403);
    expect(submitMultiPaymentService).not.toHaveBeenCalled();
  });

  it("malformed body (missing allocations) → Zod 400", async () => {
    const res = await makeApp(tenantSession(TENANT_A)).request("/payments/pay", {
      method: "POST",
      body: JSON.stringify({ idempotencyKey: "11111111-1111-4111-8111-111111111111", paymentMethod: "cash" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toHaveProperty("error");
    expect(submitMultiPaymentService).not.toHaveBeenCalled();
  });

  it("unparseable body → Zod 400", async () => {
    const res = await makeApp(tenantSession(TENANT_A)).request("/payments/pay", {
      method: "POST",
      body: "not-json",
    });
    expect(res.status).toBe(400);
    expect(submitMultiPaymentService).not.toHaveBeenCalled();
  });

  // The slip is what makes a manual payment verifiable at all — an admin has
  // nothing to check it against without one. Rejected at the route, so the
  // service is never reached and no payment row is created.
  it("manual payment with no transfer slip → 400 before the service is reached", async () => {
    const res = await makeApp(tenantSession(TENANT_A)).request("/payments/pay", {
      method: "POST",
      body: JSON.stringify({
        idempotencyKey: "11111111-1111-4111-8111-111111111111",
        paymentMethod: "bank_transfer",
        referenceNumber: "TXN-001",
        allocations: [{ chargeId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", allocatedAmount: "900.00" }],
      }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toHaveProperty("error");
    expect(submitMultiPaymentService).not.toHaveBeenCalled();
  });

  it("valid body → service called with session.userId (not partyId), status 201 passed through", async () => {
    vi.mocked(submitMultiPaymentService).mockResolvedValue({ ok: true, status: 201, data: { id: "pay-1", paymentNumber: "PAY-1" } });
    const res = await makeApp(tenantSession(TENANT_A)).request("/payments/pay", {
      method: "POST",
      body: validPayBody(),
    });
    expect(res.status).toBe(201);
    // Confirm the route passes session.userId (not partyId) into the service.
    expect(submitMultiPaymentService).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID, partyId: TENANT_A, orgId: ORG }),
      expect.any(Object),
    );
  });

  it("service returns 200 (idempotent replay) → 200 passed through", async () => {
    vi.mocked(submitMultiPaymentService).mockResolvedValue({ ok: true, status: 200, data: { id: "pay-1", paymentNumber: "PAY-1" } });
    const res = await makeApp(tenantSession(TENANT_A)).request("/payments/pay", {
      method: "POST",
      body: validPayBody(),
    });
    expect(res.status).toBe(200);
  });

  it("service returns 400 → 400 passed through", async () => {
    vi.mocked(submitMultiPaymentService).mockResolvedValue({ ok: false, status: 400, error: "A selected charge is not payable" });
    const res = await makeApp(tenantSession(TENANT_A)).request("/payments/pay", {
      method: "POST",
      body: validPayBody(),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("A selected charge is not payable");
  });

  it("service returns 404 → 404 passed through", async () => {
    vi.mocked(submitMultiPaymentService).mockResolvedValue({ ok: false, status: 404, error: "Charge not found" });
    const res = await makeApp(tenantSession(TENANT_A)).request("/payments/pay", {
      method: "POST",
      body: validPayBody(),
    });
    expect(res.status).toBe(404);
  });
});
