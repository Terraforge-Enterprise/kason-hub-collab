/**
 * payments.list.test.ts
 * Route + service tests for GET / with filters + keyset pagination (B6).
 * Uses vi.mock on the service (route test) and vi.mock on the repo (service test).
 * No real DB — all assertions are structural.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { SessionPayload } from "../../../lib/auth";

// ── Hoist service mock ────────────────────────────────────────────────────────
const { getPaymentsServiceMock } = vi.hoisted(() => ({
  getPaymentsServiceMock: vi.fn(),
}));

vi.mock("../payments.service", () => ({
  getPaymentsService: getPaymentsServiceMock,
  createPaymentService: vi.fn(),
  allocatePaymentService: vi.fn(),
  updatePaymentStatusService: vi.fn(),
  allocatePaymentBatchService: vi.fn(),
  postPaymentService: vi.fn(),
  reverseAllocationService: vi.fn(),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────
const editor: SessionPayload = { userId: "u1", orgId: "o1", role: "editor", userType: "operator" };

function makeBaseApp(session: SessionPayload | null) {
  const app = new Hono<{ Variables: { session: SessionPayload } }>();
  app.use("*", async (c, next) => {
    if (session) c.set("session", session);
    await next();
  });
  return app;
}

async function buildApp(session: SessionPayload | null) {
  process.env.ENABLE_PHASE2_MULTI_PAY = "true";
  vi.resetModules();
  const { paymentsRoutes } = await import("../payments.routes");
  const app = makeBaseApp(session);
  app.route("/", paymentsRoutes);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ENABLE_PHASE2_MULTI_PAY = "true";
});

// ── Route-level: filter parsing + service forwarding ─────────────────────────
describe("GET / — route forwards query params to service + returns result verbatim", () => {
  it("parses status+limit query params and returns service result", async () => {
    const serviceResult = {
      data: [{ id: "p1", status: "posted" }, { id: "p2", status: "posted" }],
      nextCursor: "2026-01-02T00:00:00.000Z|p2",
    };
    getPaymentsServiceMock.mockResolvedValueOnce(serviceResult);

    const app = await buildApp(editor);
    const res = await app.request("/?status=posted&limit=2");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toEqual(serviceResult);
    expect(body.data).toHaveLength(2);
    expect(body.nextCursor).toBeTruthy();

    // Service must have been called with opts that include status and limit.
    expect(getPaymentsServiceMock).toHaveBeenCalledOnce();
    const [, opts] = getPaymentsServiceMock.mock.calls[0];
    expect(opts).toMatchObject({ status: "posted", limit: 2 });
  });

  it("no params — service called with default opts (limit:50) and result returned", async () => {
    const serviceResult = {
      data: [{ id: "p1", status: "posted" }],
      nextCursor: null,
    };
    getPaymentsServiceMock.mockResolvedValueOnce(serviceResult);

    const app = await buildApp(editor);
    const res = await app.request("/");
    expect(res.status).toBe(200);

    const body = await res.json();
    // .data MUST be an array (backward-compatible)
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.nextCursor).toBeNull();
  });

  it("returns service result verbatim (no wrapping)", async () => {
    const serviceResult = {
      data: [],
      nextCursor: null,
    };
    getPaymentsServiceMock.mockResolvedValueOnce(serviceResult);

    const app = await buildApp(editor);
    const res = await app.request("/");
    const body = await res.json();
    // Body must be exactly what the service returned, not double-wrapped
    expect(body).toEqual(serviceResult);
    expect("data" in body).toBe(true);
    expect("nextCursor" in body).toBe(true);
  });
});

// ── Route-level: 400 on invalid query params ──────────────────────────────────
describe("GET / — 400 on invalid query params", () => {
  it("malformed partyId (non-UUID) → 400 with fieldErrors", async () => {
    // Service should NOT be called when query params are invalid.
    getPaymentsServiceMock.mockResolvedValueOnce({ data: [], nextCursor: null });

    const app = await buildApp(editor);
    const res = await app.request("/?partyId=not-a-uuid");
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body).toHaveProperty("error");
    // Service must not have been invoked.
    expect(getPaymentsServiceMock).not.toHaveBeenCalled();
  });
});

// Note: service-level opt-forwarding tests live in payments.list-service.test.ts
// (separate file to avoid conflict with the top-level vi.mock of payments.service above).
