/**
 * payments.post-routes.test.ts
 * Route-level tests for POST /:paymentId/post.
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
const { postPaymentServiceMock, rejectPaymentServiceMock, findPaymentGatewayStatusMock } = vi.hoisted(() => ({
  postPaymentServiceMock: vi.fn(),
  rejectPaymentServiceMock: vi.fn(),
  findPaymentGatewayStatusMock: vi.fn(),
}));

vi.mock("../payments.service", () => ({
  getPaymentsService: vi.fn(),
  createPaymentService: vi.fn(),
  allocatePaymentService: vi.fn(),
  updatePaymentStatusService: vi.fn(),
  allocatePaymentBatchService: vi.fn(),
  postPaymentService: postPaymentServiceMock,
  // Must be listed: an omitted export resolves to undefined, the route throws
  // on call, and Hono returns 500 — which satisfies a `not.toBe(403)`
  // assertion vacuously, so an RBAC test would pass while proving nothing.
  rejectPaymentService: rejectPaymentServiceMock,
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
const manager: SessionPayload = { userId: "u2", orgId: "o1", role: "manager", userType: "operator" };
const accountant: SessionPayload = { userId: "u3", orgId: "o1", role: "accountant", userType: "operator" };
const viewer: SessionPayload = { userId: "u4", orgId: "o1", role: "viewer", userType: "operator" };

const PAYMENT_ID = "11111111-1111-4111-8111-111111111111";

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
  // Default: not an in-flight FPX payment, so the guard falls through to the service.
  findPaymentGatewayStatusMock.mockResolvedValue({ gatewayStatus: null });
});

// ── Flag gate ─────────────────────────────────────────────────────────────────
describe("POST /:paymentId/post — flag gate", () => {
  it("returns 404 when ENABLE_PHASE2_MULTI_PAY is OFF", async () => {
    process.env.ENABLE_PHASE2_MULTI_PAY = "false";
    vi.resetModules();
    const { paymentsRoutes } = await import("../payments.routes");
    const app = makeApp(manager);
    app.route("/", paymentsRoutes);
    const res = await app.request(`/${PAYMENT_ID}/post`, { method: "POST" });
    expect(res.status).toBe(404);
    expect(postPaymentServiceMock).not.toHaveBeenCalled();
  });
});

// ── RBAC ─────────────────────────────────────────────────────────────────────
// Gate is requireWorkspaceOrRank("accounting", "manager"): the `accounting`
// workspace (admin/manager/accountant) OR rank ≥ manager. These cases pin the
// exact admitted set, because this route settles money — a silent widening here
// would let a role approve cash that the org never intended to.
describe("POST /:paymentId/post — RBAC", () => {
  it("returns 403 for editor (holds `operations`, and rank is below manager)", async () => {
    const app = await buildApp(editor);
    const res = await app.request(`/${PAYMENT_ID}/post`, { method: "POST" });
    expect(res.status).toBe(403);
    expect(postPaymentServiceMock).not.toHaveBeenCalled();
  });

  it("returns 403 for viewer", async () => {
    const app = await buildApp(viewer);
    const res = await app.request(`/${PAYMENT_ID}/post`, { method: "POST" });
    expect(res.status).toBe(403);
    expect(postPaymentServiceMock).not.toHaveBeenCalled();
  });

  // Verifying a tenant's slip against the bank account is the accountant's job.
  // `accountant` is deliberately absent from the RANK ladder, so the older
  // requireRole("manager") 403'd it — leaving them able to read the slip in the
  // verification panel but not act on it.
  it("ADMITS accountant via the accounting workspace", async () => {
    postPaymentServiceMock.mockResolvedValue({ ok: true, status: 200, data: { id: PAYMENT_ID, status: "posted" } });
    const app = await buildApp(accountant);
    const res = await app.request(`/${PAYMENT_ID}/post`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(postPaymentServiceMock).toHaveBeenCalled();
  });

  it("returns 401 when no session is set", async () => {
    const app = await buildApp(null);
    const res = await app.request(`/${PAYMENT_ID}/post`, { method: "POST" });
    expect(res.status).toBe(401);
    expect(postPaymentServiceMock).not.toHaveBeenCalled();
  });
});

// ── RBAC on the reject twin — MUST match /post exactly ───────────────────────
// A reviewer who can approve but not reject is pushed toward approving.
describe("POST /:paymentId/reject — RBAC matches /post", () => {
  const body = JSON.stringify({ reason: "Slip is unreadable" });

  beforeEach(() => {
    rejectPaymentServiceMock.mockResolvedValue({
      ok: true, status: 200, data: { id: PAYMENT_ID, status: "rejected" },
    });
  });

  it("returns 403 for editor", async () => {
    const app = await buildApp(editor);
    const res = await app.request(`/${PAYMENT_ID}/reject`, { method: "POST", body });
    expect(res.status).toBe(403);
    expect(rejectPaymentServiceMock).not.toHaveBeenCalled();
  });

  it("returns 403 for viewer", async () => {
    const app = await buildApp(viewer);
    const res = await app.request(`/${PAYMENT_ID}/reject`, { method: "POST", body });
    expect(res.status).toBe(403);
    expect(rejectPaymentServiceMock).not.toHaveBeenCalled();
  });

  it("ADMITS accountant", async () => {
    const app = await buildApp(accountant);
    const res = await app.request(`/${PAYMENT_ID}/reject`, { method: "POST", body });
    expect(res.status).toBe(200);
    expect(rejectPaymentServiceMock).toHaveBeenCalled();
  });

  it("ADMITS manager", async () => {
    const app = await buildApp(manager);
    const res = await app.request(`/${PAYMENT_ID}/reject`, { method: "POST", body });
    expect(res.status).toBe(200);
    expect(rejectPaymentServiceMock).toHaveBeenCalled();
  });

  it("returns 401 when no session is set", async () => {
    const app = await buildApp(null);
    const res = await app.request(`/${PAYMENT_ID}/reject`, { method: "POST", body });
    expect(res.status).toBe(401);
  });
});

// ── Status passthrough ────────────────────────────────────────────────────────
describe("POST /:paymentId/post — service status passthrough", () => {
  it("returns 200 when service returns ok=true (manager posts)", async () => {
    postPaymentServiceMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { id: PAYMENT_ID, status: "posted" },
    });
    const app = await buildApp(manager);
    const res = await app.request(`/${PAYMENT_ID}/post`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: PAYMENT_ID, status: "posted" });
    expect(postPaymentServiceMock).toHaveBeenCalledOnce();
  });

  it("returns 404 when service returns ok=false, status=404", async () => {
    postPaymentServiceMock.mockResolvedValueOnce({ ok: false, status: 404, error: "Payment not found" });
    const app = await buildApp(manager);
    const res = await app.request(`/${PAYMENT_ID}/post`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("returns 400 when service returns ok=false, status=400", async () => {
    postPaymentServiceMock.mockResolvedValueOnce({ ok: false, status: 400, error: "Only pending_approval payments can be posted (was posted)" });
    const app = await buildApp(manager);
    const res = await app.request(`/${PAYMENT_ID}/post`, { method: "POST" });
    expect(res.status).toBe(400);
  });

  it("returns 409 when service returns ok=false, status=409 (stale)", async () => {
    postPaymentServiceMock.mockResolvedValueOnce({ ok: false, status: 409, error: "Changed since you loaded it. Refresh and retry." });
    const app = await buildApp(manager);
    const res = await app.request(`/${PAYMENT_ID}/post`, { method: "POST" });
    expect(res.status).toBe(409);
  });
});

// ── Zod validation ────────────────────────────────────────────────────────────
describe("POST /:paymentId/post — Zod validation", () => {
  it("returns 400 for invalid paymentId (not a uuid) in URL param", async () => {
    const app = await buildApp(manager);
    const res = await app.request(`/not-a-uuid/post`, { method: "POST" });
    expect(res.status).toBe(400);
    expect(postPaymentServiceMock).not.toHaveBeenCalled();
  });
});
