import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { SessionPayload } from "../../../lib/auth";
import { partiesRoutes } from "../parties.routes";
import * as partiesService from "../parties.service";
import * as icReveal from "../../../lib/ic-reveal";

// Mock the shared ic-reveal lib so DB/audit is never reached in unit tests.
vi.mock("../../../lib/ic-reveal", () => ({
  recordIcRevealService: vi.fn(),
}));

// Mock all service functions so DB is never reached.
vi.mock("../parties.service", () => ({
  getAgentsService: vi.fn().mockResolvedValue([]),
  getOwnersService: vi.fn().mockResolvedValue([]),
  getTenantsService: vi.fn().mockResolvedValue([]),
  createAgentService: vi.fn(),
  updateAgentService: vi.fn(),
  blacklistAgentService: vi.fn(),
  createOwnerService: vi.fn(),
  updateOwnerService: vi.fn(),
  blacklistOwnerService: vi.fn(),
  reactivateOwnerService: vi.fn(),
  createTenantService: vi.fn(),
  updateTenantService: vi.fn(),
  blacklistTenantService: vi.fn(),
  reactivateTenantService: vi.fn(),
  createPortalAccessService: vi.fn(),
  searchTenantsService: vi.fn().mockResolvedValue({ data: [] }),
}));

function makeApp(session: SessionPayload | null) {
  const app = new Hono<{ Variables: { session: SessionPayload } }>();
  app.use("*", async (c, next) => {
    if (session) c.set("session", session);
    await next();
  });
  app.route("/", partiesRoutes);
  return app;
}

const adminSession: SessionPayload = { userId: "u1", orgId: "o1", role: "admin", userType: "operator" };
const editorSession: SessionPayload = { userId: "u2", orgId: "o1", role: "editor", userType: "operator" };
const viewerSession: SessionPayload = { userId: "u3", orgId: "o1", role: "viewer", userType: "operator" };
const agentSession: SessionPayload = { userId: "u4", orgId: "o1", role: "admin", userType: "agent" };

describe("partiesRoutes auth", () => {
  it("admin operator can GET /agents (200)", async () => {
    const res = await makeApp(adminSession).request("/agents");
    expect(res.status).toBe(200);
  });

  it("editor operator gets 403 on GET /agents", async () => {
    const res = await makeApp(editorSession).request("/agents");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });

  it("viewer operator gets 403 on POST /agents", async () => {
    const res = await makeApp(viewerSession).request("/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "Test Agent" }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });

  it("agent userType gets 403 on GET /agents", async () => {
    const res = await makeApp(agentSession).request("/agents");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });

  it("manager operator can GET /owners (200)", async () => {
    const managerSession: SessionPayload = { userId: "u5", orgId: "o1", role: "manager", userType: "operator" };
    const res = await makeApp(managerSession).request("/owners");
    expect(res.status).toBe(200);
  });

  it("missing session gets 401 on GET /agents", async () => {
    const res = await makeApp(null).request("/agents");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });
});

describe("partiesRoutes PII redaction on invalid phone", () => {
  // Regression: Zod 4 attaches the raw input to issue.input. Route handlers
  // MUST serialize via `.flatten()` (or strip input manually) so a 400 on a
  // malformed primaryPhone never echoes the submitted value back to the
  // client — that value could be real PII a user accidentally typed wrong.
  const PII = "leak-this-PII-9999";

  it("POST /owners 400 body does not echo the raw primaryPhone value", async () => {
    const res = await makeApp(adminSession).request("/owners", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "Test", primaryPhone: PII }),
    });
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).not.toContain(PII);
    expect(body).not.toContain("9999");
  });

  it("POST /tenants 400 body does not echo the raw primaryPhone value", async () => {
    const res = await makeApp(adminSession).request("/tenants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "Test", primaryPhone: PII }),
    });
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).not.toContain(PII);
    expect(body).not.toContain("9999");
  });

  it("POST /agents 400 body does not echo the raw primaryPhone value", async () => {
    const res = await makeApp(adminSession).request("/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "Test", primaryPhone: PII }),
    });
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).not.toContain(PII);
    expect(body).not.toContain("9999");
  });
});

// Valid RFC 4122 UUIDs (version 4, variant 1) for use in Zod uuid() validated routes.
const VALID_UUID_1 = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
const VALID_UUID_2 = "b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a22";
const VALID_UUID_UNKNOWN = "c2eebc99-9c0b-4ef8-bb6d-6bb9bd380a99";

describe("partiesRoutes reactivate tenant", () => {
  const TENANT_ID = VALID_UUID_1;

  it("manager POST /tenants/:id/reactivate → 200 and isBlacklisted=false, status=active", async () => {
    const managerSession: SessionPayload = { userId: "u5", orgId: "o1", role: "manager", userType: "operator" };
    vi.mocked(partiesService.reactivateTenantService).mockResolvedValueOnce({
      ok: true, status: 200, data: { id: TENANT_ID },
    });
    const res = await makeApp(managerSession).request(`/tenants/${TENANT_ID}/reactivate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ id: TENANT_ID });
    expect(partiesService.reactivateTenantService).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1" }),
      expect.objectContaining({ partyId: TENANT_ID }),
    );
  });

  it("POST /tenants/:id/reactivate → 404 when tenant not found", async () => {
    const managerSession: SessionPayload = { userId: "u5", orgId: "o1", role: "manager", userType: "operator" };
    vi.mocked(partiesService.reactivateTenantService).mockResolvedValueOnce({
      ok: false, status: 404, error: "Tenant not found",
    });
    const res = await makeApp(managerSession).request(`/tenants/${VALID_UUID_UNKNOWN}/reactivate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json).toEqual({ error: "Tenant not found" });
  });
});

describe("partiesRoutes reactivate owner", () => {
  const OWNER_ID = VALID_UUID_2;

  it("manager POST /owners/:id/reactivate → 200 and isBlacklisted=false, status=active", async () => {
    const managerSession: SessionPayload = { userId: "u5", orgId: "o1", role: "manager", userType: "operator" };
    vi.mocked(partiesService.reactivateOwnerService).mockResolvedValueOnce({
      ok: true, status: 200, data: { id: OWNER_ID },
    });
    const res = await makeApp(managerSession).request(`/owners/${OWNER_ID}/reactivate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ id: OWNER_ID });
    expect(partiesService.reactivateOwnerService).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1" }),
      expect.objectContaining({ partyId: OWNER_ID }),
    );
  });

  it("POST /owners/:id/reactivate → 404 when owner not found", async () => {
    const managerSession: SessionPayload = { userId: "u5", orgId: "o1", role: "manager", userType: "operator" };
    vi.mocked(partiesService.reactivateOwnerService).mockResolvedValueOnce({
      ok: false, status: 404, error: "Owner not found",
    });
    const res = await makeApp(managerSession).request(`/owners/${VALID_UUID_UNKNOWN}/reactivate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json).toEqual({ error: "Owner not found" });
  });
});

describe("GET /parties/tenants/search", () => {
  it("manager → 200 and forwards q + take to the service", async () => {
    const managerSession: SessionPayload = { userId: "u5", orgId: "o1", role: "manager", userType: "operator" };
    vi.mocked(partiesService.searchTenantsService).mockResolvedValueOnce({
      data: [{ id: "t1", displayName: "NURUL", primaryPhone: "60123456789",
               formattedPhone: "+60 12-345 6789", idType: "nric", idNumberMasked: "••••5678" }],
    });
    const res = await makeApp(managerSession).request("/tenants/search?q=nur&take=5");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: [{ id: "t1", displayName: "NURUL", primaryPhone: "60123456789",
               formattedPhone: "+60 12-345 6789", idType: "nric", idNumberMasked: "••••5678" }],
    });
    expect(partiesService.searchTenantsService).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1" }), "nur", 5,
    );
  });

  it("editor operator gets 403 (module gate is manager+)", async () => {
    const res = await makeApp(editorSession).request("/tenants/search?q=x");
    expect(res.status).toBe(403);
  });

  it("missing session → 401", async () => {
    const res = await makeApp(null).request("/tenants/search?q=x");
    expect(res.status).toBe(401);
  });
});

// Regression: a duplicate on create must (a) reach the client as a 409 whose
// body carries the specific message AND (b) include a `fieldErrors` map keyed to
// the offending form field so the input turns red. The owner route historically
// lacked the `if (!result.ok)` guard the tenant route had, so an owner duplicate
// returned an undefined body (client fell back to a generic "Conflict…" toast);
// and neither route propagated `fieldErrors` on the 409 branch.
describe("partiesRoutes duplicate-conflict surfaces the field", () => {
  const adminOp: SessionPayload = { userId: "u1", orgId: "o1", role: "admin", userType: "operator" };

  it("POST /owners → 409 body carries error AND fieldErrors on a contact conflict", async () => {
    vi.mocked(partiesService.createOwnerService).mockResolvedValueOnce({
      ok: false,
      status: 409,
      error: "This email is already used by Daniel Tan.",
      fieldErrors: { primaryEmail: "Already used by Daniel Tan" },
    } as Awaited<ReturnType<typeof partiesService.createOwnerService>>);
    const res = await makeApp(adminOp).request("/owners", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "Daniel Tan", primaryEmail: "daniel@example.com" }),
    });
    const raw = await res.text();
    expect(res.status).toBe(409);
    expect(JSON.parse(raw || "null")).toEqual({
      error: "This email is already used by Daniel Tan.",
      fieldErrors: { primaryEmail: "Already used by Daniel Tan" },
    });
  });

  it("POST /tenants → 409 body propagates fieldErrors on a contact conflict", async () => {
    vi.mocked(partiesService.createTenantService).mockResolvedValueOnce({
      ok: false,
      status: 409,
      error: "This phone number is already used by Ahmad.",
      fieldErrors: { primaryPhone: "Already used by Ahmad" },
    } as Awaited<ReturnType<typeof partiesService.createTenantService>>);
    const res = await makeApp(adminOp).request("/tenants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "Ahmad Two" }),
    });
    const raw = await res.text();
    expect(res.status).toBe(409);
    expect(JSON.parse(raw || "null")).toEqual({
      error: "This phone number is already used by Ahmad.",
      fieldErrors: { primaryPhone: "Already used by Ahmad" },
    });
  });
});

describe("POST /parties/:partyId/ic-reveal (non-gated, audited)", () => {
  const PARTY = VALID_UUID_1;
  const managerSession: SessionPayload = { userId: "u5", orgId: "o1", role: "manager", userType: "operator" };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("manager → 200 raw idNumber via the shared service", async () => {
    vi.mocked(icReveal.recordIcRevealService).mockResolvedValueOnce({
      ok: true, status: 200, data: { partyId: PARTY, idNumber: "990101-14-5678" },
    });
    const res = await makeApp(managerSession).request(`/${PARTY}/ic-reveal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ partyId: PARTY }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ partyId: PARTY, idNumber: "990101-14-5678" });
    expect(icReveal.recordIcRevealService).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1", role: "manager" }), PARTY,
    );
  });

  it("editor → 403 (manager+ gate), service never called", async () => {
    const res = await makeApp(editorSession).request(`/${PARTY}/ic-reveal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ partyId: PARTY }),
    });
    expect(res.status).toBe(403);
    expect(icReveal.recordIcRevealService).not.toHaveBeenCalled();
  });

  it("unknown party → 404 PARTY_NOT_FOUND", async () => {
    vi.mocked(icReveal.recordIcRevealService).mockResolvedValueOnce({
      ok: false, status: 404, error: "PARTY_NOT_FOUND",
    });
    const res = await makeApp(managerSession).request(`/${VALID_UUID_UNKNOWN}/ic-reveal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ partyId: VALID_UUID_UNKNOWN }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "PARTY_NOT_FOUND" });
  });

  it("invalid body → 400, no PII echo of the bad id", async () => {
    const res = await makeApp(managerSession).request(`/not-a-uuid/ic-reveal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ partyId: "not-a-uuid" }),
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).not.toContain("not-a-uuid");
  });
});
