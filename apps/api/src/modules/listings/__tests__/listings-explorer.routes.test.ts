import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { SessionPayload } from "../../../lib/auth";

// vi.mock factories are hoisted — use vi.hoisted for the mock so the factory
// has access to it at hoist time.
const { listExplorerUnitsMock } = vi.hoisted(() => ({
  listExplorerUnitsMock: vi.fn(),
}));

vi.mock("../listings-explorer.service", () => ({
  listExplorerUnits: listExplorerUnitsMock,
}));

// Stub all OTHER service imports the routes file pulls in — the route file
// must compile, but only the /explorer handler is exercised here.
//
// Sourcing-approval services (approveSourcedListingService etc.) were
// removed in the three-table refactor — their replacements live in the
// submissions module.
vi.mock("../listings.service", () => ({
  createListingService: vi.fn(),
  deleteListingService: vi.fn(),
  getDeletionPreviewService: vi.fn(),
  getListingByIdService: vi.fn(),
  getListingsService: vi.fn(),
  updateListingService: vi.fn(),
}));
vi.mock("../listings-media.service", () => ({
  isVideoKey: vi.fn(),
  stripExifInPlace: vi.fn(),
  transcodeVideoInPlace: vi.fn(),
}));
vi.mock("../listings-media-upload.service", () => ({
  buildMediaUploadUrl: vi.fn(),
  completeMediaUpload: vi.fn(),
  removeMediaKey: vi.fn(),
}));
vi.mock("../../../lib/storage", () => ({
  createSignedDownloadUrl: vi.fn(),
}));
vi.mock("@kason/db", () => ({
  getDb: () => ({ listing: { findUnique: vi.fn() } }),
}));

import { listingsRoutes } from "../listings.routes";

function makeApp(session: SessionPayload | null) {
  const app = new Hono<{ Variables: { session: SessionPayload } }>();
  app.use("*", async (c, next) => {
    if (session) c.set("session", session);
    await next();
  });
  app.route("/", listingsRoutes);
  return app;
}

const adminSession: SessionPayload = { userId: "u1", orgId: "o1", role: "admin", userType: "operator" };
const editorSession: SessionPayload = { userId: "u2", orgId: "o1", role: "editor", userType: "operator" };
const viewerSession: SessionPayload = { userId: "u3", orgId: "o1", role: "viewer", userType: "operator" };
const agentSession: SessionPayload = { userId: "u4", orgId: "o1", role: "admin", userType: "agent" };

describe("GET /listings/explorer auth", () => {
  it("missing session → 401 Unauthorized", async () => {
    const res = await makeApp(null).request("/explorer");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("editor operator can access (200)", async () => {
    listExplorerUnitsMock.mockResolvedValue([]);
    const res = await makeApp(editorSession).request("/explorer");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rows: [] });
  });

  it("admin operator can access (200)", async () => {
    listExplorerUnitsMock.mockResolvedValue([{ id: "u1", unitCode: "A-1" }]);
    const res = await makeApp(adminSession).request("/explorer");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rows).toHaveLength(1);
  });

  it("viewer operator gets 403 (below editor gate)", async () => {
    const res = await makeApp(viewerSession).request("/explorer");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });

  it("agent userType gets 403 (operator-only gate)", async () => {
    const res = await makeApp(agentSession).request("/explorer");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });

  it("calls listExplorerUnits with session.orgId", async () => {
    listExplorerUnitsMock.mockClear();
    listExplorerUnitsMock.mockResolvedValue([]);
    await makeApp(editorSession).request("/explorer");
    expect(listExplorerUnitsMock).toHaveBeenCalledWith("o1");
  });
});
