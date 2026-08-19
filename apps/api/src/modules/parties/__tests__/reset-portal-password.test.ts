import { describe, it, expect, beforeEach, vi } from "vitest";
import { resetPortalPasswordService } from "../parties.service";
import * as dbModule from "@kason/db";

vi.mock("@kason/db", () => ({
  getDb: vi.fn(() => mockDb),
}));

vi.mock("../../../lib/auth", () => ({
  hashPassword: vi.fn().mockResolvedValue("scrypt:hashed-password"),
}));

const mockDb = {
  user: { findFirst: vi.fn(), update: vi.fn() },
};

describe("resetPortalPasswordService", () => {
  const session = { orgId: "org-1", userId: "admin-1", role: "manager" };

  beforeEach(() => {
    vi.mocked(dbModule.getDb).mockReturnValue(mockDb as never);
    mockDb.user.findFirst.mockReset();
    mockDb.user.update.mockReset();
  });

  it("rejects 403 when caller role is editor", async () => {
    const editorSession = { ...session, role: "editor" };
    const result = await resetPortalPasswordService(editorSession, "party-1", { password: "TempPass1" });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ status: 403 });
  });

  it("rejects 404 when no User exists for the party", async () => {
    mockDb.user.findFirst.mockResolvedValueOnce(null);
    const result = await resetPortalPasswordService(session, "party-1", { password: "TempPass1" });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ status: 404 });
  });

  it("hashes new password and sets mustChangePassword=true on success", async () => {
    mockDb.user.findFirst.mockResolvedValueOnce({ id: "u1", organizationId: "org-1" });
    mockDb.user.update.mockResolvedValueOnce({ id: "u1" });
    const result = await resetPortalPasswordService(session, "party-1", { password: "TempPass1" });
    expect(result.ok).toBe(true);
    expect(mockDb.user.update).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: expect.objectContaining({
        passwordHash: expect.stringMatching(/^scrypt:/),
        mustChangePassword: true,
        status: "active",
      }),
    });
  });
});
