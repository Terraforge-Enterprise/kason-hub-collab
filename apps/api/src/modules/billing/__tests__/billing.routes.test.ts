import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { BillingSession } from "../billing.types";

// Route tested in isolation — service layer mocked, DB never reached.
vi.mock("../billing.service", () => ({
  getChargesService: vi.fn(),
  createChargeService: vi.fn(),
  postChargeService: vi.fn(),
  voidChargeService: vi.fn(),
  getChargeByIdService: vi.fn(),
}));

import { billingRoutes } from "../billing.routes";
import {
  getChargesService,
  createChargeService,
  postChargeService,
  voidChargeService,
  getChargeByIdService,
} from "../billing.service";

const session: BillingSession = { userId: "u1", orgId: "org-1", role: "admin" };

function sessionAs(role: string): BillingSession {
  return { userId: "u1", orgId: "org-1", role };
}

function makeApp(overrideSession: BillingSession = session) {
  const app = new Hono<{ Variables: { session: BillingSession } }>();
  app.use("*", async (c, next) => {
    c.set("session", overrideSession);
    await next();
  });
  app.route("/", billingRoutes);
  return app;
}

function get(path: string, overrideSession: BillingSession = session) {
  return makeApp(overrideSession).request(path);
}

function post(path: string, body: unknown, overrideSession: BillingSession) {
  return makeApp(overrideSession).request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// Valid create-charge payload — shared by the dup-body and gate test suites
// below, both of which POST /charges and need Zod to pass before reaching
// the mocked service.
const validCreateBody = {
  chargeNumber: "CH-0001",
  partyId: "22222222-2222-4222-8222-222222222222",
  chargeType: "rent",
  dueDate: "2026-08-01",
  amount: "500.00",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /charges — spec §4.8 pagination gap", () => {
  it("no query params → calls the service with pagination=undefined, response shape unchanged ({ data: [...] }, no total)", async () => {
    const fullList = [{ id: "c1" }, { id: "c2" }];
    vi.mocked(getChargesService).mockResolvedValueOnce({ data: fullList } as never);

    const res = await get("/charges");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ data: fullList });
    // filters is an empty object (not undefined) — the route always spreads the
    // rest of parsed.data, which is {} when no filter query params are sent.
    expect(getChargesService).toHaveBeenCalledWith(session, undefined, {});
  });

  it("?page=2&pageSize=25 → paginated, defaults filled for the missing param, response includes total", async () => {
    vi.mocked(getChargesService).mockResolvedValueOnce({ data: [{ id: "c26" }], total: 137 } as never);

    const res = await get("/charges?page=2&pageSize=25");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ data: [{ id: "c26" }], total: 137 });
    expect(getChargesService).toHaveBeenCalledWith(session, { page: 2, pageSize: 25 }, {});
  });

  it("only ?page= present → pageSize defaults to 25", async () => {
    vi.mocked(getChargesService).mockResolvedValueOnce({ data: [], total: 0 } as never);

    await get("/charges?page=3");

    expect(getChargesService).toHaveBeenCalledWith(session, { page: 3, pageSize: 25 }, {});
  });

  it("only ?pageSize= present → page defaults to 1", async () => {
    vi.mocked(getChargesService).mockResolvedValueOnce({ data: [], total: 0 } as never);

    await get("/charges?pageSize=10");

    expect(getChargesService).toHaveBeenCalledWith(session, { page: 1, pageSize: 10 }, {});
  });

  it("pageSize above 100 → 400, service never called", async () => {
    const res = await get("/charges?pageSize=101");

    expect(res.status).toBe(400);
    expect(getChargesService).not.toHaveBeenCalled();
  });

  it("page=0 → 400, service never called", async () => {
    const res = await get("/charges?page=0");

    expect(res.status).toBe(400);
    expect(getChargesService).not.toHaveBeenCalled();
  });

  it("non-numeric page → 400", async () => {
    const res = await get("/charges?page=abc");

    expect(res.status).toBe(400);
    expect(getChargesService).not.toHaveBeenCalled();
  });
});

describe("POST /charges — admin only (now admin+manager) gate (Spec2 R7)", () => {
  beforeEach(() => {
    vi.mocked(createChargeService).mockResolvedValue({
      ok: true,
      status: 201,
      data: { id: "c1" },
    } as never);
  });

  it("allows admin to create a charge", async () => {
    const res = await post("/charges", validCreateBody, sessionAs("admin"));

    expect(res.status).not.toBe(403);
    expect(res.status).toBe(201);
  });

  it("allows manager to create a charge", async () => {
    const res = await post("/charges", validCreateBody, sessionAs("manager"));

    expect(res.status).not.toBe(403);
    expect(res.status).toBe(201);
  });

  it("blocks operator from creating a charge", async () => {
    const res = await post("/charges", validCreateBody, sessionAs("operator"));
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body).toEqual({ error: "Admin or manager only" });
    expect(createChargeService).not.toHaveBeenCalled();
  });

  it("blocks viewer from creating a charge", async () => {
    const res = await post("/charges", validCreateBody, sessionAs("viewer"));
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body).toEqual({ error: "Admin or manager only" });
    expect(createChargeService).not.toHaveBeenCalled();
  });

  it("blocks an unrecognized role value (default-deny)", async () => {
    const res = await post("/charges", validCreateBody, sessionAs(""));

    expect(res.status).toBe(403);
    expect(createChargeService).not.toHaveBeenCalled();
  });

  it("blocks operator before attempting to parse the request body", async () => {
    const res = await makeApp(sessionAs("operator")).request("/charges", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not-valid-json",
    });

    // Check status BEFORE parsing the body: if the gate ever stops
    // short-circuiting ahead of `c.req.json()`, the malformed body would
    // make an old/regressed route throw and fall through to Hono's default
    // plain-text 500 — asserting status first keeps this a clean assertion
    // failure instead of a JSON-parse crash either way.
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual({ error: "Admin or manager only" });
    expect(createChargeService).not.toHaveBeenCalled();
  });
});

describe("POST /charges — dup body (Spec2 R1)", () => {
  it("forwards existingChargeId in the 409 response body for a duplicate charge", async () => {
    vi.mocked(createChargeService).mockResolvedValueOnce({
      ok: false,
      status: 409,
      error: "DUPLICATE_CHARGE",
      existingChargeId: "11111111-1111-4111-8111-111111111111",
    } as never);

    const res = await post("/charges", validCreateBody, sessionAs("admin"));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body).toEqual({
      error: "DUPLICATE_CHARGE",
      existingChargeId: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("omits the existingChargeId key when the service does not return one", async () => {
    vi.mocked(createChargeService).mockResolvedValueOnce({
      ok: false,
      status: 409,
      error: "DUPLICATE_CHARGE",
    } as never);

    const res = await post("/charges", validCreateBody, sessionAs("admin"));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body).toEqual({ error: "DUPLICATE_CHARGE" });
    expect(Object.keys(body)).toEqual(["error"]);
  });

  it("does not leak existingChargeId for a non-duplicate error", async () => {
    vi.mocked(createChargeService).mockResolvedValueOnce({
      ok: false,
      status: 409,
      error: "Charge number already exists",
    } as never);

    const res = await post("/charges", validCreateBody, sessionAs("admin"));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body).toEqual({ error: "Charge number already exists" });
  });
});

describe("POST /charges/:chargeId/post — admin only (now admin+manager) gate (Spec2 R7)", () => {
  const chargeId = "33333333-3333-4333-8333-333333333333";

  beforeEach(() => {
    vi.mocked(postChargeService).mockResolvedValue({
      ok: true,
      status: 200,
      data: { id: chargeId },
    } as never);
  });

  it("allows manager to post a charge", async () => {
    const res = await post(`/charges/${chargeId}/post`, undefined, sessionAs("manager"));

    expect(res.status).not.toBe(403);
  });

  it("blocks operator from posting a charge", async () => {
    const res = await post(`/charges/${chargeId}/post`, undefined, sessionAs("operator"));
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body).toEqual({ error: "Admin or manager only" });
    expect(postChargeService).not.toHaveBeenCalled();
  });
});

describe("POST /charges/:chargeId/void — admin only (now admin+manager) gate (Spec2 R7)", () => {
  const chargeId = "33333333-3333-4333-8333-333333333333";
  const validVoidBody = { reason: "duplicate entry" };

  beforeEach(() => {
    vi.mocked(voidChargeService).mockResolvedValue({
      ok: true,
      status: 200,
      data: { id: chargeId },
    } as never);
  });

  it("allows manager to void a charge", async () => {
    const res = await post(`/charges/${chargeId}/void`, validVoidBody, sessionAs("manager"));

    expect(res.status).not.toBe(403);
  });

  it("blocks operator from voiding a charge", async () => {
    const res = await post(`/charges/${chargeId}/void`, validVoidBody, sessionAs("operator"));
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body).toEqual({ error: "workspace_forbidden" });
    expect(voidChargeService).not.toHaveBeenCalled();
  });

  // Task 11 (R9): the route must forward the FULL correction body — strategy,
  // replacement, adjustmentAmount, idempotencyKey — to the service. Previously it
  // dropped all four (only reason/paidHandling/refund survived), so the drawer's
  // POST was silently ignored for the new strategies.
  it("forwards the full correction body (strategy/replacement/adjustmentAmount/idempotencyKey) to voidChargeService", async () => {
    const idem = "9a1c2b3d-4e5f-4061-8273-8495a6b7c8d9";
    const catId = "b2c3d4e5-6f70-4812-9a3b-4c5d6e7f8091";
    const body = {
      reason: "debit adjustment via drawer",
      strategy: "DEBIT_ADJUSTMENT",
      adjustmentAmount: "50.00",
      idempotencyKey: idem,
      replacement: { lines: [{ categoryId: catId, description: "Corrected rent", amount: "100.00" }] },
    };
    const res = await post(`/charges/${chargeId}/void`, body, sessionAs("manager"));

    expect(res.status).not.toBe(400);
    expect(voidChargeService).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        chargeId,
        reason: "debit adjustment via drawer",
        strategy: "DEBIT_ADJUSTMENT",
        adjustmentAmount: "50.00",
        idempotencyKey: idem,
        replacement: { lines: [{ categoryId: catId, description: "Corrected rent", amount: "100.00" }] },
      }),
    );
  });
});

describe("GET /charges/:chargeId — get charge by id (R5b)", () => {
  const chargeId = "44444444-4444-4444-8444-444444444444";

  it("admin + existing charge → 200 { id, chargeNumber, status }", async () => {
    vi.mocked(getChargeByIdService).mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { id: chargeId, chargeNumber: "CH-0009", status: "posted" },
    } as never);

    const res = await get(`/charges/${chargeId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ id: chargeId, chargeNumber: "CH-0009", status: "posted" });
    expect(getChargeByIdService).toHaveBeenCalledWith(session, chargeId);
  });
});

describe("GET /charges/:chargeId — get charge 404", () => {
  const chargeId = "55555555-5555-4555-8555-555555555555";

  it("missing/cross-org id → 404 CHARGE_NOT_FOUND", async () => {
    vi.mocked(getChargeByIdService).mockResolvedValueOnce({
      ok: false,
      status: 404,
      error: "CHARGE_NOT_FOUND",
    } as never);

    const res = await get(`/charges/${chargeId}`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: "CHARGE_NOT_FOUND" });
  });
});

describe("GET /charges/:chargeId — get charge admin only (R5b)", () => {
  const chargeId = "44444444-4444-4444-8444-444444444444";

  it("blocks viewer with 403, service not called", async () => {
    const res = await get(`/charges/${chargeId}`, sessionAs("viewer"));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual({ error: "Admin only" });
    expect(getChargeByIdService).not.toHaveBeenCalled();
  });

  it("blocks manager with 403, service not called", async () => {
    const res = await get(`/charges/${chargeId}`, sessionAs("manager"));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual({ error: "Admin only" });
    expect(getChargeByIdService).not.toHaveBeenCalled();
  });

  it("blocks operator with 403, service not called", async () => {
    const res = await get(`/charges/${chargeId}`, sessionAs("operator"));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual({ error: "Admin only" });
    expect(getChargeByIdService).not.toHaveBeenCalled();
  });
});

// Review finding (Task 4): a malformed chargeId reached findChargeById()'s
// Prisma `db.charge.findFirst({ where: { id: chargeId } })` unguarded —
// Charge.id is @db.Uuid, so Postgres throws P2023 ("invalid input syntax for
// type uuid"), which has no `.status` and escapes the global error handler as
// a bare 500. The sibling POST routes never hit this because
// postChargeSchema/voidChargeSchema validate chargeId with z.string().uuid()
// (→ 400 on malformed) before the service is ever called. This guard brings
// the GET route in line with that convention.
describe("GET /charges/:chargeId — malformed id guard (review fix)", () => {
  it("malformed chargeId → 400, not 404, not 500, service not called", async () => {
    const res = await get("/charges/not-a-uuid");

    expect(res.status).toBe(400);
    expect(res.status).not.toBe(404);
    expect(res.status).not.toBe(500);
    expect(getChargeByIdService).not.toHaveBeenCalled();
  });
});
