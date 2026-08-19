/**
 * Item 3 (FPX ops polish) — route tests for the admin in-flight-FPX view + cancel.
 *
 *   GET  /payments/fpx/in-flight   — manager+; ENABLE_PHASE2_FPX-gated; org-scoped list.
 *   POST /payments/fpx/:id/cancel  — admin only; ENABLE_PHASE2_FPX-gated; expires a stuck row.
 *
 * Mocks the service layer (and the repository the routes file imports directly),
 * so this asserts the flag gate, the RBAC gate, the uuid validation, and the
 * service-result → HTTP passthrough — never DB behaviour (covered by the
 * integration sibling).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { SessionPayload } from "../../../lib/auth";

const { listInFlightFpxServiceMock, cancelInFlightFpxServiceMock } = vi.hoisted(() => ({
  listInFlightFpxServiceMock: vi.fn(),
  cancelInFlightFpxServiceMock: vi.fn(),
}));

vi.mock("../payments.service", () => ({
  getPaymentsService: vi.fn(),
  createPaymentService: vi.fn(),
  allocatePaymentService: vi.fn(),
  updatePaymentStatusService: vi.fn(),
  allocatePaymentBatchService: vi.fn(),
  postPaymentService: vi.fn(),
  reverseAllocationService: vi.fn(),
  listInFlightFpxService: listInFlightFpxServiceMock,
  cancelInFlightFpxService: cancelInFlightFpxServiceMock,
}));

vi.mock("../payments.repository", () => ({
  findPaymentGatewayStatus: vi.fn(),
}));

type App = Hono<{ Variables: { session: SessionPayload } }>;

const admin: SessionPayload = { userId: "u-admin", orgId: "o1", role: "admin", userType: "operator" };
const manager: SessionPayload = { userId: "u-mgr", orgId: "o1", role: "manager", userType: "operator" };
const editor: SessionPayload = { userId: "u-ed", orgId: "o1", role: "editor", userType: "operator" };

const PAYMENT_ID = "11111111-1111-4111-8111-111111111111";

function makeApp(session: SessionPayload | null): App {
  const app = new Hono<{ Variables: { session: SessionPayload } }>();
  app.use("*", async (c, next) => {
    if (session) c.set("session", session);
    await next();
  });
  return app;
}

async function buildApp(session: SessionPayload | null): Promise<App> {
  vi.resetModules();
  const { paymentsRoutes } = await import("../payments.routes");
  const app = makeApp(session);
  app.route("/", paymentsRoutes);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ENABLE_PHASE2_FPX = "true";
});

describe("GET /payments/fpx/in-flight", () => {
  it("manager + flag ON → 200 with the service's list; service called once", async () => {
    const data = [
      { id: PAYMENT_ID, paymentNumber: "PAY-1", partyName: "Tenant A", amount: 900, currency: "MYR", createdAt: "2026-06-27T00:00:00.000Z", ageMinutes: 42 },
    ];
    listInFlightFpxServiceMock.mockResolvedValue({ data });
    const app = await buildApp(manager);
    const res = await app.request("/fpx/in-flight");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data });
    expect(listInFlightFpxServiceMock).toHaveBeenCalledOnce();
  });

  it("flag OFF → 404 (service not called)", async () => {
    delete process.env.ENABLE_PHASE2_FPX;
    const app = await buildApp(manager);
    const res = await app.request("/fpx/in-flight");
    expect(res.status).toBe(404);
    expect(listInFlightFpxServiceMock).not.toHaveBeenCalled();
  });

  it("editor → 403 (manager required)", async () => {
    const app = await buildApp(editor);
    const res = await app.request("/fpx/in-flight");
    expect(res.status).toBe(403);
    expect(listInFlightFpxServiceMock).not.toHaveBeenCalled();
  });
});

describe("POST /payments/fpx/:paymentId/cancel", () => {
  it("admin + flag ON → 200 with the service data", async () => {
    cancelInFlightFpxServiceMock.mockResolvedValue({ ok: true, status: 200, data: { id: PAYMENT_ID, status: "expired" } });
    const app = await buildApp(admin);
    const res = await app.request(`/fpx/${PAYMENT_ID}/cancel`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: PAYMENT_ID, status: "expired" });
    expect(cancelInFlightFpxServiceMock).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1", userId: "u-admin", role: "admin" }),
      PAYMENT_ID,
    );
  });

  it("manager → 403 (admin required); service not called", async () => {
    const app = await buildApp(manager);
    const res = await app.request(`/fpx/${PAYMENT_ID}/cancel`, { method: "POST" });
    expect(res.status).toBe(403);
    expect(cancelInFlightFpxServiceMock).not.toHaveBeenCalled();
  });

  it("flag OFF → 404 (service not called)", async () => {
    delete process.env.ENABLE_PHASE2_FPX;
    const app = await buildApp(admin);
    const res = await app.request(`/fpx/${PAYMENT_ID}/cancel`, { method: "POST" });
    expect(res.status).toBe(404);
    expect(cancelInFlightFpxServiceMock).not.toHaveBeenCalled();
  });

  it("non-uuid id → 400 (service not called)", async () => {
    const app = await buildApp(admin);
    const res = await app.request("/fpx/not-a-uuid/cancel", { method: "POST" });
    expect(res.status).toBe(400);
    expect(cancelInFlightFpxServiceMock).not.toHaveBeenCalled();
  });

  it("service 400 (not in-flight) → 400 passthrough", async () => {
    cancelInFlightFpxServiceMock.mockResolvedValue({ ok: false, status: 400, error: "Only an in-flight FPX payment can be cancelled (was posted/success)." });
    const app = await buildApp(admin);
    const res = await app.request(`/fpx/${PAYMENT_ID}/cancel`, { method: "POST" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/in-flight FPX/);
  });

  it("service 404 (missing) → 404 passthrough", async () => {
    cancelInFlightFpxServiceMock.mockResolvedValue({ ok: false, status: 404, error: "Payment not found" });
    const app = await buildApp(admin);
    const res = await app.request(`/fpx/${PAYMENT_ID}/cancel`, { method: "POST" });
    expect(res.status).toBe(404);
  });
});
