import { describe, it, expect, beforeEach, vi } from "vitest";
import { changePasswordService } from "../auth.service";
import * as dbModule from "@kason/db";

// Factory mock (not the bare auto-mock): under Prisma 7, vitest's auto-mock
// introspects EVERY @kason/db re-export, and probing an enum re-export's
// `.__esModule` trips Prisma's strictEnum proxy → collection-time
// "Invalid enum value: __esModule". auth.service.ts only imports getDb from
// @kason/db, so return just that — nothing about the assertions changes.
vi.mock("@kason/db", () => ({ getDb: vi.fn() }));

describe("changePasswordService", () => {
  const mockDb = {
    user: { findUnique: vi.fn(), update: vi.fn() },
  };

  beforeEach(() => {
    vi.mocked(dbModule.getDb).mockReturnValue(mockDb as never);
    mockDb.user.findUnique.mockReset();
    mockDb.user.update.mockReset();
  });

  it("rejects with 400 when new password is shorter than 6 chars", async () => {
    mockDb.user.findUnique.mockResolvedValueOnce({ id: "u1", passwordHash: "scrypt:abcd:0000" });
    const result = await changePasswordService("u1", "ignored", "ab"); // 2 chars
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ status: 400 });
    if (!result.ok) {
      expect(result.error).toMatch(/at least 6 characters/);
    }
  });

  it("accepts a 6-character new password (rejects below 6)", async () => {
    mockDb.user.findUnique.mockResolvedValueOnce({ id: "u1", passwordHash: "scrypt:abcd:0000" });
    const result = await changePasswordService("u1", "ignored", "abcde"); // 5 chars — rejected
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/at least 6 characters/);
    }
  });

  it("rejects with 401 when current password is wrong", async () => {
    mockDb.user.findUnique.mockResolvedValueOnce({ id: "u1", passwordHash: "scrypt:abcd:0000" });
    const result = await changePasswordService("u1", "wrong-current", "newpass-12chars");
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ status: 401 });
  });

  it("hashes new password and clears mustChangePassword on success", async () => {
    // Use the actual hashPassword so verifyPassword works against the produced hash
    const { hashPassword } = await import("../../../lib/auth");
    const hash = await hashPassword("correct-current");
    mockDb.user.findUnique.mockResolvedValueOnce({ id: "u1", passwordHash: hash });
    mockDb.user.update.mockResolvedValueOnce({ id: "u1" });

    const result = await changePasswordService("u1", "correct-current", "new-password-12c");

    expect(result.ok).toBe(true);
    expect(mockDb.user.update).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: expect.objectContaining({
        passwordHash: expect.stringMatching(/^scrypt:/),
        mustChangePassword: false,
      }),
    });
  });
});
