import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDb = {
  user: { findFirst: vi.fn() },
  tenancy: { findFirst: vi.fn() },
};

// Mock @kason/db — return the same singleton every call
vi.mock("@kason/db", () => ({
  getDb: vi.fn(() => mockDb),
}));

// Mock auth lib
vi.mock("../../../../lib/auth", () => ({
  createSessionToken: vi.fn().mockResolvedValue("mock-token"),
  verifyPassword: vi.fn(),
}));

import { portalLoginService } from "../portal.auth.service";
import { verifyPassword } from "../../../../lib/auth";

const mockVerifyPassword = vi.mocked(verifyPassword);

describe("portalLoginService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects non-tenant userType", async () => {
    mockDb.user.findFirst.mockResolvedValueOnce({
      id: "u1", organizationId: "org1", role: "admin", userType: "operator",
      partyId: "p1", passwordHash: "hash",
    });

    const result = await portalLoginService({ email: "test@test.com", password: "password123" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it("rejects null partyId", async () => {
    mockDb.user.findFirst.mockResolvedValueOnce({
      id: "u1", organizationId: "org1", role: "viewer", userType: "tenant",
      partyId: null, passwordHash: "hash",
    });

    const result = await portalLoginService({ email: "test@test.com", password: "password123" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it("rejects invalid password", async () => {
    mockDb.user.findFirst.mockResolvedValueOnce({
      id: "u1", organizationId: "org1", role: "viewer", userType: "tenant",
      partyId: "p1", passwordHash: "hash",
    });
    mockVerifyPassword.mockResolvedValueOnce(false);

    const result = await portalLoginService({ email: "test@test.com", password: "wrongpass1" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it("succeeds for a granted tenant even with NO active tenancy (access = grant, not lease)", async () => {
    // The active-lease/role gate was removed: portal access is controlled purely by the
    // granted User account (revoke to remove access), not the current lease/role status.
    mockDb.user.findFirst.mockResolvedValueOnce({
      id: "u1", organizationId: "org1", role: "viewer", userType: "tenant",
      partyId: "p1", passwordHash: "hash",
    });
    mockVerifyPassword.mockResolvedValueOnce(true);
    mockDb.tenancy.findFirst.mockResolvedValueOnce(null);

    const result = await portalLoginService({ email: "test@test.com", password: "password123" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.token).toBe("mock-token");
  });

  it("succeeds for valid tenant with active tenancy", async () => {
    mockDb.user.findFirst.mockResolvedValueOnce({
      id: "u1", organizationId: "org1", role: "viewer", userType: "tenant",
      partyId: "p1", passwordHash: "hash",
    });
    mockVerifyPassword.mockResolvedValueOnce(true);
    mockDb.tenancy.findFirst.mockResolvedValueOnce({ id: "t1" });

    const result = await portalLoginService({ email: "test@test.com", password: "password123" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.token).toBe("mock-token");
  });
});
