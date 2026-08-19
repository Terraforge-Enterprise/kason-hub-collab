// Route/handler wiring for POST /billing-documents/:id/void (Phase 4.1).
// Mirrors charge-adjustment-route.test.ts's isolated-handler style: this route
// reuses chargeAdjustmentsFlagGate (both ENABLE_PHASE2_BILLING_DOCS AND
// ENABLE_PHASE2_INVOICE_ADJUSTMENTS gates) + requireWorkspace("accounting").
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";

vi.mock("../charge-adjustment-void.service", () => ({ voidChargeAdjustmentService: vi.fn() }));

import type { SessionPayload } from "../../../lib/auth";
import { billingDocumentsRoutes } from "../routes";
import { voidChargeAdjustmentService as svc } from "../charge-adjustment-void.service";

const voidChargeAdjustmentService = svc as unknown as ReturnType<typeof vi.fn>;

function makeApp(session: SessionPayload | null) {
  const app = new Hono<{ Variables: { session: SessionPayload } }>();
  app.use("*", async (c, next) => {
    if (session) c.set("session", session);
    await next();
  });
  app.route("/", billingDocumentsRoutes);
  return app;
}

const manager: SessionPayload = { userId: "u1", orgId: "o1", role: "manager", userType: "operator" };
const editor: SessionPayload = { userId: "u2", orgId: "o1", role: "editor", userType: "operator" };
const noteId = randomUUID();

const body = { reason: "test" };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ENABLE_PHASE2_BILLING_DOCS = "1";
  process.env.ENABLE_PHASE2_INVOICE_ADJUSTMENTS = "1";
});

describe("POST /:id/void route", () => {
  it("canonical 404 while ENABLE_PHASE2_INVOICE_ADJUSTMENTS is dark, even with the module flag ON and a manager session", async () => {
    delete process.env.ENABLE_PHASE2_INVOICE_ADJUSTMENTS;
    const res = await makeApp(manager).request(`/${noteId}/void`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(voidChargeAdjustmentService).not.toHaveBeenCalled();
  });

  it("canonical 404 while the MODULE flag (ENABLE_PHASE2_BILLING_DOCS) is dark, even with this route's flag ON", async () => {
    delete process.env.ENABLE_PHASE2_BILLING_DOCS;
    const res = await makeApp(manager).request(`/${noteId}/void`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    expect(res.status).toBe(404);
    expect(voidChargeAdjustmentService).not.toHaveBeenCalled();
  });

  it("200s and returns service data on success", async () => {
    voidChargeAdjustmentService.mockResolvedValue({
      ok: true, status: 200, data: { id: noteId, documentStatus: "CANCELLED" },
    });
    const res = await makeApp(manager).request(`/${noteId}/void`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id: noteId, documentStatus: "CANCELLED" } });
    expect(voidChargeAdjustmentService).toHaveBeenCalledWith(
      { orgId: "o1", userId: "u1", role: "manager" },
      noteId,
      { reason: "test" },
    );
  });

  it("400s on Zod validation failure (missing reason) without calling the service", async () => {
    const res = await makeApp(manager).request(`/${noteId}/void`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(voidChargeAdjustmentService).not.toHaveBeenCalled();
  });

  it("maps a service rejection (409 NOTE_HAS_DOWNSTREAM_SETTLEMENTS) straight through", async () => {
    voidChargeAdjustmentService.mockResolvedValue({ ok: false, status: 409, error: "NOTE_HAS_DOWNSTREAM_SETTLEMENTS" });
    const res = await makeApp(manager).request(`/${noteId}/void`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "NOTE_HAS_DOWNSTREAM_SETTLEMENTS" });
  });

  it("rejects an editor (accounting workspace required)", async () => {
    const res = await makeApp(editor).request(`/${noteId}/void`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    expect(res.status).toBe(403);
    expect(voidChargeAdjustmentService).not.toHaveBeenCalled();
  });
});

describe("ACCOUNTING_ALLOW grants the void route", () => {
  it("matches POST /api/billing-documents/:id/void", async () => {
    const { ACCOUNTING_ALLOW } = await import("../../../middleware/accountant-scope");
    const allowed = ACCOUNTING_ALLOW.some(
      (r) => r.method === "POST" && r.test(`/api/billing-documents/${noteId}/void`),
    );
    expect(allowed).toBe(true);
  });

  it("does not grant an unrelated /void-shaped path (e.g. a fake nested route)", async () => {
    const { ACCOUNTING_ALLOW } = await import("../../../middleware/accountant-scope");
    const allowed = ACCOUNTING_ALLOW.some(
      (r) => r.method === "POST" && r.test(`/api/billing-documents/${noteId}/void/extra`),
    );
    expect(allowed).toBe(false);
  });
});
