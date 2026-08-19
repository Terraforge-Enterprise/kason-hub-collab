import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { SessionPayload } from "../../../lib/auth";

const { createServiceMock, listServiceMock } = vi.hoisted(() => ({
  createServiceMock: vi.fn(),
  listServiceMock: vi.fn(),
}));
vi.mock("../owner-funding-requests.service", () => ({
  createOwnerFundingRequestService: (...a: unknown[]) => createServiceMock(...a),
  listOwnerFundingRequestsService: (...a: unknown[]) => listServiceMock(...a),
  OwnerFundingRequestError: class OwnerFundingRequestError extends Error {
    status: number;
    code: string;
    constructor(status: number, code: string) {
      super(code);
      this.name = "OwnerFundingRequestError";
      this.status = status;
      this.code = code;
    }
  },
}));

function makeApp(session: SessionPayload | null) {
  const app = new Hono<{ Variables: { session: SessionPayload } }>();
  app.use("*", async (c, next) => {
    if (session) c.set("session", session);
    await next();
  });
  return app;
}
const editor: SessionPayload = { userId: "u1", orgId: "org-1", role: "editor", userType: "operator" };
const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const validBody = { ownerPartyId: OWNER_ID, amount: "5000.00", reason: "Roof repair far exceeds rent collected" };

describe("owner-funding-requests routes — flag gate + RBAC + shape (P7)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("(b) flag OFF → 404 on POST, even for a valid editor, BEFORE auth (owner-remittance precedent)", async () => {
    delete process.env.ENABLE_OWNER_FUNDING_REQUEST;
    vi.resetModules();
    const { ownerFundingRequestsRoutes } = await import("../owner-funding-requests.routes");
    const app = makeApp(editor);
    app.route("/", ownerFundingRequestsRoutes);
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(createServiceMock).not.toHaveBeenCalled();
  });

  it("(b) flag OFF → 404 on GET too", async () => {
    delete process.env.ENABLE_OWNER_FUNDING_REQUEST;
    vi.resetModules();
    const { ownerFundingRequestsRoutes } = await import("../owner-funding-requests.routes");
    const app = makeApp(editor);
    app.route("/", ownerFundingRequestsRoutes);
    const res = await app.request(`/?ownerPartyId=${OWNER_ID}`);
    expect(res.status).toBe(404);
    expect(listServiceMock).not.toHaveBeenCalled();
  });

  it("(a) flag ON + editor + valid body → 201, calls the create service with requested status", async () => {
    process.env.ENABLE_OWNER_FUNDING_REQUEST = "true";
    createServiceMock.mockResolvedValue({ id: "req-1", status: "requested", ownerPartyId: OWNER_ID });
    vi.resetModules();
    const { ownerFundingRequestsRoutes } = await import("../owner-funding-requests.routes");
    const app = makeApp(editor);
    app.route("/", ownerFundingRequestsRoutes);
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.data).toMatchObject({ id: "req-1", status: "requested" });
    expect(createServiceMock).toHaveBeenCalledTimes(1);
  });

  it("(c) flag ON + missing reason → 400, service never called", async () => {
    process.env.ENABLE_OWNER_FUNDING_REQUEST = "true";
    vi.resetModules();
    const { ownerFundingRequestsRoutes } = await import("../owner-funding-requests.routes");
    const app = makeApp(editor);
    app.route("/", ownerFundingRequestsRoutes);
    const { reason: _reason, ...withoutReason } = validBody;
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(withoutReason),
    });
    expect(res.status).toBe(400);
    expect(createServiceMock).not.toHaveBeenCalled();
  });

  it("(c) flag ON + bad amount shape → 400, service never called", async () => {
    process.env.ENABLE_OWNER_FUNDING_REQUEST = "true";
    vi.resetModules();
    const { ownerFundingRequestsRoutes } = await import("../owner-funding-requests.routes");
    const app = makeApp(editor);
    app.route("/", ownerFundingRequestsRoutes);
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...validBody, amount: "not-money" }),
    });
    expect(res.status).toBe(400);
    expect(createServiceMock).not.toHaveBeenCalled();
  });

  it("(c) flag ON + amount beyond DECIMAL(12,2) → 400, service never called", async () => {
    process.env.ENABLE_OWNER_FUNDING_REQUEST = "true";
    vi.resetModules();
    const { ownerFundingRequestsRoutes } = await import("../owner-funding-requests.routes");
    const app = makeApp(editor);
    app.route("/", ownerFundingRequestsRoutes);
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...validBody, amount: "99999999999.99" }),
    });
    expect(res.status).toBe(400);
    expect(createServiceMock).not.toHaveBeenCalled();
  });

  it("flag ON + missing session → 401", async () => {
    process.env.ENABLE_OWNER_FUNDING_REQUEST = "true";
    vi.resetModules();
    const { ownerFundingRequestsRoutes } = await import("../owner-funding-requests.routes");
    const app = makeApp(null);
    app.route("/", ownerFundingRequestsRoutes);
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(401);
  });

  it("(d) flag ON + editor + GET ?ownerPartyId= → 200, calls the list service", async () => {
    process.env.ENABLE_OWNER_FUNDING_REQUEST = "true";
    listServiceMock.mockResolvedValue({ requests: [], currentBalanceC: -12345 });
    vi.resetModules();
    const { ownerFundingRequestsRoutes } = await import("../owner-funding-requests.routes");
    const app = makeApp(editor);
    app.route("/", ownerFundingRequestsRoutes);
    const res = await app.request(`/?ownerPartyId=${OWNER_ID}`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual({ requests: [], currentBalanceC: -12345 });
    expect(listServiceMock).toHaveBeenCalledTimes(1);
    expect(listServiceMock.mock.calls[0][1]).toBe(OWNER_ID);
  });

  it("flag ON + GET missing ownerPartyId → 400, service never called", async () => {
    process.env.ENABLE_OWNER_FUNDING_REQUEST = "true";
    vi.resetModules();
    const { ownerFundingRequestsRoutes } = await import("../owner-funding-requests.routes");
    const app = makeApp(editor);
    app.route("/", ownerFundingRequestsRoutes);
    const res = await app.request("/");
    expect(res.status).toBe(400);
    expect(listServiceMock).not.toHaveBeenCalled();
  });

  it("flag ON + GET invalid (non-uuid) ownerPartyId → 400, service never called", async () => {
    process.env.ENABLE_OWNER_FUNDING_REQUEST = "true";
    vi.resetModules();
    const { ownerFundingRequestsRoutes } = await import("../owner-funding-requests.routes");
    const app = makeApp(editor);
    app.route("/", ownerFundingRequestsRoutes);
    const res = await app.request("/?ownerPartyId=not-a-uuid");
    expect(res.status).toBe(400);
    expect(listServiceMock).not.toHaveBeenCalled();
  });
});
