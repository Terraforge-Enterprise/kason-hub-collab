/**
 * FIX 1 (review wave A1) — by-id admin mutation endpoints reject an in-flight FPX payment.
 *
 * A tenant FPX payment is created status "pending_approval" + gatewayStatus
 * "pending" and settles ONLY via the signed gateway callback (which calls
 * postPaymentService DIRECTLY, never through these HTTP routes). If a manager could
 * manually post / allocate / allocate-batch / change-status an in-flight FPX
 * payment here, the charges would settle before the bank confirms — and a later
 * FAILED callback would then be swallowed by the idempotency fast-path → phantom
 * collection. So all four by-id admin mutation endpoints reject a gatewayStatus
 * "pending" payment with 409 and never call the service.
 *
 * The guard lives ONLY in the HTTP route handlers — NOT in the services — because
 * the FPX callback settles THROUGH postPaymentService while gatewayStatus is still
 * "pending" (proven by fpx-callback.integration.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { SessionPayload } from "../../../lib/auth";

const {
  postPaymentServiceMock,
  allocatePaymentServiceMock,
  allocatePaymentBatchServiceMock,
  updatePaymentStatusServiceMock,
  findPaymentGatewayStatusMock,
} = vi.hoisted(() => ({
  postPaymentServiceMock: vi.fn(),
  allocatePaymentServiceMock: vi.fn(),
  allocatePaymentBatchServiceMock: vi.fn(),
  updatePaymentStatusServiceMock: vi.fn(),
  findPaymentGatewayStatusMock: vi.fn(),
}));

vi.mock("../payments.service", () => ({
  getPaymentsService: vi.fn(),
  createPaymentService: vi.fn(),
  allocatePaymentService: allocatePaymentServiceMock,
  updatePaymentStatusService: updatePaymentStatusServiceMock,
  allocatePaymentBatchService: allocatePaymentBatchServiceMock,
  postPaymentService: postPaymentServiceMock,
  reverseAllocationService: vi.fn(),
}));

vi.mock("../payments.repository", () => ({
  findPaymentGatewayStatus: findPaymentGatewayStatusMock,
}));

type App = Hono<{ Variables: { session: SessionPayload } }>;

function makeApp(session: SessionPayload | null): App {
  const app = new Hono<{ Variables: { session: SessionPayload } }>();
  app.use("*", async (c, next) => {
    if (session) c.set("session", session);
    await next();
  });
  return app;
}

const manager: SessionPayload = { userId: "u2", orgId: "o1", role: "manager", userType: "operator" };

const PAYMENT_ID = "11111111-1111-4111-8111-111111111111";
const CHARGE_ID = "22222222-2222-4222-8222-222222222222";
const IDEM_KEY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const jsonHeaders = { "Content-Type": "application/json" };

const IN_FLIGHT_ERROR =
  "This payment is an in-flight FPX transaction; it settles automatically via the gateway and cannot be actioned manually.";

async function buildApp(session: SessionPayload | null): Promise<App> {
  process.env.ENABLE_PHASE2_MULTI_PAY = "true";
  vi.resetModules();
  const { paymentsRoutes } = await import("../payments.routes");
  const app = makeApp(session);
  app.route("/", paymentsRoutes);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ENABLE_PHASE2_MULTI_PAY = "true";
});

// The four by-id admin mutation endpoints, each with a request body that passes Zod.
const endpoints = [
  {
    name: "POST /:paymentId/post",
    service: postPaymentServiceMock,
    request: (app: App) => app.request(`/${PAYMENT_ID}/post`, { method: "POST" }),
    okResult: { ok: true, status: 200, data: { id: PAYMENT_ID, status: "posted" } },
    okHttpStatus: 200,
  },
  {
    name: "POST /:paymentId/allocate",
    service: allocatePaymentServiceMock,
    request: (app: App) =>
      app.request(`/${PAYMENT_ID}/allocate`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ chargeId: CHARGE_ID, allocatedAmount: "100.00" }),
      }),
    okResult: { ok: true, status: 201, data: { id: "alloc-1" } },
    okHttpStatus: 201,
  },
  {
    name: "POST /:paymentId/allocate-batch",
    service: allocatePaymentBatchServiceMock,
    request: (app: App) =>
      app.request(`/${PAYMENT_ID}/allocate-batch`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ idempotencyKey: IDEM_KEY, allocations: [{ chargeId: CHARGE_ID, allocatedAmount: "100.00" }] }),
      }),
    okResult: { ok: true, status: 201, data: { id: PAYMENT_ID, allocations: [] } },
    okHttpStatus: 201,
  },
  {
    name: "PUT /:paymentId/status",
    service: updatePaymentStatusServiceMock,
    request: (app: App) =>
      app.request(`/${PAYMENT_ID}/status`, {
        method: "PUT",
        headers: jsonHeaders,
        body: JSON.stringify({ status: "void" }),
      }),
    okResult: { ok: true, status: 200, data: { id: PAYMENT_ID } },
    okHttpStatus: 200,
  },
] as const;

describe("by-id admin mutation endpoints — in-flight FPX guard (FIX 1)", () => {
  for (const ep of endpoints) {
    describe(ep.name, () => {
      it("rejects an in-flight FPX payment (gatewayStatus 'pending') with 409 and never calls the service", async () => {
        findPaymentGatewayStatusMock.mockResolvedValue({ id: PAYMENT_ID, gatewayStatus: "pending" });
        const app = await buildApp(manager);
        const res = await ep.request(app);
        expect(res.status).toBe(409);
        expect(await res.json()).toMatchObject({ error: IN_FLIGHT_ERROR });
        expect(ep.service).not.toHaveBeenCalled();
      });

      it("proceeds normally for a manual pending_approval payment (gatewayStatus null)", async () => {
        findPaymentGatewayStatusMock.mockResolvedValue({ id: PAYMENT_ID, gatewayStatus: null });
        ep.service.mockResolvedValueOnce(ep.okResult);
        const app = await buildApp(manager);
        const res = await ep.request(app);
        expect(res.status).toBe(ep.okHttpStatus);
        expect(ep.service).toHaveBeenCalledOnce();
      });

      it("proceeds normally for an already-settled FPX payment (gatewayStatus 'success')", async () => {
        findPaymentGatewayStatusMock.mockResolvedValue({ id: PAYMENT_ID, gatewayStatus: "success" });
        ep.service.mockResolvedValueOnce(ep.okResult);
        const app = await buildApp(manager);
        const res = await ep.request(app);
        expect(res.status).toBe(ep.okHttpStatus);
        expect(ep.service).toHaveBeenCalledOnce();
      });
    });
  }
});
