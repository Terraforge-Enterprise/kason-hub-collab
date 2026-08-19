/**
 * payments.batch-routes.test.ts
 * Route-level tests for POST /:paymentId/allocate-batch.
 * Mirrors apps/api/src/modules/meter/__tests__/routes.test.ts style:
 * - vi.mock the service module
 * - build a Hono app with injected session
 * - mount paymentsRoutes
 * - assert flag gate, RBAC, status passthrough, and Zod validation
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { SessionPayload } from "../../../lib/auth";

// Hoist the service mock so vi.mock() runs before imports.
const { allocatePaymentBatchServiceMock, findPaymentGatewayStatusMock } = vi.hoisted(() => ({
  allocatePaymentBatchServiceMock: vi.fn(),
  findPaymentGatewayStatusMock: vi.fn(),
}));

vi.mock("../payments.service", () => ({
  getPaymentsService: vi.fn(),
  createPaymentService: vi.fn(),
  allocatePaymentService: vi.fn(),
  updatePaymentStatusService: vi.fn(),
  allocatePaymentBatchService: allocatePaymentBatchServiceMock,
}));

// The route now consults findPaymentGatewayStatus for the in-flight-FPX guard;
// stub it so this unit test never reaches a real DB. Default: a non-FPX payment
// (gatewayStatus null) so every existing passthrough case proceeds to the service.
vi.mock("../payments.repository", () => ({
  findPaymentGatewayStatus: findPaymentGatewayStatusMock,
}));

function makeApp(session: SessionPayload | null) {
  const app = new Hono<{ Variables: { session: SessionPayload } }>();
  app.use("*", async (c, next) => {
    if (session) c.set("session", session);
    await next();
  });
  return app;
}

const editor: SessionPayload = { userId: "u1", orgId: "o1", role: "editor", userType: "operator" };
const viewer: SessionPayload = { userId: "u3", orgId: "o1", role: "viewer", userType: "operator" };
const tenant: SessionPayload = { userId: "u4", orgId: "o1", role: "editor", userType: "tenant" };

const PAYMENT_ID = "11111111-1111-4111-8111-111111111111";
const CHARGE_ID = "22222222-2222-4222-8222-222222222222";
const IDEM_KEY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const validBody = JSON.stringify({
  idempotencyKey: IDEM_KEY,
  allocations: [{ chargeId: CHARGE_ID, allocatedAmount: "900.00" }],
});

const jsonHeaders = { "Content-Type": "application/json" };

async function buildApp(session: SessionPayload | null) {
  process.env.ENABLE_PHASE2_MULTI_PAY = "true";
  vi.resetModules();
  const { paymentsRoutes } = await import("../payments.routes");
  const app = makeApp(session);
  app.route("/", paymentsRoutes);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Reset flag to ON by default; individual tests override as needed.
  process.env.ENABLE_PHASE2_MULTI_PAY = "true";
  // Default: not an in-flight FPX payment, so the guard falls through to the service.
  findPaymentGatewayStatusMock.mockResolvedValue({ gatewayStatus: null });
});

// ── Flag gate ─────────────────────────────────────────────────────────────────
describe("POST /:paymentId/allocate-batch — flag gate", () => {
  it("returns 404 when ENABLE_PHASE2_MULTI_PAY is OFF (even for a valid editor)", async () => {
    process.env.ENABLE_PHASE2_MULTI_PAY = "false";
    vi.resetModules();
    const { paymentsRoutes } = await import("../payments.routes");
    const app = makeApp(editor);
    app.route("/", paymentsRoutes);
    const res = await app.request(`/${PAYMENT_ID}/allocate-batch`, {
      method: "POST",
      headers: jsonHeaders,
      body: validBody,
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "not_found" });
    expect(allocatePaymentBatchServiceMock).not.toHaveBeenCalled();
  });
});

// ── RBAC ──────────────────────────────────────────────────────────────────────
describe("POST /:paymentId/allocate-batch — RBAC", () => {
  it("returns 403 when userType is tenant (non-operator)", async () => {
    const app = await buildApp(tenant);
    const res = await app.request(`/${PAYMENT_ID}/allocate-batch`, {
      method: "POST",
      headers: jsonHeaders,
      body: validBody,
    });
    expect(res.status).toBe(403);
    expect(allocatePaymentBatchServiceMock).not.toHaveBeenCalled();
  });

  it("returns 403 when role is viewer (below editor)", async () => {
    const app = await buildApp(viewer);
    const res = await app.request(`/${PAYMENT_ID}/allocate-batch`, {
      method: "POST",
      headers: jsonHeaders,
      body: validBody,
    });
    expect(res.status).toBe(403);
    expect(allocatePaymentBatchServiceMock).not.toHaveBeenCalled();
  });

  it("returns 401 when no session is set", async () => {
    const app = await buildApp(null);
    const res = await app.request(`/${PAYMENT_ID}/allocate-batch`, {
      method: "POST",
      headers: jsonHeaders,
      body: validBody,
    });
    expect(res.status).toBe(401);
    expect(allocatePaymentBatchServiceMock).not.toHaveBeenCalled();
  });
});

// ── Status passthrough ────────────────────────────────────────────────────────
describe("POST /:paymentId/allocate-batch — service status passthrough", () => {
  it("returns 201 when service returns ok=true, status=201", async () => {
    allocatePaymentBatchServiceMock.mockResolvedValueOnce({
      ok: true,
      status: 201,
      data: { id: PAYMENT_ID, allocations: [] },
    });
    const app = await buildApp(editor);
    const res = await app.request(`/${PAYMENT_ID}/allocate-batch`, {
      method: "POST",
      headers: jsonHeaders,
      body: validBody,
    });
    expect(res.status).toBe(201);
    expect(allocatePaymentBatchServiceMock).toHaveBeenCalledOnce();
  });

  it("returns 200 when service returns ok=true, status=200 (replay)", async () => {
    allocatePaymentBatchServiceMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { id: PAYMENT_ID, replayed: true },
    });
    const app = await buildApp(editor);
    const res = await app.request(`/${PAYMENT_ID}/allocate-batch`, {
      method: "POST",
      headers: jsonHeaders,
      body: validBody,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ replayed: true });
  });

  it("returns 404 when service returns ok=false, status=404", async () => {
    allocatePaymentBatchServiceMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      error: "Payment not found",
    });
    const app = await buildApp(editor);
    const res = await app.request(`/${PAYMENT_ID}/allocate-batch`, {
      method: "POST",
      headers: jsonHeaders,
      body: validBody,
    });
    expect(res.status).toBe(404);
  });

  it("returns 409 when service returns ok=false, status=409", async () => {
    allocatePaymentBatchServiceMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      error: "This payment has already been allocated.",
    });
    const app = await buildApp(editor);
    const res = await app.request(`/${PAYMENT_ID}/allocate-batch`, {
      method: "POST",
      headers: jsonHeaders,
      body: validBody,
    });
    expect(res.status).toBe(409);
  });

  it("returns 400 when service returns ok=false, status=400", async () => {
    allocatePaymentBatchServiceMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      error: "An allocation exceeds the charge's outstanding amount",
    });
    const app = await buildApp(editor);
    const res = await app.request(`/${PAYMENT_ID}/allocate-batch`, {
      method: "POST",
      headers: jsonHeaders,
      body: validBody,
    });
    expect(res.status).toBe(400);
  });
});

// ── Zod validation ────────────────────────────────────────────────────────────
describe("POST /:paymentId/allocate-batch — Zod validation", () => {
  it("returns 400 for malformed body (missing idempotencyKey)", async () => {
    const app = await buildApp(editor);
    const res = await app.request(`/${PAYMENT_ID}/allocate-batch`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ allocations: [{ chargeId: CHARGE_ID, allocatedAmount: "100" }] }),
    });
    expect(res.status).toBe(400);
    expect(allocatePaymentBatchServiceMock).not.toHaveBeenCalled();
  });

  it("returns 400 for empty allocations array", async () => {
    const app = await buildApp(editor);
    const res = await app.request(`/${PAYMENT_ID}/allocate-batch`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ idempotencyKey: IDEM_KEY, allocations: [] }),
    });
    expect(res.status).toBe(400);
    expect(allocatePaymentBatchServiceMock).not.toHaveBeenCalled();
  });

  it("returns 400 for non-JSON body", async () => {
    const app = await buildApp(editor);
    const res = await app.request(`/${PAYMENT_ID}/allocate-batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    expect(res.status).toBe(400);
    expect(allocatePaymentBatchServiceMock).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid paymentId (not a uuid) in URL param", async () => {
    const app = await buildApp(editor);
    const res = await app.request(`/not-a-uuid/allocate-batch`, {
      method: "POST",
      headers: jsonHeaders,
      body: validBody,
    });
    expect(res.status).toBe(400);
    expect(allocatePaymentBatchServiceMock).not.toHaveBeenCalled();
  });
});

// ── Existing routes not affected by the new flag gate ─────────────────────────
describe("existing routes — not affected by multiPayGate", () => {
  it("GET / still works when flag is OFF", async () => {
    process.env.ENABLE_PHASE2_MULTI_PAY = "false";
    vi.resetModules();
    // Need to also mock getPaymentsService via the already-mocked module.
    // The vi.mock at top of file covers it — reimport routes.
    const { paymentsRoutes } = await import("../payments.routes");
    const app = makeApp(editor);
    app.route("/", paymentsRoutes);
    // getPaymentsService is mocked to return undefined by default; the route wraps it in {data:...}
    const res = await app.request("/");
    // Should NOT return 404 (that would mean the whole router is gated).
    expect(res.status).not.toBe(404);
  });
});
