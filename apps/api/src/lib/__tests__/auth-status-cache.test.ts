import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { authStatusCache } from "../auth-status-cache";

describe("authStatusCache", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("returns the entry when set and retrieved within TTL", () => {
    authStatusCache.set("u-hit", "active");
    const got = authStatusCache.get("u-hit");
    expect(got).toBeDefined();
    expect(got?.status).toBe("active");
  });

  it("returns undefined after the TTL has elapsed", () => {
    authStatusCache.set("u-ttl", "active");
    vi.advanceTimersByTime(60_001);
    expect(authStatusCache.get("u-ttl")).toBeUndefined();
  });

  it("returns undefined immediately after delete", () => {
    authStatusCache.set("u-delete", "active");
    authStatusCache.delete("u-delete");
    expect(authStatusCache.get("u-delete")).toBeUndefined();
  });

  it("delete on unknown userId is a no-op and does not throw", () => {
    expect(() => authStatusCache.delete("u-nonexistent")).not.toThrow();
  });
});
