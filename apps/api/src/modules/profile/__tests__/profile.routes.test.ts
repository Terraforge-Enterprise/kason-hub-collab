import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { SessionPayload } from "../../../lib/auth";

const { mockGet, mockUpdate, mockMint } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockUpdate: vi.fn(),
  mockMint: vi.fn(),
}));

vi.mock("../profile.service", () => ({
  getMyProfile: mockGet,
  updateMyProfile: mockUpdate,
  mintAvatarUploadUrl: mockMint,
}));

import { profileRoutes } from "../profile.routes";

function makeApp() {
  const app = new Hono<{ Variables: { session: SessionPayload } }>();
  app.use("*", async (c, next) => {
    c.set("session", { userId: "user-1", orgId: "org-1", role: "editor" } as SessionPayload);
    await next();
  });
  app.route("/", profileRoutes);
  return app;
}

describe("profile.routes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("GET /me returns the profile", async () => {
    mockGet.mockResolvedValueOnce({
      ok: true,
      data: { id: "user-1", email: "me@x.com", fullName: "Me", role: "editor", photoKey: null, photoUrl: null, mustChangePassword: false, lastLoginAt: null },
    });

    const app = makeApp();
    const res = await app.request("/me");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe("user-1");
    expect(mockGet).toHaveBeenCalled();
  });

  it("PATCH /me updates and returns 200 on success", async () => {
    mockUpdate.mockResolvedValueOnce({
      ok: true,
      data: { id: "user-1", email: "me@x.com", fullName: "New", role: "editor", photoKey: null, photoUrl: null, mustChangePassword: false, lastLoginAt: null },
    });

    const app = makeApp();
    const res = await app.request("/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fullName: "New" }),
    });
    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1" }),
      { fullName: "New" },
    );
  });

  it("PATCH /me returns 400 on invalid body", async () => {
    const app = makeApp();
    const res = await app.request("/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("POST /avatar/upload-url returns the signed URL", async () => {
    mockMint.mockResolvedValueOnce({
      ok: true,
      data: { url: "https://put.example", key: "avatars/users/user-1/uuid.jpg", headers: {} },
    });

    const app = makeApp();
    const res = await app.request("/avatar/upload-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contentType: "image/jpeg", sizeBytes: 100000 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.url).toBe("https://put.example");
  });

  it("POST /avatar/upload-url rejects non-image MIME", async () => {
    const app = makeApp();
    const res = await app.request("/avatar/upload-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contentType: "application/pdf", sizeBytes: 100 }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /avatar/upload-url rejects oversize", async () => {
    const app = makeApp();
    const res = await app.request("/avatar/upload-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contentType: "image/jpeg", sizeBytes: 6 * 1024 * 1024 }),
    });
    expect(res.status).toBe(400);
  });
});
