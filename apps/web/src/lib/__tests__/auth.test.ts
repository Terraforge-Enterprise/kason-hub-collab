import { describe, it, expect, vi, afterEach } from "vitest";
import { setPortalToken, setAdminToken, storeUser, getPortalToken, getAdminToken } from "../auth";

// localStorage.setItem throws in real browsers far more often than it looks:
// Safari Private Browsing, "block all cookies", hardened/enterprise profiles,
// and a full quota all raise on WRITE. The readers here (getPortalToken,
// getAdminToken, getStoredUser) and clearStoredAuth already guard for exactly
// that — clearStoredAuth's comment spells out why ("must not throw or the 401
// redirect to login never runs"). The writers were the asymmetry.
//
// The concrete damage: portal/change-password-page.tsx and portal/login.tsx
// both call setPortalToken and THEN navigate. An unguarded throw skips the
// navigate, so the user's password change (or login) has actually succeeded on
// the server while the UI strands them on the form with no feedback.
function withBlockedStorage(fn: () => void) {
  const spy = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
}

describe("auth storage writers — must not throw when storage is blocked", () => {
  afterEach(() => vi.restoreAllMocks());

  it("setPortalToken swallows a blocked write", () => {
    withBlockedStorage(() => {
      expect(() => setPortalToken("tok")).not.toThrow();
    });
  });

  it("setAdminToken swallows a blocked write", () => {
    withBlockedStorage(() => {
      expect(() => setAdminToken("tok")).not.toThrow();
    });
  });

  it("storeUser swallows a blocked write", () => {
    withBlockedStorage(() => {
      expect(() =>
        storeUser({ id: "u1", fullName: "A", email: "a@b.c", role: "admin", orgId: "o1" }),
      ).not.toThrow();
    });
  });

  it("still round-trips normally when storage works", () => {
    setPortalToken("portal-tok");
    setAdminToken("admin-tok");
    expect(getPortalToken()).toBe("portal-tok");
    expect(getAdminToken()).toBe("admin-tok");
  });
});
