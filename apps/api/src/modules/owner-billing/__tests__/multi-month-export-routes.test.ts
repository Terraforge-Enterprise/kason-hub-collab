import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { SessionPayload } from "../../../lib/auth";
import type { PortalEnv, PortalSessionPayload } from "../../portal/auth/portal.auth.types";
import { portalUserTypeGuard } from "../../portal/portal.middleware";

// Mock the multi-month-export SERVICE — but keep `validateExportRange` REAL (via
// importOriginal) so the range cap / order checks run through the route exactly as
// in production, while the DB-touching resolve + the archiver stream are stubbed.
vi.mock("../multi-month-export.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../multi-month-export.service")>();
  return {
    ...actual,
    resolveOwnerStatementsInRange: vi.fn(),
    streamMonthRangeZip: vi.fn(),
  };
});

import { ownerBillingRoutes } from "../owner-billing.routes";
import { portalOwnerStatementsRoutes } from "../../portal/owner-statements/portal.owner-statements.routes";
import { resolveOwnerStatementsInRange, streamMonthRangeZip } from "../multi-month-export.service";

const OWNER_A = "11111111-1111-4111-8111-111111111111";
const OWNER_B = "22222222-2222-4222-8222-222222222222";

const adminSession: SessionPayload = { userId: "u1", orgId: "o1", role: "admin", userType: "operator" };
const managerSession: SessionPayload = { userId: "u2", orgId: "o1", role: "manager", userType: "operator" };
const editorSession: SessionPayload = { userId: "u3", orgId: "o1", role: "editor", userType: "operator" };

function ownerSession(partyId: string, orgId = "o1"): PortalSessionPayload {
  return { userId: `user-${partyId.slice(0, 4)}`, orgId, role: "viewer", userType: "owner", partyId, iat: 0, absoluteExp: 0 };
}
const agentSession: PortalSessionPayload = {
  userId: "user-agent", orgId: "o1", role: "viewer", userType: "agent", partyId: "ag", iat: 0, absoluteExp: 0,
};

function makeAdminApp(session: SessionPayload | null) {
  const app = new Hono<{ Variables: { session: SessionPayload } }>();
  app.use("*", async (c, next) => {
    if (session) c.set("session", session);
    await next();
  });
  app.route("/", ownerBillingRoutes);
  return app;
}
function makePortalApp(session: PortalSessionPayload | null) {
  const app = new Hono<PortalEnv>();
  app.use("*", async (c, next) => {
    if (session) c.set("session", session);
    await next();
  });
  app.use("/owner/*", portalUserTypeGuard("owner"));
  app.route("/owner", portalOwnerStatementsRoutes);
  return app;
}

beforeAll(() => {
  process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
});
afterAll(() => {
  delete process.env.ENABLE_PHASE2_OWNER_BILLING;
});
beforeEach(() => {
  vi.clearAllMocks();
  // Default: one statement in range (non-empty) + a stream that writes a tiny ZIP.
  vi.mocked(resolveOwnerStatementsInRange).mockResolvedValue([
    { id: "s1", periodMonth: new Date(Date.UTC(2026, 0, 1)), apartmentId: null, pdfKey: null, status: "sent" },
  ]);
  vi.mocked(streamMonthRangeZip).mockImplementation(async (_ctx, _params, sink) => {
    await sink.write(Buffer.from("PKfake-zip"));
  });
});

function adminReq(session: SessionPayload | null, query: string) {
  return makeAdminApp(session).request(`/statements/export?${query}`, { method: "GET" });
}
function portalReq(session: PortalSessionPayload | null, query: string) {
  return makePortalApp(session).request(`/owner/statements/export?${query}`, { method: "GET" });
}

const OK_RANGE = `ownerPartyId=${OWNER_A}&fromMonth=2026-01&toMonth=2026-03`;

describe("GET /statements/export (admin/manager — streamed month-range ZIP)", () => {
  it("manager gets 200 application/zip + attachment; forwards range + includeProof=false", async () => {
    const res = await adminReq(managerSession, OK_RANGE);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/zip");
    expect(res.headers.get("Content-Disposition")).toContain("attachment");
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.subarray(0, 2).toString("latin1")).toBe("PK");
    expect(streamMonthRangeZip).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1", actorUserId: "u2", actorRole: "manager" }),
      expect.objectContaining({ ownerPartyId: OWNER_A, fromMonth: "2026-01", toMonth: "2026-03", includeProof: false }),
      expect.anything(),
    );
  });

  it("admin is allowed", async () => {
    const res = await adminReq(adminSession, OK_RANGE);
    expect(res.status).toBe(200);
  });

  it("includeProof=1 is parsed to true and forwarded", async () => {
    await adminReq(adminSession, `${OK_RANGE}&includeProof=1`);
    expect(streamMonthRangeZip).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ includeProof: true }),
      expect.anything(),
    );
  });

  it("from>to → 400 (no stream)", async () => {
    const res = await adminReq(adminSession, `ownerPartyId=${OWNER_A}&fromMonth=2026-03&toMonth=2026-01`);
    expect(res.status).toBe(400);
    expect(streamMonthRangeZip).not.toHaveBeenCalled();
  });

  it("range > 24 months → 400 (no stream)", async () => {
    // 2024-01 .. 2026-02 inclusive = 26 months.
    const res = await adminReq(adminSession, `ownerPartyId=${OWNER_A}&fromMonth=2024-01&toMonth=2026-02`);
    expect(res.status).toBe(400);
    expect(streamMonthRangeZip).not.toHaveBeenCalled();
  });

  it("exactly 24 months is allowed (boundary)", async () => {
    // 2024-01 .. 2025-12 inclusive = 24 months.
    const res = await adminReq(adminSession, `ownerPartyId=${OWNER_A}&fromMonth=2024-01&toMonth=2025-12`);
    expect(res.status).toBe(200);
  });

  it("no statements in range → 404 (nothing to export, no stream)", async () => {
    vi.mocked(resolveOwnerStatementsInRange).mockResolvedValueOnce([]);
    const res = await adminReq(adminSession, OK_RANGE);
    expect(res.status).toBe(404);
    expect(streamMonthRangeZip).not.toHaveBeenCalled();
  });

  it("malformed month query → 400", async () => {
    const res = await adminReq(adminSession, `ownerPartyId=${OWNER_A}&fromMonth=June&toMonth=2026-03`);
    expect(res.status).toBe(400);
  });

  it("403s an editor (below manager)", async () => {
    const res = await adminReq(editorSession, OK_RANGE);
    expect(res.status).toBe(403);
    expect(streamMonthRangeZip).not.toHaveBeenCalled();
  });

  it("401s a missing session", async () => {
    const res = await adminReq(null, OK_RANGE);
    expect(res.status).toBe(401);
  });

  it("404s while the flag is dark, before the role check", async () => {
    delete process.env.ENABLE_PHASE2_OWNER_BILLING;
    try {
      const res = await adminReq(adminSession, OK_RANGE);
      expect(res.status).toBe(404);
    } finally {
      process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
    }
  });
});

describe("GET /owner/statements/export (portal mirror — owner-scoped, POST-only)", () => {
  it("forces ownerPartyId = SESSION owner, ignoring a client ownerPartyId param", async () => {
    // Owner B's session asks (with ?ownerPartyId=OWNER_A) — the route must resolve
    // for OWNER_B (session), never the client param. Mock returns [] for B → 404.
    vi.mocked(resolveOwnerStatementsInRange).mockResolvedValueOnce([]);
    const res = await portalReq(ownerSession(OWNER_B), `ownerPartyId=${OWNER_A}&fromMonth=2026-01&toMonth=2026-03`);
    expect(res.status).toBe(404);
    expect(resolveOwnerStatementsInRange).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1" }),
      OWNER_B, // session owner, NOT the OWNER_A query param
      "2026-01",
      "2026-03",
    );
  });

  it("owner with statements in range → 200 application/zip", async () => {
    const res = await portalReq(ownerSession(OWNER_A), "fromMonth=2026-01&toMonth=2026-03");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/zip");
  });

  it("from>to → 400 (portal validates the same range cap)", async () => {
    const res = await portalReq(ownerSession(OWNER_A), "fromMonth=2026-03&toMonth=2026-01");
    expect(res.status).toBe(400);
    expect(streamMonthRangeZip).not.toHaveBeenCalled();
  });

  it("403s a non-owner (agent) portal session", async () => {
    const res = await portalReq(agentSession, "fromMonth=2026-01&toMonth=2026-03");
    expect(res.status).toBe(403);
  });

  it("404s while the flag is dark", async () => {
    delete process.env.ENABLE_PHASE2_OWNER_BILLING;
    try {
      const res = await portalReq(ownerSession(OWNER_A), "fromMonth=2026-01&toMonth=2026-03");
      expect(res.status).toBe(404);
    } finally {
      process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
    }
  });
});
