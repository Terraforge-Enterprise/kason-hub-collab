// Process-local cache of Supabase signed URLs.
//
// Why: minting a signed URL is a network round-trip to Supabase Storage
// (~25-30ms per key serially; 400-700ms when 20+ keys are signed in parallel
// on a single request due to internal serialization at Supabase). The URLs
// are valid for 30 minutes by default. Caching them in-process eliminates
// the round-trip on every refresh within the validity window.
//
// Why a 60s safety margin: a URL valid until exactly t=T may be in-flight to
// the browser at t=T-1 and arrive at Supabase at t=T+200ms, where it's
// rejected. We stop returning a cached URL when ≤60s remain so any URL
// handed out is guaranteed at least one full minute of validity.
//
// Lifecycle: a setInterval sweep runs every 5 minutes and drops any expired
// entries from the Map, even if no one looked them up. Without this, write-
// once-never-read entries would sit in the Map forever (memory leak in a
// long-lived container).

const SAFETY_MARGIN_SECONDS = 60;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

type Entry = { url: string; expiresAt: number };

const store = new Map<string, Entry>();

function get(key: string): string | null {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    store.delete(key);
    return null;
  }
  return entry.url;
}

function set(key: string, url: string, ttlSeconds: number): void {
  // Refuse to cache an entry that would already be past the safety margin.
  // Saves a Map.set + Map.delete cycle and surfaces the misconfiguration
  // by reporting a stale (size === 0) cache instead of a silently broken one.
  if (ttlSeconds <= SAFETY_MARGIN_SECONDS) return;
  const expiresAt = Date.now() + (ttlSeconds - SAFETY_MARGIN_SECONDS) * 1000;
  store.set(key, { url, expiresAt });
}

function del(key: string): void {
  store.delete(key);
}

function clear(): void {
  store.clear();
}

function size(): number {
  return store.size;
}

function __sweep(): number {
  const now = Date.now();
  let removed = 0;
  for (const [key, entry] of store.entries()) {
    if (now >= entry.expiresAt) {
      store.delete(key);
      removed++;
    }
  }
  return removed;
}

// Module-init: start the background sweep. Stored in module scope so the
// process holds a reference — Node will keep the event loop alive while the
// API container is up. Sweep runs ~hundreds of microseconds; harmless.
setInterval(__sweep, SWEEP_INTERVAL_MS).unref();

export const signedUrlCache = {
  get,
  set,
  delete: del,
  clear,
  size,
  __sweep,
};
