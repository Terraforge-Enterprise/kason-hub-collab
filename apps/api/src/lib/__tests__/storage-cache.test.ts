import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signedUrlCache } from "../storage-cache";

describe("signedUrlCache", () => {
  beforeEach(() => {
    signedUrlCache.clear();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns null on miss", () => {
    expect(signedUrlCache.get("missing")).toBeNull();
  });

  it("returns the URL on hit when entry is fresh", () => {
    signedUrlCache.set("key1", "https://signed/url1", 1800);
    expect(signedUrlCache.get("key1")).toBe("https://signed/url1");
  });

  it("treats an entry as a miss once it has expired, and deletes it", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T00:00:00.000Z"));
    // Use ttl=120s → cache lifetime 60s after the 60s safety margin.
    signedUrlCache.set("key1", "https://signed/url1", 120);
    // Advance 60_001 ms past the safety margin.
    vi.setSystemTime(new Date("2026-05-20T00:01:00.001Z"));
    expect(signedUrlCache.get("key1")).toBeNull();
    expect(signedUrlCache.size()).toBe(0);
  });

  it("set() is a no-op when ttlSeconds <= SAFETY_MARGIN_SECONDS", () => {
    signedUrlCache.set("k_at_margin", "https://signed/url1", 60); // exactly the margin
    signedUrlCache.set("k_below_margin", "https://signed/url2", 30); // below the margin
    signedUrlCache.set("k_one_below", "https://signed/url3", 59); // 1s below
    expect(signedUrlCache.size()).toBe(0);
    expect(signedUrlCache.get("k_at_margin")).toBeNull();
    expect(signedUrlCache.get("k_below_margin")).toBeNull();
    expect(signedUrlCache.get("k_one_below")).toBeNull();
  });

  it("keeps an entry one millisecond before the safety margin", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T00:00:00.000Z"));
    signedUrlCache.set("key1", "https://signed/url1", 1800); // cache lifetime 1740s
    // 1 ms before the boundary
    vi.setSystemTime(new Date("2026-05-20T00:28:59.999Z"));
    expect(signedUrlCache.get("key1")).toBe("https://signed/url1");
  });

  it("evicts an entry at the exact safety margin boundary (>= semantics)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T00:00:00.000Z"));
    signedUrlCache.set("key1", "https://signed/url1", 1800); // cache lifetime 1740s
    // Exactly at the boundary — get must report null because we use >= not >
    vi.setSystemTime(new Date("2026-05-20T00:29:00.000Z"));
    expect(signedUrlCache.get("key1")).toBeNull();
    expect(signedUrlCache.size()).toBe(0);
  });

  it("isolates entries by key", () => {
    signedUrlCache.set("k1", "https://u1", 1800);
    signedUrlCache.set("k2", "https://u2", 1800);
    expect(signedUrlCache.get("k1")).toBe("https://u1");
    expect(signedUrlCache.get("k2")).toBe("https://u2");
    expect(signedUrlCache.size()).toBe(2);
  });

  it("delete(key) removes one entry, leaves others alone", () => {
    signedUrlCache.set("k1", "https://u1", 1800);
    signedUrlCache.set("k2", "https://u2", 1800);
    signedUrlCache.delete("k1");
    expect(signedUrlCache.get("k1")).toBeNull();
    expect(signedUrlCache.get("k2")).toBe("https://u2");
    expect(signedUrlCache.size()).toBe(1);
  });

  it("clear() empties the cache", () => {
    signedUrlCache.set("k1", "https://u1", 1800);
    signedUrlCache.set("k2", "https://u2", 1800);
    signedUrlCache.clear();
    expect(signedUrlCache.size()).toBe(0);
  });

  it("__sweep() drops expired entries and reports the count", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T00:00:00.000Z"));
    signedUrlCache.set("expiresSoon", "https://u1", 120);   // lifetime 60s after margin
    signedUrlCache.set("expiresLater", "https://u2", 1800); // lifetime 1740s after margin
    // Advance just past expiresSoon's window.
    vi.setSystemTime(new Date("2026-05-20T00:01:00.001Z"));
    const removed = signedUrlCache.__sweep();
    expect(removed).toBe(1);
    expect(signedUrlCache.size()).toBe(1);
    expect(signedUrlCache.get("expiresLater")).toBe("https://u2");
  });
});
