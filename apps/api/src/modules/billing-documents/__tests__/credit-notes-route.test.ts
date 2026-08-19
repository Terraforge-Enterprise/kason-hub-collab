import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";

// DEVIATION (T5): plan's mock referenced an outer `const` from inside the
// vi.mock factory — vi.mock is hoisted above that declaration, so it throws
// "Cannot access ... before initialization". Reconciled to this codebase's
// established pattern (routes.test.ts): vi.fn() created directly inside the
// factory, the mock imported back out afterward.
vi.mock("../overpayment-cn.service", () => ({ createOverpaymentCreditNoteService: vi.fn() }));

import { createCreditNoteInput } from "@kason/shared";
import { createOverpaymentCreditNoteService as svc } from "../overpayment-cn.service";
import { formatZodError } from "../../../lib/zod-error-mapper";

const createOverpaymentCreditNoteService = svc as unknown as ReturnType<typeof vi.fn>;

// The route handler under test in isolation (mirrors routes.ts wiring so the
// test does not need the full app / flag gate). The real route in routes.ts
// registers the SAME handler behind billingDocsFlagGate + requireWorkspace.
function routeApp() {
  const app = new Hono<{ Variables: { session: { orgId: string; userId: string; role: string } } }>();
  app.use("*", async (c, next) => { c.set("session", { orgId: randomUUID(), userId: randomUUID(), role: "accountant" }); await next(); });
  app.post("/credit-notes", async (c) => {
    const parsed = createCreditNoteInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      const friendly = formatZodError(parsed.error, { domain: "billing" });
      return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
    }
    const session = c.get("session");
    const result = await svc(session, parsed.data);
    if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404 | 409);
    return c.json({ data: result.data }, 201);
  });
  return app;
}

const body = {
  originalDocumentId: randomUUID(), partyId: randomUUID(), counterpartyType: "tenant",
  lines: [{ description: "Overpayment", amount: "50.00" }], reason: "overpaid", idempotencyKey: randomUUID(),
};

beforeEach(() => vi.clearAllMocks());

describe("POST /credit-notes route", () => {
  it("201s and returns service data on success", async () => {
    createOverpaymentCreditNoteService.mockResolvedValue({ ok: true, status: 201, data: { id: "cn1", documentNumber: "CN-0001", creditAmount: "50.00" } });
    const res = await routeApp().request("/credit-notes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ data: { id: "cn1", documentNumber: "CN-0001", creditAmount: "50.00" } });
  });

  it("400s on a missing reason (Zod)", async () => {
    const { reason: _omit, ...bad } = body;
    const res = await routeApp().request("/credit-notes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(bad) });
    expect(res.status).toBe(400);
    expect(createOverpaymentCreditNoteService).not.toHaveBeenCalled();
  });

  it("maps a service ORIGINAL_OFFSET rejection to 400", async () => {
    createOverpaymentCreditNoteService.mockResolvedValue({ ok: false, status: 400, error: "ORIGINAL_OFFSET" });
    const res = await routeApp().request("/credit-notes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "ORIGINAL_OFFSET" });
  });
});

describe("ACCOUNTING_ALLOW grants the CN route", () => {
  it("matches POST /api/billing-documents/credit-notes", async () => {
    const { ACCOUNTING_ALLOW } = await import("../../../middleware/accountant-scope");
    const allowed = ACCOUNTING_ALLOW.some((r) => r.method === "POST" && r.test("/api/billing-documents/credit-notes"));
    expect(allowed).toBe(true);
  });
});
