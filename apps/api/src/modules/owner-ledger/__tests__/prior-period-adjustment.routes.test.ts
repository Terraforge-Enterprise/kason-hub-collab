/**
 * R4 — PPA admin route contract (POST /owner-ledger/prior-period-adjustments).
 *
 * Route-level, DB-free: the PPA service is mocked so we assert ONLY the HTTP contract —
 * flag-dark 404 (before auth, service never called), admin-only RBAC (401/403), the
 * source-union 400, the closed-period 409 pass-through, and a 201 on success.
 *
 * The module-level ownerLedgerFlagGate gates on ENABLE_PHASE2_OWNER_BILLING, so that is
 * forced ON here; ENABLE_PHASE2_PRIOR_PERIOD_ADJUSTMENT is toggled per test.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { Hono } from "hono";
import type { SessionPayload } from "../../../lib/auth";

vi.mock("../prior-period-adjustment", () => ({
  createPriorPeriodAdjustment: vi.fn(),
}));

import { ownerLedgerRoutes } from "../owner-ledger.routes";
import { createPriorPeriodAdjustment } from "../prior-period-adjustment";

const ppaMock = vi.mocked(createPriorPeriodAdjustment);

function makeApp(session: SessionPayload | null) {
  const app = new Hono<{ Variables: { session: SessionPayload } }>();
  app.use("*", async (c, next) => {
    if (session) c.set("session", session);
    await next();
  });
  app.route("/", ownerLedgerRoutes);
  return app;
}

const OWNER = "11111111-1111-4111-8111-111111111111";
const UNIT = "22222222-2222-4222-8222-222222222222";
const TENANT = "33333333-3333-4333-8333-333333333333";

const adminSession: SessionPayload = { userId: "u1", orgId: "o1", role: "admin", userType: "operator" };
const managerSession: SessionPayload = { userId: "u2", orgId: "o1", role: "manager", userType: "operator" };

const validBody = {
  ownerPartyId: OWNER,
  originalBillingMonth: "2026-05",
  sourceChargeInput: { unitId: UNIT, partyId: TENANT, chargeType: "rent", amount: "800.00" },
};

function post(app: ReturnType<typeof makeApp>, body: unknown) {
  return app.request("/prior-period-adjustments", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

let savedBilling: string | undefined;
let savedPpa: string | undefined;

describe("POST /owner-ledger/prior-period-adjustments — admin route contract (R4)", () => {
  beforeAll(() => {
    savedBilling = process.env.ENABLE_PHASE2_OWNER_BILLING;
    savedPpa = process.env.ENABLE_PHASE2_PRIOR_PERIOD_ADJUSTMENT;
    process.env.ENABLE_PHASE2_OWNER_BILLING = "1"; // module gate open
  });
  afterAll(() => {
    if (savedBilling === undefined) delete process.env.ENABLE_PHASE2_OWNER_BILLING;
    else process.env.ENABLE_PHASE2_OWNER_BILLING = savedBilling;
    if (savedPpa === undefined) delete process.env.ENABLE_PHASE2_PRIOR_PERIOD_ADJUSTMENT;
    else process.env.ENABLE_PHASE2_PRIOR_PERIOD_ADJUSTMENT = savedPpa;
  });
  beforeEach(() => {
    ppaMock.mockReset();
    delete process.env.ENABLE_PHASE2_PRIOR_PERIOD_ADJUSTMENT;
  });

  it("RB1: PPA flag OFF → 404 (before auth) and the service is never called", async () => {
    // flag unset by beforeEach
    const res = await post(makeApp(adminSession), validBody);
    expect(res.status).toBe(404);
    expect(ppaMock).not.toHaveBeenCalled();
  });

  it("RB2: flag ON + admin + valid create-mode body → 201; service called with the parsed input", async () => {
    process.env.ENABLE_PHASE2_PRIOR_PERIOD_ADJUSTMENT = "1";
    ppaMock.mockResolvedValue({
      ok: true,
      status: 201,
      data: { charge: { id: "c1", billingMonth: "2026-05" }, ledgerEntry: { id: "l1" } as never, idempotentReplay: false },
    });
    const res = await post(makeApp(adminSession), validBody);
    expect(res.status).toBe(201);
    expect(ppaMock).toHaveBeenCalledTimes(1);
    expect(ppaMock.mock.calls[0]![1]).toMatchObject({
      ownerPartyId: OWNER,
      originalBillingMonth: "2026-05",
      sourceChargeInput: { unitId: UNIT, chargeType: "rent", amount: "800.00" },
    });
  });

  it("RB3: flag ON + manager (non-admin) → 403; service not called", async () => {
    process.env.ENABLE_PHASE2_PRIOR_PERIOD_ADJUSTMENT = "1";
    const res = await post(makeApp(managerSession), validBody);
    expect(res.status).toBe(403);
    expect(ppaMock).not.toHaveBeenCalled();
  });

  it("RB4: flag ON + admin + service closed_period → 409 with the structured body", async () => {
    process.env.ENABLE_PHASE2_PRIOR_PERIOD_ADJUSTMENT = "1";
    ppaMock.mockResolvedValue({
      ok: false,
      status: 409,
      error: "closed_period",
      body: { code: "closed_period", originalBillingMonth: "2026-05", currentOpenMonth: "2026-07", priorPeriodAdjustmentSupported: true, suggestedPostingMonth: "2026-07" },
    });
    const res = await post(makeApp(adminSession), validBody);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "closed_period", priorPeriodAdjustmentSupported: true });
  });

  it("RB5: flag ON + admin + neither sourceChargeId nor sourceChargeInput → 400; service not called", async () => {
    process.env.ENABLE_PHASE2_PRIOR_PERIOD_ADJUSTMENT = "1";
    const res = await post(makeApp(adminSession), { ownerPartyId: OWNER, originalBillingMonth: "2026-05" });
    expect(res.status).toBe(400);
    expect(ppaMock).not.toHaveBeenCalled();
  });

  it("RB6: flag ON + no session → 401; service not called", async () => {
    process.env.ENABLE_PHASE2_PRIOR_PERIOD_ADJUSTMENT = "1";
    const res = await post(makeApp(null), validBody);
    expect(res.status).toBe(401);
    expect(ppaMock).not.toHaveBeenCalled();
  });
});
