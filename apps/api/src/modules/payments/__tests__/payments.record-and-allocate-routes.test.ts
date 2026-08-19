/**
 * payments.record-and-allocate-routes.test.ts
 * Route-level test for POST /record-and-allocate — Spec2 R9: the 409
 * DUPLICATE_PAYMENT response body must forward existingPaymentId (mirrors
 * billing.routes.ts's existingChargeId forwarding for DUPLICATE_CHARGE).
 *
 * Mirrors payments.batch-routes.test.ts's harness (mock the service module,
 * build a Hono app, POST, assert the PARSED JSON response body). Kept in its
 * own file: this harness needs payments.service FULLY mocked, which cannot
 * coexist in one test file with payment-dedup.test.ts's real-service /
 * mocked-repository setup for that same module path.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { SessionPayload } from "../../../lib/auth";

const { recordAndAllocatePaymentServiceMock } = vi.hoisted(() => ({
  recordAndAllocatePaymentServiceMock: vi.fn(),
}));

vi.mock("../payments.service", () => ({
  getPaymentsService: vi.fn(),
  getPaymentsSummaryService: vi.fn(),
  createPaymentService: vi.fn(),
  allocatePaymentService: vi.fn(),
  updatePaymentStatusService: vi.fn(),
  allocatePaymentBatchService: vi.fn(),
  reverseAllocationService: vi.fn(),
  postPaymentService: vi.fn(),
  listInFlightFpxService: vi.fn(),
  cancelInFlightFpxService: vi.fn(),
  recordAndAllocatePaymentService: recordAndAllocatePaymentServiceMock,
}));

function makeApp(session: SessionPayload | null) {
  const app = new Hono<{ Variables: { session: SessionPayload } }>();
  app.use("*", async (c, next) => {
    if (session) c.set("session", session);
    await next();
  });
  return app;
}

// P3 T2: record-and-allocate is gated by requireWorkspace("accounting"); editor
// (operations-only) is no longer admitted here — use a manager session (also in
// the accounting workspace) to keep testing the 409-forwarding behavior.
const editor: SessionPayload = { userId: "u1", orgId: "o1", role: "manager", userType: "operator" };

const validBody = JSON.stringify({
  paymentNumber: "PAY-1",
  partyId: "44444444-4444-4444-8444-444444444444",
  paymentType: "rental_payment",
  paymentMethod: "bank_transfer",
  receivedAt: "2026-07-06T10:00:00.000Z",
  idempotencyKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  allocations: [{ chargeId: "22222222-2222-4222-8222-222222222222", allocatedAmount: "321.50" }],
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
  process.env.ENABLE_PHASE2_MULTI_PAY = "true";
});

describe("POST /record-and-allocate — 409 body (Spec2 R9)", () => {
  it("forwards existingPaymentId in the 409 response body for a duplicate payment", async () => {
    recordAndAllocatePaymentServiceMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      error: "DUPLICATE_PAYMENT",
      existingPaymentId: "11111111-1111-4111-8111-111111111111",
    });
    const app = await buildApp(editor);

    const res = await app.request("/record-and-allocate", { method: "POST", headers: jsonHeaders, body: validBody });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body).toEqual({
      error: "DUPLICATE_PAYMENT",
      existingPaymentId: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("does not leak existingPaymentId for a non-duplicate error", async () => {
    recordAndAllocatePaymentServiceMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      error: "Payment number already exists",
    });
    const app = await buildApp(editor);

    const res = await app.request("/record-and-allocate", { method: "POST", headers: jsonHeaders, body: validBody });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body).toEqual({ error: "Payment number already exists" });
    expect(Object.keys(body)).toEqual(["error"]);
  });
});
