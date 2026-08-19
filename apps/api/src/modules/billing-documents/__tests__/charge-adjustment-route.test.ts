// Route/handler wiring for POST /billing-documents/charge-adjustments (Phase 3.1).
// Mirrors credit-notes-route.test.ts's isolated-handler style + routes.test.ts's
// full-router flag-gate style: this route needs BOTH the module-wide
// ENABLE_PHASE2_BILLING_DOCS gate AND its own ENABLE_PHASE2_INVOICE_ADJUSTMENTS gate.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";

vi.mock("../charge-adjustment.service", () => ({ createChargeAdjustmentService: vi.fn() }));

import type { SessionPayload } from "../../../lib/auth";
import { billingDocumentsRoutes } from "../routes";
import { createChargeAdjustmentService as svc } from "../charge-adjustment.service";

const createChargeAdjustmentService = svc as unknown as ReturnType<typeof vi.fn>;

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

const body = { chargeId: randomUUID(), kind: "debit" as const, amount: "50.00", reason: "test" };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ENABLE_PHASE2_BILLING_DOCS = "1";
  process.env.ENABLE_PHASE2_INVOICE_ADJUSTMENTS = "1";
});

describe("POST /charge-adjustments route", () => {
  it("canonical 404 while ENABLE_PHASE2_INVOICE_ADJUSTMENTS is dark, even with the module flag ON and a manager session", async () => {
    delete process.env.ENABLE_PHASE2_INVOICE_ADJUSTMENTS;
    const res = await makeApp(manager).request("/charge-adjustments", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(createChargeAdjustmentService).not.toHaveBeenCalled();
  });

  it("canonical 404 while the MODULE flag (ENABLE_PHASE2_BILLING_DOCS) is dark, even with this route's flag ON", async () => {
    delete process.env.ENABLE_PHASE2_BILLING_DOCS;
    const res = await makeApp(manager).request("/charge-adjustments", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    expect(res.status).toBe(404);
    expect(createChargeAdjustmentService).not.toHaveBeenCalled();
  });

  it("201s and returns service data on success", async () => {
    createChargeAdjustmentService.mockResolvedValue({
      ok: true, status: 201, data: { id: "dn1", documentNumber: "DN-0001", docType: "debit_note" },
    });
    const res = await makeApp(manager).request("/charge-adjustments", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ data: { id: "dn1", documentNumber: "DN-0001", docType: "debit_note" } });
  });

  it("400s on Zod validation failure (missing reason) without calling the service", async () => {
    const { reason: _omit, ...bad } = body;
    const res = await makeApp(manager).request("/charge-adjustments", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(bad),
    });
    expect(res.status).toBe(400);
    expect(createChargeAdjustmentService).not.toHaveBeenCalled();
  });

  it("maps a service rejection (403 OWNER_ADJUSTMENT_NOT_SUPPORTED) straight through", async () => {
    createChargeAdjustmentService.mockResolvedValue({ ok: false, status: 403, error: "OWNER_ADJUSTMENT_NOT_SUPPORTED" });
    const res = await makeApp(manager).request("/charge-adjustments", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "OWNER_ADJUSTMENT_NOT_SUPPORTED" });
  });

  it("rejects an editor (accounting workspace required)", async () => {
    const res = await makeApp(editor).request("/charge-adjustments", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    expect(res.status).toBe(403);
    expect(createChargeAdjustmentService).not.toHaveBeenCalled();
  });
});

describe("ACCOUNTING_ALLOW grants the charge-adjustments route", () => {
  it("matches POST /api/billing-documents/charge-adjustments", async () => {
    const { ACCOUNTING_ALLOW } = await import("../../../middleware/accountant-scope");
    const allowed = ACCOUNTING_ALLOW.some((r) => r.method === "POST" && r.test("/api/billing-documents/charge-adjustments"));
    expect(allowed).toBe(true);
  });
});
