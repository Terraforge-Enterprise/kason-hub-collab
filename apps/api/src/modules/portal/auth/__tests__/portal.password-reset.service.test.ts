import { describe, it, expect, beforeEach, vi } from "vitest";

const mockDb = {
  user: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  $transaction: vi.fn(async (cb: any) => cb(mockDb)),
  auditLog: { create: vi.fn() },
};

vi.mock("@kason/db", () => ({ getDb: () => mockDb }));

vi.mock("../../../../lib/email", () => ({
  sendEmail: vi.fn(async () => ({ success: true, messageId: "x" })),
}));

import {
  requestPortalPasswordResetService,
  verifyPortalResetTokenService,
  resetPortalPasswordService,
} from "../portal.password-reset.service";
import { sendEmail } from "../../../../lib/email";
import { createSessionToken } from "../../../../lib/auth";

const mockSendEmail = vi.mocked(sendEmail);

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-secret-min-32-chars-long-aaaaaaaa";
  process.env.APP_URL = "https://portal.test";
});

describe("requestPortalPasswordResetService", () => {
  it("returns ok and does NOT send when email not found", async () => {
    mockDb.user.findFirst.mockResolvedValueOnce(null);
    const res = await requestPortalPasswordResetService("missing@test.com");
    expect(res.ok).toBe(true);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("filters by userType=agent (operator email returns ok with NO send)", async () => {
    // Repository call uses userType=agent in the where clause; mock returns null
    // to simulate "no match for that combination of email+userType"
    mockDb.user.findFirst.mockResolvedValueOnce(null);
    const res = await requestPortalPasswordResetService("alice-admin@test.com");
    expect(res.ok).toBe(true);
    expect(mockSendEmail).not.toHaveBeenCalled();
    // Verify the filter
    expect(mockDb.user.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ userType: "agent" }),
    }));
  });

  it("sends portal email using APP_URL with /portal prefix when agent exists", async () => {
    mockDb.user.findFirst.mockResolvedValueOnce({
      id: "u1", organizationId: "org1", email: "agent@test.com", fullName: "Agent A",
    });
    mockDb.user.update.mockResolvedValueOnce({ id: "u1" });

    const res = await requestPortalPasswordResetService("agent@test.com");
    expect(res.ok).toBe(true);
    const sent = mockSendEmail.mock.calls[0][0];
    expect(sent.body).toContain("agent password");
    expect(sent.body).toContain("https://portal.test/portal/reset-password?token=");
  });
});

describe("verifyPortalResetTokenService", () => {
  it("rejects an admin-surface token used on portal", async () => {
    const adminToken = await createSessionToken("u1", "org1", "reset", { iss: "reset", aud: "reset:admin" }, "15m");
    const res = await verifyPortalResetTokenService(adminToken);
    expect(res.ok).toBe(false);
  });

  it("accepts a valid portal token", async () => {
    const token = await createSessionToken("u1", "org1", "reset", { iss: "reset", aud: "reset:portal" }, "15m");
    const crypto = await import("node:crypto");
    const hash = crypto.createHash("sha256").update(token).digest("hex");
    mockDb.user.findUnique.mockResolvedValueOnce({ id: "u1", fullName: "Agent A", resetTokenHash: hash, status: "active" });
    const res = await verifyPortalResetTokenService(token);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.fullName).toBe("Agent A");
  });
});

describe("resetPortalPasswordService", () => {
  it("rejects admin-surface token", async () => {
    const adminToken = await createSessionToken("u1", "org1", "reset", { iss: "reset", aud: "reset:admin" }, "15m");
    const res = await resetPortalPasswordService(adminToken, "newpass-12c");
    expect(res.ok).toBe(false);
  });

  it("hashes new password, clears resetTokenHash, sets mustChangePassword=false, writes audit", async () => {
    const token = await createSessionToken("u1", "org1", "reset", { iss: "reset", aud: "reset:portal" }, "15m");
    const crypto = await import("node:crypto");
    const hash = crypto.createHash("sha256").update(token).digest("hex");
    mockDb.user.findUnique.mockResolvedValueOnce({
      id: "u1", organizationId: "org1", role: "viewer", resetTokenHash: hash, status: "active",
    });
    mockDb.user.update.mockResolvedValueOnce({ id: "u1" });
    mockDb.auditLog.create.mockResolvedValueOnce({ id: "a1" });

    const res = await resetPortalPasswordService(token, "newpass-12c");
    expect(res.ok).toBe(true);
    expect(mockDb.user.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        passwordHash: expect.stringMatching(/^scrypt:/),
        resetTokenHash: null,
        mustChangePassword: false,
      }),
    }));
    expect(mockDb.auditLog.create).toHaveBeenCalled();
  });
});
