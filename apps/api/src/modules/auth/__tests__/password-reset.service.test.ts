import { describe, it, expect, beforeEach, vi } from "vitest";

const mockDb = {
  user: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  $transaction: vi.fn(async (cb: any) => cb(mockDb)),
  auditLog: { create: vi.fn() },
};

vi.mock("@kason/db", () => ({ getDb: () => mockDb }));

vi.mock("../../../lib/email", () => ({
  sendEmail: vi.fn(async () => ({ success: true, messageId: "x" })),
}));

import {
  requestPasswordResetService,
  resetPasswordService,
  verifyResetTokenService,
} from "../auth.service";
import { sendEmail } from "../../../lib/email";
import { createSessionToken, hashPassword } from "../../../lib/auth";

const mockSendEmail = vi.mocked(sendEmail);

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-secret-min-32-chars-long-aaaaaaaa";
  process.env.APP_URL = "https://admin.test";
});

describe("requestPasswordResetService (admin)", () => {
  it("returns ok and does NOT call sendEmail when email is not found", async () => {
    mockDb.user.findFirst.mockResolvedValueOnce(null);
    const res = await requestPasswordResetService("missing@test.com");
    expect(res.ok).toBe(true);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("stores SHA-256 hash and calls sendEmail when email exists", async () => {
    mockDb.user.findFirst.mockResolvedValueOnce({
      id: "u1", organizationId: "org1", email: "alice@test.com", fullName: "Alice", userType: "operator",
    });
    mockDb.user.update.mockResolvedValueOnce({ id: "u1" });

    const res = await requestPasswordResetService("alice@test.com");
    expect(res.ok).toBe(true);
    expect(mockDb.user.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "u1" },
      data: expect.objectContaining({ resetTokenHash: expect.stringMatching(/^[a-f0-9]{64}$/) }),
    }));
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const sent = mockSendEmail.mock.calls[0][0];
    expect(sent.to).toBe("alice@test.com");
    expect(sent.subject).toContain("Kason-Hub");
    expect(sent.body).toContain("admin password");
    expect(sent.text).toBeTruthy();
    expect(sent.body).toContain("https://admin.test/reset-password?token=");
  });

  it("returns ok even when sendEmail fails (no enumeration leak)", async () => {
    mockDb.user.findFirst.mockResolvedValueOnce({
      id: "u1", organizationId: "org1", email: "alice@test.com", fullName: "Alice", userType: "operator",
    });
    mockDb.user.update.mockResolvedValueOnce({ id: "u1" });
    mockSendEmail.mockResolvedValueOnce({ success: false, error: "ses-error" });

    const res = await requestPasswordResetService("alice@test.com");
    expect(res.ok).toBe(true);
  });
});

describe("verifyResetTokenService (admin)", () => {
  it("rejects an invalid/forged token", async () => {
    const res = await verifyResetTokenService("not-a-jwt", "admin");
    expect(res.ok).toBe(false);
  });

  it("rejects a token with the wrong surface (portal token used on admin)", async () => {
    const portalToken = await createSessionToken("u1", "org1", "reset", { iss: "reset", aud: "reset:portal" }, "15m");
    const res = await verifyResetTokenService(portalToken, "admin");
    expect(res.ok).toBe(false);
  });

  it("rejects when DB hash does not match (already consumed or new request issued)", async () => {
    const token = await createSessionToken("u1", "org1", "reset", { iss: "reset", aud: "reset:admin" }, "15m");
    mockDb.user.findUnique.mockResolvedValueOnce({ id: "u1", fullName: "Alice", resetTokenHash: "different-hash" });
    const res = await verifyResetTokenService(token, "admin");
    expect(res.ok).toBe(false);
  });

  it("returns ok and fullName when token + hash + surface all match", async () => {
    const token = await createSessionToken("u1", "org1", "reset", { iss: "reset", aud: "reset:admin" }, "15m");
    // sha256(token) — mirror the service's hashing
    const crypto = await import("node:crypto");
    const hash = crypto.createHash("sha256").update(token).digest("hex");
    mockDb.user.findUnique.mockResolvedValueOnce({ id: "u1", fullName: "Alice", resetTokenHash: hash, status: "active" });
    const res = await verifyResetTokenService(token, "admin");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.fullName).toBe("Alice");
  });
});

describe("resetPasswordService (admin)", () => {
  it("rejects when token is invalid", async () => {
    const res = await resetPasswordService("not-a-jwt", "newpass-12c");
    expect(res.ok).toBe(false);
  });

  it("hashes new password, clears resetTokenHash, sets mustChangePassword=false, writes audit", async () => {
    const token = await createSessionToken("u1", "org1", "reset", { iss: "reset", aud: "reset:admin" }, "15m");
    const crypto = await import("node:crypto");
    const hash = crypto.createHash("sha256").update(token).digest("hex");
    mockDb.user.findUnique.mockResolvedValueOnce({
      id: "u1", organizationId: "org1", role: "admin", resetTokenHash: hash, status: "active",
    });
    mockDb.user.update.mockResolvedValueOnce({ id: "u1" });
    mockDb.auditLog.create.mockResolvedValueOnce({ id: "a1" });

    const res = await resetPasswordService(token, "newpass-12c");
    expect(res.ok).toBe(true);
    expect(mockDb.user.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "u1" },
      data: expect.objectContaining({
        passwordHash: expect.stringMatching(/^scrypt:/),
        resetTokenHash: null,
        mustChangePassword: false,
      }),
    }));
    expect(mockDb.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        actorUserId: "u1",
        action: "user.password_reset",
        entityType: "user",
        entityId: "u1",
      }),
    }));
  });

  it("rejects on second use (resetTokenHash cleared after first reset)", async () => {
    const token = await createSessionToken("u1", "org1", "reset", { iss: "reset", aud: "reset:admin" }, "15m");
    mockDb.user.findUnique.mockResolvedValueOnce({
      id: "u1", organizationId: "org1", role: "admin", resetTokenHash: null, status: "active",
    });
    const res = await resetPasswordService(token, "newpass-12c");
    expect(res.ok).toBe(false);
  });

  it("rejects when surface claim doesn't match (portal token used on admin reset)", async () => {
    const portalToken = await createSessionToken("u1", "org1", "reset", { iss: "reset", aud: "reset:portal" }, "15m");
    const res = await resetPasswordService(portalToken, "newpass-12c");
    expect(res.ok).toBe(false);
  });
});
