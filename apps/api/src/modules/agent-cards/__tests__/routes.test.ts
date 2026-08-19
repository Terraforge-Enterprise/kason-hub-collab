/**
 * Routes tests for agent-cards.
 *
 * Service is mocked so we exercise the route layer in isolation:
 * - role gating (editor minimum on reads, manager minimum on mutations)
 * - GET history shape
 * - GET version cross-org returns 404 (no enumeration leak)
 * - POST approve / reject / regenerate / revoke happy paths
 * - reject without body → 400; cross-org / not-pending → 404 / 409
 */
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { SessionPayload } from "../../../lib/auth";

vi.mock("../service", async () => {
  // Pull in the real error classes (route layer uses `instanceof` checks)
  // while replacing the IO functions with vi.fn() stubs.
  const actual = await vi.importActual<typeof import("../service")>("../service");
  return {
    ...actual,
    listVersionsForParty: vi.fn(),
    getVersionForOrg: vi.fn(),
    listVersionsForOrg: vi.fn(),
    countPendingVersions: vi.fn(),
    approveVersion: vi.fn(),
    rejectVersion: vi.fn(),
    regenerateToken: vi.fn(),
    revokeActiveCard: vi.fn(),
  };
});

import { agentCardsRoutes } from "../routes";
import {
  AgentCardConflictError,
  AgentCardNotFoundError,
  approveVersion,
  countPendingVersions,
  getVersionForOrg,
  listVersionsForOrg,
  listVersionsForParty,
  regenerateToken,
  rejectVersion,
  revokeActiveCard,
} from "../service";

function makeApp(session: SessionPayload | null) {
  const app = new Hono<{ Variables: { session: SessionPayload } }>();
  app.use("*", async (c, next) => {
    if (session) c.set("session", session);
    await next();
  });
  app.route("/", agentCardsRoutes);
  return app;
}

const editor: SessionPayload = {
  userId: "u1",
  orgId: "org-1",
  role: "editor",
  userType: "operator",
};
const manager: SessionPayload = {
  userId: "u2",
  orgId: "org-1",
  role: "manager",
  userType: "operator",
};

const PARTY_ID = "11111111-1111-1111-1111-111111111111";
const VERSION_ID = "22222222-2222-2222-2222-222222222222";

describe("agentCardsRoutes — GET /:partyId (history)", () => {
  it("returns the version rows wrapped in { data }", async () => {
    const rows = [
      {
        id: VERSION_ID,
        organizationId: "org-1",
        partyId: PARTY_ID,
        displayName: "Agent A",
        title: "Sales Manager",
        primaryEmail: null,
        primaryPhone: null,
        status: "approved",
        submittedById: "u1",
        submittedByType: "admin",
        reviewedById: "u1",
        reviewedAt: new Date("2026-05-05T00:00:00Z"),
        rejectionReason: null,
        approvedAt: new Date("2026-05-05T00:00:00Z"),
        expiresAt: new Date("2026-08-05T00:00:00Z"),
        reconfirmCount: 0,
        createdAt: new Date("2026-05-05T00:00:00Z"),
      },
    ];
    vi.mocked(listVersionsForParty).mockResolvedValueOnce(rows);

    const res = await makeApp(editor).request(`/${PARTY_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(listVersionsForParty).toHaveBeenCalledWith("org-1", PARTY_ID);
  });
});

describe("agentCardsRoutes — GET /version/:versionId", () => {
  it("returns 404 when the version belongs to another org (cross-org enumeration guard)", async () => {
    // Service returns null for both not-found and cross-org — see service header.
    vi.mocked(getVersionForOrg).mockResolvedValueOnce(null);

    const res = await makeApp(editor).request(`/version/${VERSION_ID}`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Not found");
    expect(getVersionForOrg).toHaveBeenCalledWith("org-1", VERSION_ID);
  });
});

describe("agentCardsRoutes — GET / (queue list)", () => {
  it("forwards parsed query (status, limit, offset) and wraps the paginated result", async () => {
    vi.mocked(listVersionsForOrg).mockResolvedValueOnce({
      data: [],
      pagination: { total: 0, limit: 10, offset: 5 },
    });

    const res = await makeApp(editor).request("/?status=pending&limit=10&offset=5");
    expect(res.status).toBe(200);
    expect(listVersionsForOrg).toHaveBeenCalledWith("org-1", {
      status: "pending",
      limit: 10,
      offset: 5,
    });
    const body = (await res.json()) as {
      data: unknown[];
      pagination: { total: number; limit: number; offset: number };
    };
    expect(body.pagination).toEqual({ total: 0, limit: 10, offset: 5 });
  });

  it("rejects invalid status filter with 400", async () => {
    const res = await makeApp(editor).request("/?status=banana");
    expect(res.status).toBe(400);
  });
});

describe("agentCardsRoutes — GET /_meta/pending-count", () => {
  it("returns { data: { count } } scoped by org", async () => {
    vi.mocked(countPendingVersions).mockResolvedValueOnce(7);
    const res = await makeApp(editor).request("/_meta/pending-count");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { count: number } };
    expect(body.data).toEqual({ count: 7 });
    expect(countPendingVersions).toHaveBeenCalledWith("org-1");
  });
});

describe("agentCardsRoutes — POST /version/:versionId/approve", () => {
  it("blocks editor (requires manager)", async () => {
    const res = await makeApp(editor).request(`/version/${VERSION_ID}/approve`, {
      method: "POST",
    });
    expect(res.status).toBe(403);
    expect(approveVersion).not.toHaveBeenCalled();
  });

  it("happy path: returns { data: { versionId } } from service", async () => {
    vi.mocked(approveVersion).mockResolvedValueOnce({ versionId: VERSION_ID });
    const res = await makeApp(manager).request(`/version/${VERSION_ID}/approve`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { versionId: string } };
    expect(body.data.versionId).toBe(VERSION_ID);
    expect(approveVersion).toHaveBeenCalledWith(VERSION_ID, {
      actorUserId: "u2",
      actorRole: "manager",
      organizationId: "org-1",
    });
  });

  it("maps AgentCardNotFoundError → 404 (cross-org)", async () => {
    vi.mocked(approveVersion).mockRejectedValueOnce(new AgentCardNotFoundError());
    const res = await makeApp(manager).request(`/version/${VERSION_ID}/approve`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });

  it("maps AgentCardConflictError → 409 (already approved)", async () => {
    vi.mocked(approveVersion).mockRejectedValueOnce(new AgentCardConflictError("not pending"));
    const res = await makeApp(manager).request(`/version/${VERSION_ID}/approve`, {
      method: "POST",
    });
    expect(res.status).toBe(409);
  });
});

describe("agentCardsRoutes — POST /version/:versionId/reject", () => {
  it("returns 400 when reason is missing", async () => {
    const res = await makeApp(manager).request(`/version/${VERSION_ID}/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(rejectVersion).not.toHaveBeenCalled();
  });

  it("happy path passes reason to service", async () => {
    vi.mocked(rejectVersion).mockResolvedValueOnce({ versionId: VERSION_ID });
    const res = await makeApp(manager).request(`/version/${VERSION_ID}/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "Photo missing" }),
    });
    expect(res.status).toBe(200);
    expect(rejectVersion).toHaveBeenCalledWith(VERSION_ID, {
      actorUserId: "u2",
      actorRole: "manager",
      organizationId: "org-1",
      reason: "Photo missing",
    });
  });
});

describe("agentCardsRoutes — POST /:partyId/regenerate-token", () => {
  it("blocks editor", async () => {
    const res = await makeApp(editor).request(`/${PARTY_ID}/regenerate-token`, {
      method: "POST",
    });
    expect(res.status).toBe(403);
  });

  it("happy path returns { data: { versionId, publicToken } }", async () => {
    vi.mocked(regenerateToken).mockResolvedValueOnce({
      versionId: VERSION_ID,
      publicToken: "abcdefghijklmnopqrstuv",
    });
    const res = await makeApp(manager).request(`/${PARTY_ID}/regenerate-token`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { versionId: string; publicToken: string } };
    expect(body.data.versionId).toBe(VERSION_ID);
    expect(body.data.publicToken).toBe("abcdefghijklmnopqrstuv");
  });
});

describe("agentCardsRoutes — POST /:partyId/revoke", () => {
  it("happy path returns { data: { versionId } }", async () => {
    vi.mocked(revokeActiveCard).mockResolvedValueOnce({ versionId: VERSION_ID });
    const res = await makeApp(manager).request(`/${PARTY_ID}/revoke`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { versionId: string } };
    expect(body.data.versionId).toBe(VERSION_ID);
  });

  it("maps AgentCardNotFoundError → 404 (no active version)", async () => {
    vi.mocked(revokeActiveCard).mockRejectedValueOnce(new AgentCardNotFoundError());
    const res = await makeApp(manager).request(`/${PARTY_ID}/revoke`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });
});
