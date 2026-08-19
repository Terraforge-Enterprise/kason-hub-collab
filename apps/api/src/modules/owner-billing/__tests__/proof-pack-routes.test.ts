import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { SessionPayload } from "../../../lib/auth";

// Mock the proof-pack service so the DB/bucket is never reached — the route is
// tested in isolation (mirrors owner-expense-proof-routes.test.ts).
vi.mock("../proof-pack.service", () => ({
  buildProofPackPdf: vi.fn(),
}));

import { ownerBillingRoutes } from "../owner-billing.routes";
import { buildProofPackPdf } from "../proof-pack.service";

function makeApp(session: SessionPayload | null) {
  const app = new Hono<{ Variables: { session: SessionPayload } }>();
  app.use("*", async (c, next) => {
    if (session) c.set("session", session);
    await next();
  });
  app.route("/", ownerBillingRoutes);
  return app;
}

const OWNER = "11111111-1111-4111-8111-111111111111";
const APT = "22222222-2222-4222-8222-222222222222";
const MONTH = "2026-06";

const adminSession: SessionPayload = { userId: "u1", orgId: "o1", role: "admin", userType: "operator" };
const managerSession: SessionPayload = { userId: "u2", orgId: "o1", role: "manager", userType: "operator" };
const editorSession: SessionPayload = { userId: "u3", orgId: "o1", role: "editor", userType: "operator" };
const ownerPortalSession: SessionPayload = { userId: "u4", orgId: "o1", role: "viewer", userType: "owner" };

// A minimal "%PDF" stream the service hands back; the route just streams it.
const FAKE_PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // "%PDF-"

beforeAll(() => {
  process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
});
afterAll(() => {
  delete process.env.ENABLE_PHASE2_OWNER_BILLING;
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(buildProofPackPdf).mockResolvedValue(FAKE_PDF);
});

function getPack(
  session: SessionPayload | null,
  query = `ownerPartyId=${OWNER}&statementMonth=${MONTH}&apartmentId=${APT}`,
) {
  return makeApp(session).request(`/proof-pack?${query}`, { method: "GET" });
}

describe("GET /proof-pack (merged bills PDF = admin/manager)", () => {
  it("manager gets 200 application/pdf + attachment disposition; ctx + params forwarded", async () => {
    const res = await getPack(managerSession);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Disposition")).toContain("attachment");
    expect(res.headers.get("Content-Disposition")).toContain(`proof-pack-${MONTH}.pdf`);
    // The streamed body is the bytes the service returned.
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.subarray(0, 4).toString("latin1")).toBe("%PDF");
    expect(buildProofPackPdf).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1", actorUserId: "u2", actorRole: "manager" }),
      OWNER,
      MONTH,
      APT,
    );
  });

  it("admin is allowed (the pack is admin/manager)", async () => {
    const res = await getPack(adminSession);
    expect(res.status).toBe(200);
  });

  it("a missing apartmentId query forwards apartmentId: null (legacy combined)", async () => {
    await getPack(adminSession, `ownerPartyId=${OWNER}&statementMonth=${MONTH}`);
    expect(buildProofPackPdf).toHaveBeenCalledWith(expect.anything(), OWNER, MONTH, null);
  });

  it("maps a null service result (no proofs) to HTTP 404", async () => {
    vi.mocked(buildProofPackPdf).mockResolvedValueOnce(null);
    const res = await getPack(adminSession);
    expect(res.status).toBe(404);
  });

  it("403s for an editor (below manager)", async () => {
    const res = await getPack(editorSession);
    expect(res.status).toBe(403);
    expect(buildProofPackPdf).not.toHaveBeenCalled();
  });

  it("403s for a portal (owner) session", async () => {
    const res = await getPack(ownerPortalSession);
    expect(res.status).toBe(403);
    expect(buildProofPackPdf).not.toHaveBeenCalled();
  });

  it("401s for a missing session", async () => {
    const res = await getPack(null);
    expect(res.status).toBe(401);
  });

  it("400s a malformed query (missing ownerPartyId)", async () => {
    const res = await getPack(adminSession, `statementMonth=${MONTH}`);
    expect(res.status).toBe(400);
    expect(buildProofPackPdf).not.toHaveBeenCalled();
  });

  it("400s a malformed statementMonth", async () => {
    const res = await getPack(adminSession, `ownerPartyId=${OWNER}&statementMonth=June%202026`);
    expect(res.status).toBe(400);
    expect(buildProofPackPdf).not.toHaveBeenCalled();
  });

  it("404s while the flag is dark, before the role check", async () => {
    delete process.env.ENABLE_PHASE2_OWNER_BILLING;
    try {
      const res = await getPack(adminSession);
      expect(res.status).toBe(404);
    } finally {
      process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
    }
  });
});
