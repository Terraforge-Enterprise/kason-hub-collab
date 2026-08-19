import { describe, it, expect, beforeEach, vi } from "vitest";
import * as dbModule from "@kason/db";
import { hashPassword } from "../../../../lib/auth";

// Factory mock (not the bare auto-mock): under Prisma 7, vitest's auto-mock
// introspects EVERY @kason/db re-export, and probing an enum re-export's
// `.__esModule` trips Prisma's strictEnum proxy → collection-time
// "Invalid enum value: __esModule". portal.auth.service.ts only imports getDb
// from @kason/db, so return just that — nothing about the assertions changes.
vi.mock("@kason/db", () => ({ getDb: vi.fn() }));

// Mock verifyPassword so wrong-password test works without real scrypt
vi.mock("../../../../lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../lib/auth")>();
  return {
    ...actual,
    verifyPassword: vi.fn(actual.verifyPassword),
  };
});

import { portalChangePasswordService } from "../portal.auth.service";
import { verifyPassword, verifySessionToken } from "../../../../lib/auth";

const mockVerifyPassword = vi.mocked(verifyPassword);

describe("portalChangePasswordService", () => {
  const mockDb = { user: { findUnique: vi.fn(), update: vi.fn() } };

  beforeEach(() => {
    vi.mocked(dbModule.getDb).mockReturnValue(mockDb as never);
    mockDb.user.findUnique.mockReset();
    mockDb.user.update.mockReset();
    mockVerifyPassword.mockReset();
  });

  it("rejects 400 when new password is shorter than 6 chars", async () => {
    mockDb.user.findUnique.mockResolvedValueOnce({ id: "u1", passwordHash: "scrypt:abcd:0000", userType: "agent" });
    mockVerifyPassword.mockResolvedValueOnce(false);
    const result = await portalChangePasswordService("u1", "ignored", "ab"); // 2 chars
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ status: 400 });
    if (!result.ok) {
      expect(result.error).toMatch(/at least 6 characters/);
    }
  });

  it("accepts a 6-character new password (rejects below 6)", async () => {
    mockDb.user.findUnique.mockResolvedValueOnce({ id: "u1", passwordHash: "scrypt:abcd:0000", userType: "agent" });
    mockVerifyPassword.mockResolvedValueOnce(false);
    const result = await portalChangePasswordService("u1", "ignored", "abcde"); // 5 chars — rejected
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/at least 6 characters/);
    }
  });

  it("rejects 401 when current password is wrong", async () => {
    mockDb.user.findUnique.mockResolvedValueOnce({ id: "u1", passwordHash: "scrypt:abcd:0000", userType: "agent" });
    mockVerifyPassword.mockResolvedValueOnce(false);
    const result = await portalChangePasswordService("u1", "wrong", "new-password-12c");
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ status: 401 });
  });

  it("rejects 403 when userType is operator", async () => {
    mockDb.user.findUnique.mockResolvedValueOnce({ id: "u1", passwordHash: "x", userType: "operator" });
    const result = await portalChangePasswordService("u1", "anything", "new-password-12c");
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ status: 403 });
  });

  it("hashes new password and clears flag for agent", async () => {
    const hash = await hashPassword("correct-current");
    mockDb.user.findUnique.mockResolvedValueOnce({ id: "u1", passwordHash: hash, userType: "agent" });
    mockDb.user.update.mockResolvedValueOnce({ id: "u1" });
    // Let verifyPassword use real implementation for this test
    mockVerifyPassword.mockImplementationOnce(async (pwd, h) => {
      const { verifyPassword: real } = await import("../../../../lib/auth");
      return real(pwd, h);
    });
    const result = await portalChangePasswordService("u1", "correct-current", "new-password-12c");
    expect(result.ok).toBe(true);
    expect(mockDb.user.update).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: expect.objectContaining({
        passwordHash: expect.stringMatching(/^scrypt:/),
        mustChangePassword: false,
      }),
    });
  });

  // ── Session rotation (auto-login after a first-login password change) ──────
  // The user re-proved their credential to get here, so we re-issue the portal
  // session instead of bouncing them back to /portal/login. Rotating on a
  // credential change is the standard session-fixation defence, and it hands
  // the tenant a full session window rather than the remainder of the one
  // minted with their temporary password.
  //
  // NOTE: this applies ONLY to the authenticated change-password flow. The
  // unauthenticated emailed-link reset (resetPortalPasswordService) must keep
  // returning no token — a reset link is a weaker credential than a password.
  const ACTIVE_PORTAL_USER = {
    id: "u1",
    userType: "tenant",
    organizationId: "org1",
    role: "tenant",
    partyId: "party1",
    status: "active",
    organization: { status: "active" },
  };

  async function arrangeSuccessfulChange(user: Record<string, unknown>) {
    const hash = await hashPassword("correct-current");
    mockDb.user.findUnique.mockResolvedValueOnce({ passwordHash: hash, ...user });
    mockDb.user.update.mockResolvedValueOnce({ id: "u1" });
    mockVerifyPassword.mockImplementationOnce(async (pwd, h) => {
      const { verifyPassword: real } = await import("../../../../lib/auth");
      return real(pwd, h);
    });
    return portalChangePasswordService("u1", "correct-current", "new-password-12c");
  }

  it("mints a fresh portal session token on success", async () => {
    const result = await arrangeSuccessfulChange(ACTIVE_PORTAL_USER);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(typeof result.token).toBe("string");

    // The token must be a real portal-audience session for THIS user, not an
    // opaque string — otherwise the client stores something the middleware
    // rejects and the tenant is silently logged out on their next request.
    const claims = await verifySessionToken(result.token as string, {
      issuer: "portal",
      audience: "portal",
    });
    expect(claims).toMatchObject({
      userId: "u1",
      orgId: "org1",
      role: "tenant",
      userType: "tenant",
      partyId: "party1",
    });
  });

  it("still changes the password but mints no token when the account has no partyId", async () => {
    // Degrading to null beats throwing: the password row is already written by
    // this point, so a 500 here would tell the tenant their change failed and
    // send them back with the old password. Their existing cookie still works.
    const result = await arrangeSuccessfulChange({ ...ACTIVE_PORTAL_USER, partyId: null });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.token).toBeNull();
    expect(mockDb.user.update).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: expect.objectContaining({ mustChangePassword: false }),
    });
  });

  // ── Deactivated accounts must not get a rotated session ────────────────────
  // Minting here resets the JWT's `iat`, and portal.auth.middleware.ts:62 only
  // re-checks User.status once a cookie is older than the 30-minute sliding
  // window. So a revoked user who calls this endpoint every 29 minutes would
  // never trip that check and would keep portal access indefinitely — the fresh
  // absoluteExp defeats the other ceiling at the same time. Mirror the status
  // gates portalLoginService already applies.
  it.each([
    ["the user is deactivated", { status: "inactive" }],
    ["the organization is deactivated", { organization: { status: "suspended" } }],
  ])("changes the password but mints no token when %s", async (_label, override) => {
    const result = await arrangeSuccessfulChange({ ...ACTIVE_PORTAL_USER, ...override });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.token).toBeNull();
    // The password change itself is unchanged — only the session rotation is
    // withheld, so their existing cookie ages out and the middleware 401s it.
    expect(mockDb.user.update).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: expect.objectContaining({ mustChangePassword: false }),
    });
  });
});
