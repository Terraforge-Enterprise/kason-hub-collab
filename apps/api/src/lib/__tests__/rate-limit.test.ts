import { describe, it, expect, beforeEach, vi } from "vitest";
import { checkPerKey, checkCompound, type RateLimitBucket } from "../rate-limit";

describe("checkPerKey", () => {
  let bucket: RateLimitBucket;
  beforeEach(() => {
    bucket = new Map();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-04T00:00:00Z"));
  });

  it("allows up to max requests per window", () => {
    for (let i = 0; i < 3; i++) {
      const res = checkPerKey(bucket, "alice@example.com", 3, 60_000);
      expect(res.ok).toBe(true);
    }
  });

  it("blocks the (max+1)th request and reports retryAfter", () => {
    for (let i = 0; i < 3; i++) checkPerKey(bucket, "alice@example.com", 3, 60_000);
    const res = checkPerKey(bucket, "alice@example.com", 3, 60_000);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.retryAfter).toBeGreaterThan(0);
      expect(res.retryAfter).toBeLessThanOrEqual(60);
    }
  });

  it("resets the counter after the window expires", () => {
    for (let i = 0; i < 3; i++) checkPerKey(bucket, "alice@example.com", 3, 60_000);
    vi.advanceTimersByTime(61_000);
    const res = checkPerKey(bucket, "alice@example.com", 3, 60_000);
    expect(res.ok).toBe(true);
  });

  it("isolates different keys", () => {
    for (let i = 0; i < 3; i++) checkPerKey(bucket, "alice@example.com", 3, 60_000);
    const res = checkPerKey(bucket, "bob@example.com", 3, 60_000);
    expect(res.ok).toBe(true);
  });
});

describe("checkCompound", () => {
  it("returns ok when all sub-checks pass", () => {
    const a: RateLimitBucket = new Map();
    const b: RateLimitBucket = new Map();
    const res = checkCompound(
      () => checkPerKey(a, "k1", 5, 60_000),
      () => checkPerKey(b, "k2", 5, 60_000),
    );
    expect(res.ok).toBe(true);
  });

  it("returns the most-restrictive retryAfter when any sub-check fails", () => {
    const a: RateLimitBucket = new Map();
    const b: RateLimitBucket = new Map();
    // Burn through bucket b
    for (let i = 0; i < 5; i++) checkPerKey(b, "k2", 5, 60_000);
    const res = checkCompound(
      () => checkPerKey(a, "k1", 5, 60_000),
      () => checkPerKey(b, "k2", 5, 60_000),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.retryAfter).toBeGreaterThan(0);
  });
});
