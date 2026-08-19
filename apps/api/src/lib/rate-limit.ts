export type RateLimitEntry = { count: number; resetAt: number };
export type RateLimitBucket = Map<string, RateLimitEntry>;

export type RateLimitResult =
  | { ok: true }
  | { ok: false; retryAfter: number };

export function checkPerKey(
  bucket: RateLimitBucket,
  key: string,
  max: number,
  windowMs: number,
): RateLimitResult {
  const now = Date.now();
  const entry = bucket.get(key);
  if (!entry || now > entry.resetAt) {
    bucket.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true };
  }
  entry.count++;
  if (entry.count <= max) return { ok: true };
  return { ok: false, retryAfter: Math.max(0, Math.ceil((entry.resetAt - now) / 1000)) };
}

export function clearKey(bucket: RateLimitBucket, key: string): void {
  bucket.delete(key);
}

export function checkCompound(
  ...checks: Array<() => RateLimitResult>
): RateLimitResult {
  let worstRetryAfter = 0;
  let blocked = false;
  for (const check of checks) {
    const r = check();
    if (!r.ok) {
      blocked = true;
      if (r.retryAfter > worstRetryAfter) worstRetryAfter = r.retryAfter;
    }
  }
  return blocked ? { ok: false, retryAfter: worstRetryAfter } : { ok: true };
}
