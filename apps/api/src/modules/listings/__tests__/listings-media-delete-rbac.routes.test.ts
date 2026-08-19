import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { SessionPayload } from "../../../lib/auth";

// vi.mock factories are hoisted — use vi.hoisted so the factory can see the mock.
const { removeMediaKeyMock } = vi.hoisted(() => ({
  removeMediaKeyMock: vi.fn(),
}));

// Only removeMediaKey is exercised here; stub the rest so the routes file compiles.
vi.mock("../listings-media-upload.service", () => ({
  buildMediaUploadUrl: vi.fn(),
  completeMediaUpload: vi.fn(),
  removeMediaKey: removeMediaKeyMock,
}));
vi.mock("../listings-explorer.service", () => ({
  listExplorerUnits: vi.fn(),
}));
vi.mock("../listings.service", () => ({
  createListingService: vi.fn(),
  deactivateListingService: vi.fn(),
  deleteListingService: vi.fn(),
  getDeactivationPreviewService: vi.fn(),
  getDeletionPreviewService: vi.fn(),
  getListingByIdService: vi.fn(),
  getListingsService: vi.fn(),
  reactivateListingService: vi.fn(),
  updateListingService: vi.fn(),
}));
vi.mock("../listings-media.service", () => ({
  isVideoKey: vi.fn(),
  stripExifInPlace: vi.fn(),
  transcodeVideoInPlace: vi.fn(),
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

const UNIT = "11111111-1111-1111-1111-111111111111";
const KEY = `units/${UNIT}/22222222-2222-2222-2222-222222222222.jpg`;
const del = (session: SessionPayload | null) =>
  makeApp(session).request(`/${UNIT}/media?key=${encodeURIComponent(KEY)}`, {
    method: "DELETE",
  });

const adminSession: SessionPayload = { userId: "u1", orgId: "o1", role: "admin", userType: "operator" };
const managerSession: SessionPayload = { userId: "u2", orgId: "o1", role: "manager", userType: "operator" };
const editorSession: SessionPayload = { userId: "u3", orgId: "o1", role: "editor", userType: "operator" };
const viewerSession: SessionPayload = { userId: "u4", orgId: "o1", role: "viewer", userType: "operator" };
const agentSession: SessionPayload = { userId: "u5", orgId: "o1", role: "admin", userType: "agent" };

describe("DELETE /listings/:id/media — RBAC (editor+ can delete media)", () => {
  beforeEach(() => {
    removeMediaKeyMock.mockReset();
    removeMediaKeyMock.mockResolvedValue({
      ok: true,
      data: { photoKeys: [], videoKeys: [] },
    });
  });

  it("editor operator can delete media (200) — this is the widened gate", async () => {
    const res = await del(editorSession);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { photoKeys: [], videoKeys: [] } });
    expect(removeMediaKeyMock).toHaveBeenCalledWith({
      orgId: "o1",
      unitId: UNIT,
      storageKey: KEY,
    });
  });

  it("manager operator can delete media (200)", async () => {
    const res = await del(managerSession);
    expect(res.status).toBe(200);
  });

  it("admin operator can delete media (200)", async () => {
    const res = await del(adminSession);
    expect(res.status).toBe(200);
  });

  it("viewer operator gets 403 (below editor gate) and never reaches the service", async () => {
    const res = await del(viewerSession);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
    expect(removeMediaKeyMock).not.toHaveBeenCalled();
  });

  it("agent userType gets 403 (operator-only gate)", async () => {
    const res = await del(agentSession);
    expect(res.status).toBe(403);
  });

  it("missing session → 401", async () => {
    const res = await del(null);
    expect(res.status).toBe(401);
  });

  it("editor with no key query param → 400 (gate passed, handler validates input)", async () => {
    const res = await makeApp(editorSession).request(`/${UNIT}/media`, {
      method: "DELETE",
    });
    expect(res.status).toBe(400);
    expect(removeMediaKeyMock).not.toHaveBeenCalled();
  });
});
