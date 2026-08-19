import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { PortalEnv } from "../../auth/portal.auth.types";

const { mockGet, mockUpdate, mockMint, mockBank } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockUpdate: vi.fn(),
  mockMint: vi.fn(),
  mockBank: vi.fn(),
}));

vi.mock("../portal.profile.repository", () => ({
  getProfile: mockGet,
  updateAgentBankDetails: mockBank,
  updateMyPortalProfile: mockUpdate,
  mintPortalAvatarUploadUrl: mockMint,
}));

import { portalProfileRoutes } from "../portal.profile.routes";

function makeApp(userType: "agent" | "tenant" = "agent") {
  const app = new Hono<PortalEnv>();
  app.use("*", async (c, next) => {
    c.set("session", {
      partyId: "party-1",
      orgId: "org-1",
      userId: "user-1",
      userType,
    } as never);
    await next();
  });
  app.route("/", portalProfileRoutes);
  return app;
}

describe("portal.profile.routes — PATCH /me", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects non-agent userType with 403", async () => {
    const app = makeApp("tenant");
    const res = await app.request("/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fullName: "X" }),
    });
    expect(res.status).toBe(403);
  });

  it("updates profile for agent and returns 200", async () => {
    mockUpdate.mockResolvedValueOnce({ ok: true });
    const app = makeApp("agent");
    const res = await app.request("/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fullName: "New" }),
    });
    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ partyId: "party-1" }),
      { fullName: "New" },
    );
  });

  it("returns 400 on empty body", async () => {
    const app = makeApp("agent");
    const res = await app.request("/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe("portal.profile.routes — POST /avatar/upload-url", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects non-agent userType with 403", async () => {
    const app = makeApp("tenant");
    const res = await app.request("/avatar/upload-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contentType: "image/jpeg", sizeBytes: 100 }),
    });
    expect(res.status).toBe(403);
  });

  it("returns the signed URL for agents", async () => {
    mockMint.mockResolvedValueOnce({
      ok: true,
      data: { url: "https://put.example", key: "avatars/parties/party-1/uuid.jpg", headers: {} },
    });
    const app = makeApp("agent");
    const res = await app.request("/avatar/upload-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contentType: "image/jpeg", sizeBytes: 100000 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.url).toBe("https://put.example");
  });

  it("returns 400 on bad MIME", async () => {
    mockMint.mockResolvedValueOnce({ ok: false, status: 400, error: "bad mime" });
    const app = makeApp("agent");
    const res = await app.request("/avatar/upload-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contentType: "application/pdf", sizeBytes: 100 }),
    });
    expect(res.status).toBe(400);
  });
});
