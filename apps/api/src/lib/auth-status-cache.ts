// ── Auth status cache (60 s TTL) ─────────────────────────
// Encapsulates the per-user status cache used by auth middleware.
// get() is TTL-aware: expired entries are treated as misses (returns undefined).
// delete() enables synchronous cache invalidation (e.g. revoke-portal-access).

const STATUS_TTL_MS = 60_000;
const _cache = new Map<string, { status: string; ts: number }>();

export const authStatusCache = {
  get(userId: string): { status: string; ts: number } | undefined {
    const entry = _cache.get(userId);
    if (entry && Date.now() - entry.ts < STATUS_TTL_MS) {
      return entry;
    }
    return undefined;
  },

  set(userId: string, status: string): void {
    _cache.set(userId, { status, ts: Date.now() });
  },

  delete(userId: string): void {
    _cache.delete(userId);
  },
};
