/**
 * Task 2 (sub-project A / FPX) — route tests for POST /payments/fpx/initiate.
 *
 * Mocks the service (initiateFpxPaymentService). Verifies the BOTH-flags gate
 * (ENABLE_PHASE2_MULTI_PAY AND ENABLE_PHASE2_FPX), the tenant-only mount guard,
 * Zod validation, session.userId forwarding, and status/body passthrough.
 *
 * Sibling files:
 *   - fpx-initiate.service.test.ts     → service orchestration (mock repo + gw)
 *   - fpx-initiate.integration.test.ts → real DB
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type { PortalEnv, PortalSessionPayload } from "../../auth/portal.auth.types";

// ── mock declarations (hoisted) ─────────────────────────────────────────────
vi.mock("../portal.payments.repository", () => ({
  listPayments: vi.fn(),
  getPaymentReceipt: vi.fn(),
  listPayableCharges: vi.fn(),
  findPaymentByIdempotencyKey: vi.fn(),
  submitMultiPaymentTx: vi.fn(),
  validatePaymentAllocationsTx: vi.fn(),
  findFpxPaymentByIdempotencyKey: vi.fn(),
  initiateFpxPaymentTx: vi.fn(),
}));
vi.mock("../portal.payments.service", () => ({
  submitMultiPaymentService: vi.fn(),
}));
vi.mock("../fpx-initiate.service", () => ({
  initiateFpxPaymentService: vi.fn(),
}));

import { initiateFpxPaymentService } from "../fpx-initiate.service";
import { portalPaymentsRoutes } from "../portal.payments.routes";
import { portalUserTypeGuard } from "../../portal.middleware";

// ── helpers ─────────────────────────────────────────────────────────────────
const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG = "org-test-1";
const USER_ID = "user-test-1";

function tenantSession(partyId: string): PortalSessionPayload {
  return { userId: USER_ID, orgId: ORG, role: "viewer", userType: "tenant", partyId, iat: 0, absoluteExp: 0 };
}
const ownerSession: PortalSessionPayload = {
  userId: "user-owner", orgId: ORG, role: "viewer", userType: "owner", partyId: "owner-party", iat: 0, absoluteExp: 0,
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

function validBody(opts: { idempotencyKey?: string } = {}) {
  return JSON.stringify({
    idempotencyKey: opts.idempotencyKey ?? "11111111-1111-4111-8111-111111111111",
    allocations: [{ chargeId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", allocatedAmount: "900.00" }],
  });
}

function post(app: ReturnType<typeof makeApp>, body: string) {
  return app.request("/payments/fpx/initiate", { method: "POST", body });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ENABLE_PHASE2_MULTI_PAY = "true";
  process.env.ENABLE_PHASE2_FPX = "true";
});
afterEach(() => {
  delete process.env.ENABLE_PHASE2_MULTI_PAY;
  delete process.env.ENABLE_PHASE2_FPX;
});

// ── tests ─────────────────────────────────────────────────────────────────
describe("POST /payments/fpx/initiate — route", () => {
  it("both flags ON + valid body → 200; service called with session.userId; body passed through", async () => {
    vi.mocked(initiateFpxPaymentService).mockResolvedValue({
      ok: true, status: 200, data: { redirectUrl: "https://gw/redirect", providerTxnId: "txn-1", paymentId: "pay-1" },
    });
    const res = await post(makeApp(tenantSession(TENANT_A)), validBody());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ redirectUrl: "https://gw/redirect", providerTxnId: "txn-1", paymentId: "pay-1" });
    expect(initiateFpxPaymentService).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID, partyId: TENANT_A, orgId: ORG }),
      expect.any(Object),
    );
  });

  it("ENABLE_PHASE2_FPX OFF (multi-pay ON) → 404 (service not called)", async () => {
    delete process.env.ENABLE_PHASE2_FPX;
    const res = await post(makeApp(tenantSession(TENANT_A)), validBody());
    expect(res.status).toBe(404);
    expect(initiateFpxPaymentService).not.toHaveBeenCalled();
  });

  it("ENABLE_PHASE2_MULTI_PAY OFF (fpx ON) → 404 (service not called)", async () => {
    delete process.env.ENABLE_PHASE2_MULTI_PAY;
    const res = await post(makeApp(tenantSession(TENANT_A)), validBody());
    expect(res.status).toBe(404);
    expect(initiateFpxPaymentService).not.toHaveBeenCalled();
  });

  it("both flags OFF → 404", async () => {
    delete process.env.ENABLE_PHASE2_FPX;
    delete process.env.ENABLE_PHASE2_MULTI_PAY;
    const res = await post(makeApp(tenantSession(TENANT_A)), validBody());
    expect(res.status).toBe(404);
    expect(initiateFpxPaymentService).not.toHaveBeenCalled();
  });

  it("owner session → 403 (tenant-only mount guard)", async () => {
    const res = await post(makeApp(ownerSession), validBody());
    expect(res.status).toBe(403);
    expect(initiateFpxPaymentService).not.toHaveBeenCalled();
  });

  it("malformed body (missing allocations) → Zod 400 (service not called)", async () => {
    const res = await post(
      makeApp(tenantSession(TENANT_A)),
      JSON.stringify({ idempotencyKey: "11111111-1111-4111-8111-111111111111" }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toHaveProperty("error");
    expect(initiateFpxPaymentService).not.toHaveBeenCalled();
  });

  it("unparseable body → Zod 400 (service not called)", async () => {
    const res = await post(makeApp(tenantSession(TENANT_A)), "not-json");
    expect(res.status).toBe(400);
    expect(initiateFpxPaymentService).not.toHaveBeenCalled();
  });

  it("service returns 400 → 400 passed through with error", async () => {
    vi.mocked(initiateFpxPaymentService).mockResolvedValue({ ok: false, status: 400, error: "An amount exceeds the charge's outstanding balance" });
    const res = await post(makeApp(tenantSession(TENANT_A)), validBody());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("An amount exceeds the charge's outstanding balance");
  });

  it("service returns 404 → 404 passed through", async () => {
    vi.mocked(initiateFpxPaymentService).mockResolvedValue({ ok: false, status: 404, error: "Charge not found" });
    const res = await post(makeApp(tenantSession(TENANT_A)), validBody());
    expect(res.status).toBe(404);
  });
});
