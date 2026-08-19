/**
 * payments.reverse-routes.test.ts
 * Route-level tests for POST /:paymentId/allocations/:allocationId/reverse.
 * Mirrors the meter / post-routes pattern:
 * - vi.mock the service module
 * - build a Hono app with injected session
 * - mount paymentsRoutes
 * - assert flag gate, RBAC, status passthrough, and Zod validation
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { SessionPayload } from "../../../lib/auth";

// Hoist the service + repository mocks so vi.mock() runs before imports.
const { reverseAllocationServiceMock, findPaymentGatewayStatusMock } = vi.hoisted(() => ({
  reverseAllocationServiceMock: vi.fn(),
  findPaymentGatewayStatusMock: vi.fn(),
}));

vi.mock("../payments.service", () => ({
  getPaymentsService: vi.fn(),
  createPaymentService: vi.fn(),
  allocatePaymentService: vi.fn(),
  updatePaymentStatusService: vi.fn(),
  allocatePaymentBatchService: vi.fn(),
  postPaymentService: vi.fn(),
  reverseAllocationService: reverseAllocationServiceMock,
}));

// The reverse route now consults findPaymentGatewayStatus for the in-flight-FPX
// guard (R4); stub it so this unit test never reaches a real DB. Default: a
// non-FPX payment (gatewayStatus null) so every passthrough case proceeds.
vi.mock("../payments.repository", () => ({
  findPaymentGatewayStatus: findPaymentGatewayStatusMock,
}));

function makeApp(sess: SessionPayload | null) {
  const app = new Hono<{ Variables: { session: SessionPayload } }>();
  app.use("*", async (c, next) => {
    if (sess) c.set("session", sess);
    await next();
  });
  return app;
}

const editorSession: SessionPayload = { userId: "u1", orgId: "o1", role: "editor", userType: "operator" };
const tenantSession: SessionPayload = { userId: "u2", orgId: "o1", role: "tenant", userType: "tenant" };
const viewerSession: SessionPayload = { userId: "u3", orgId: "o1", role: "viewer", userType: "operator" };

const PAYMENT_ID = "11111111-1111-4111-8111-111111111111";
const ALLOC_ID = "44444444-4444-4444-8444-444444444444";

async function buildApp(sess: SessionPayload | null) {
  process.env.ENABLE_PHASE2_MULTI_PAY = "true";
  vi.resetModules();
  const { paymentsRoutes } = await import("../payments.routes");
  const app = makeApp(sess);
  app.route("/", paymentsRoutes);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ENABLE_PHASE2_MULTI_PAY = "true";
  // Default: not an in-flight FPX payment, so the guard falls through to the service.
  findPaymentGatewayStatusMock.mockResolvedValue({ gatewayStatus: null });
});

// ── Flag gate ─────────────────────────────────────────────────────────────────
describe("POST /:paymentId/allocations/:allocationId/reverse — flag gate", () => {
  it("returns 404 when ENABLE_PHASE2_MULTI_PAY is OFF", async () => {
    process.env.ENABLE_PHASE2_MULTI_PAY = "false";
    vi.resetModules();
    const { paymentsRoutes } = await import("../payments.routes");
    const app = makeApp(editorSession);
    app.route("/", paymentsRoutes);
    const res = await app.request(`/${PAYMENT_ID}/allocations/${ALLOC_ID}/reverse`, { method: "POST" });
    expect(res.status).toBe(404);
    expect(reverseAllocationServiceMock).not.toHaveBeenCalled();
  });
});

// ── RBAC ──────────────────────────────────────────────────────────────────────
describe("POST /:paymentId/allocations/:allocationId/reverse — RBAC", () => {
  it("returns 200 for editor (flag ON)", async () => {
    reverseAllocationServiceMock.mockResolvedValueOnce({ ok: true, status: 200, data: { id: ALLOC_ID } });
    const app = await buildApp(editorSession);
    const res = await app.request(`/${PAYMENT_ID}/allocations/${ALLOC_ID}/reverse`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(reverseAllocationServiceMock).toHaveBeenCalledOnce();
  });

  it("returns 403 for viewer (insufficient role)", async () => {
    const app = await buildApp(viewerSession);
    const res = await app.request(`/${PAYMENT_ID}/allocations/${ALLOC_ID}/reverse`, { method: "POST" });
    expect(res.status).toBe(403);
    expect(reverseAllocationServiceMock).not.toHaveBeenCalled();
  });

  // userType-based rejection of non-operator sessions is enforced upstream in authMiddleware (see accountant-wall.integration.test.ts); this asserts the route guard denies a session whose role lacks the accounting workspace and rank floor.
  it("returns 403 for a non-privileged (portal) role", async () => {
    const app = await buildApp(tenantSession);
    const res = await app.request(`/${PAYMENT_ID}/allocations/${ALLOC_ID}/reverse`, { method: "POST" });
    expect(res.status).toBe(403);
    expect(reverseAllocationServiceMock).not.toHaveBeenCalled();
  });
});

// ── Status passthrough ────────────────────────────────────────────────────────
describe("POST /:paymentId/allocations/:allocationId/reverse — status passthrough", () => {
  it("returns 404 when service returns ok=false, status=404", async () => {
    reverseAllocationServiceMock.mockResolvedValueOnce({ ok: false, status: 404, error: "Allocation not found" });
    const app = await buildApp(editorSession);
    const res = await app.request(`/${PAYMENT_ID}/allocations/${ALLOC_ID}/reverse`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("returns 409 when service returns ok=false, status=409 (stale)", async () => {
    reverseAllocationServiceMock.mockResolvedValueOnce({ ok: false, status: 409, error: "Changed since you loaded it. Refresh and retry." });
    const app = await buildApp(editorSession);
    const res = await app.request(`/${PAYMENT_ID}/allocations/${ALLOC_ID}/reverse`, { method: "POST" });
    expect(res.status).toBe(409);
  });
});

// ── Zod validation ────────────────────────────────────────────────────────────
describe("POST /:paymentId/allocations/:allocationId/reverse — Zod validation", () => {
  it("returns 400 for non-UUID paymentId", async () => {
    const app = await buildApp(editorSession);
    const res = await app.request(`/not-a-uuid/allocations/${ALLOC_ID}/reverse`, { method: "POST" });
    expect(res.status).toBe(400);
    expect(reverseAllocationServiceMock).not.toHaveBeenCalled();
  });

  it("returns 400 for non-UUID allocationId", async () => {
    const app = await buildApp(editorSession);
    const res = await app.request(`/${PAYMENT_ID}/allocations/not-a-uuid/reverse`, { method: "POST" });
    expect(res.status).toBe(400);
    expect(reverseAllocationServiceMock).not.toHaveBeenCalled();
  });
});
