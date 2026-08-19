import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { runtimeConfig } from "./runtime-config";
import { signedUrlCache } from "./storage-cache";

const STORAGE_URL_TTL_SECONDS = runtimeConfig.limits.storageUrlTtlSec;

let _client: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (_client) return _client;
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  }
  _client = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _client;
}

export function requireBucket(): string {
  const bucket = process.env.SUPABASE_STORAGE_BUCKET;
  if (!bucket) {
    throw new Error("SUPABASE_STORAGE_BUCKET is not configured");
  }
  return bucket;
}

export type SignedUploadUrl = {
  uploadUrl: string;
  method: "PUT";
  headers: Record<string, string>;
  storageKey: string;
};

/**
 * Mints a Supabase Storage signed upload URL. Client PUTs the file body to
 * `uploadUrl` with the returned headers. The token in the URL authorizes the
 * upload — POST returns 400 with an RLS error because Supabase signed-upload
 * is PUT-only at the storage layer (the supabase-js SDK uploadToSignedUrl
 * also uses PUT). The Bearer header is the URL token (not strictly required,
 * but mirrors the SDK and is harmless).
 */
export async function createSignedUploadUrl(params: {
  storageKey: string;
  contentType: string;
}): Promise<SignedUploadUrl> {
  const bucket = requireBucket();
  const { data, error } = await getClient().storage
    .from(bucket)
    .createSignedUploadUrl(params.storageKey);
  if (error || !data) {
    throw new Error(`Failed to create signed upload URL: ${error?.message ?? "unknown"}`);
  }
  return {
    uploadUrl: data.signedUrl,
    method: "PUT",
    headers: {
      "content-type": params.contentType,
      authorization: `Bearer ${data.token}`,
      "x-upsert": "true",
    },
    storageKey: params.storageKey,
  };
}

/**
 * Mints a short-lived signed download URL. If `opts.filename` is given, the
 * URL includes a Content-Disposition header so browsers save the file
 * (routing it to the phone gallery on iOS/Android) instead of rendering it
 * inline. If `opts.transform` is given, Supabase Storage applies the resize
 * server-side and the signed URL embeds the transform — used for thumbnails
 * to cut bandwidth (a 250 KB JPEG → ~25 KB thumbnail).
 */
export async function createSignedDownloadUrl(
  storageKey: string,
  opts?: {
    filename?: string;
    transform?: {
      width?: number;
      height?: number;
      resize?: "cover" | "contain" | "fill";
      quality?: number;
    };
    ttlSeconds?: number; // override the global STORAGE_URL_TTL_SECONDS default
  },
): Promise<string> {
  const bucket = requireBucket();
  const supaOpts: { download?: string; transform?: object } = {};
  if (opts?.filename) supaOpts.download = opts.filename;
  if (opts?.transform) supaOpts.transform = opts.transform;
  const ttl = opts?.ttlSeconds ?? STORAGE_URL_TTL_SECONDS;

  // Cache key: storageKey + canonicalized opts. Same key + different
  // transform/filename/ttl must produce different cache slots because they
  // yield different signed URLs.
  const cacheKey = `${storageKey}::${JSON.stringify(opts ?? {})}`;
  const cached = signedUrlCache.get(cacheKey);
  if (cached !== null) return cached;

  const { data, error } = await getClient().storage
    .from(bucket)
    .createSignedUrl(
      storageKey,
      ttl,
      Object.keys(supaOpts).length > 0 ? supaOpts : undefined,
    );
  if (error || !data) {
    throw new Error(`Failed to create signed download URL: ${error?.message ?? "unknown"}`);
  }
  signedUrlCache.set(cacheKey, data.signedUrl, ttl);
  return data.signedUrl;
}

export async function objectExists(storageKey: string): Promise<boolean> {
  // Supabase .list(dir, { search }) does a prefix match, not exact. The
  // .some(entry => entry.name === name) guard below narrows to exact.
  const bucket = requireBucket();
  const slash = storageKey.lastIndexOf("/");
  const dir = slash >= 0 ? storageKey.slice(0, slash) : "";
  const name = slash >= 0 ? storageKey.slice(slash + 1) : storageKey;
  const { data, error } = await getClient().storage.from(bucket).list(dir, {
    search: name,
    limit: 1,
  });
  if (error) return false;
  return (data ?? []).some((entry) => entry.name === name);
}

export async function getObjectAsBuffer(storageKey: string): Promise<Buffer> {
  const bucket = requireBucket();
  const { data, error } = await getClient().storage.from(bucket).download(storageKey);
  if (error || !data) {
    throw new Error(`Failed to download ${storageKey}: ${error?.message ?? "unknown"}`);
  }
  return Buffer.from(await data.arrayBuffer());
}

/**
 * Best-effort raw-bytes download for a storage key. Returns the object as a
 * Buffer, or `null` on ANY miss/error (object missing, bucket not configured,
 * network/SDK failure). NEVER throws — this sits on the owner-statement PDF
 * render path, where a single missing receipt must degrade (skip that
 * attachment) rather than abort the whole money document. Uses the SAME
 * Supabase storage client + bucket as putObject / getObjectAsBuffer.
 */
export async function fetchStorageBuffer(storageKey: string): Promise<Buffer | null> {
  try {
    const bucket = requireBucket();
    const { data, error } = await getClient().storage.from(bucket).download(storageKey);
    if (error || !data) return null;
    return Buffer.from(await data.arrayBuffer());
  } catch {
    return null;
  }
}

export async function putObject(
  storageKey: string,
  body: Buffer,
  contentType?: string,
): Promise<void> {
  const bucket = requireBucket();
  const { error } = await getClient().storage.from(bucket).upload(storageKey, body, {
    contentType,
    upsert: true,
  });
  if (error) {
    throw new Error(`Failed to upload ${storageKey}: ${error.message}`);
  }
}

/**
 * Delete a single object from a bucket. Treats Supabase 404 as success
 * (the caller wants the object gone — already gone is fine).
 */
export async function deleteObject(bucket: string, storageKey: string): Promise<void> {
  const { error } = await getClient().storage.from(bucket).remove([storageKey]);
  if (error) {
    if (/not.found|404/i.test(error.message)) return;
    throw new Error(`Failed to delete ${bucket}/${storageKey}: ${error.message}`);
  }
}

/**
 * Delete multiple storage objects in a best-effort manner.
 *
 * `requireBucket()` is resolved internally so callers cannot accidentally
 * target a wrong bucket. This function MUST be called AFTER the owning DB
 * transaction commits — deleting storage before the DB row is gone leaves
 * the application in a state where the row references a missing object.
 *
 * Guarantees:
 *  - Filters null/undefined/empty-string keys and dedupes the remainder.
 *  - If no valid keys remain, returns immediately without touching storage
 *    (safe to call even if SUPABASE_STORAGE_BUCKET is not set).
 *  - If the bucket is not configured (requireBucket throws), emits a single
 *    console.warn and returns { deleted: 0, failed: N }.
 *  - Per-key failures are caught, warned, and counted; processing continues.
 *  - Never throws under any input.
 */
export async function deleteObjectsBestEffort(
  keys: ReadonlyArray<string | null | undefined>,
): Promise<{ deleted: number; failed: number }> {
  const uniqueKeys = [...new Set(keys.filter((k): k is string => !!k))];
  if (uniqueKeys.length === 0) {
    return { deleted: 0, failed: 0 };
  }

  let bucket: string;
  try {
    bucket = requireBucket();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[storage] deleteObjectsBestEffort: bucket not configured — skipping ${uniqueKeys.length} key(s): ${err instanceof Error ? err.message : String(err)}`,
    );
    return { deleted: 0, failed: uniqueKeys.length };
  }

  let deleted = 0;
  let failed = 0;
  for (const key of uniqueKeys) {
    try {
      await deleteObject(bucket, key);
      deleted++;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[storage] deleteObjectsBestEffort: failed to delete ${key}: ${err instanceof Error ? err.message : String(err)}`,
      );
      failed++;
    }
  }
  return { deleted, failed };
}

/**
 * Boot-time verification that the configured Supabase bucket's
 * `file_size_limit` is at least as large as the application's video cap.
 *
 * The expected cap is read from runtime config (env-driven), so dev/staging
 * /prod can each pick a value matching their bucket. Default 50 MB on Free
 * tier, override VIDEO_MAX_BYTES once the bucket cap is raised on Pro.
 *
 * If the bucket caps lower than the app cap, pre-signed upload URLs mint
 * successfully but the actual PUT fails with a cryptic 413 — users hit a
 * wall no client-side check can prevent. We log a warning so the deploy
 * operator can act before users notice.
 *
 * Non-blocking: we never crash boot on this. A misconfigured cap is bad
 * UX but should not take production offline. See:
 * docs/runbooks/supabase-storage.md
 */
export async function verifyBucketLimitAtStartup(): Promise<void> {
  let bucket: string;
  try {
    bucket = requireBucket();
  } catch {
    // No bucket configured (e.g. local dev without Supabase). Silent no-op.
    return;
  }

  // Lazy-import so this lib module stays free of an upstream config dep at
  // top-level (avoids cycles in some test setups).
  const { runtimeConfig } = await import("./runtime-config");
  const expectedAppCap = runtimeConfig.limits.videoMaxBytes;

  try {
    const { data, error } = await getClient().storage.getBucket(bucket);
    if (error || !data) {
      // eslint-disable-next-line no-console
      console.warn(
        `[storage] Could not read bucket ${bucket} for cap verification: ${error?.message ?? "unknown"}`,
      );
      return;
    }
    const limit = data.file_size_limit;
    if (typeof limit === "number" && limit < expectedAppCap) {
      // eslint-disable-next-line no-console
      console.warn(
        `[storage] Bucket ${bucket} cap (${limit}) < app cap (${expectedAppCap}). Uploads will fail at bucket layer until file_size_limit is bumped (or VIDEO_MAX_BYTES is lowered). See docs/runbooks/supabase-storage.md.`,
      );
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[storage] verifyBucketLimitAtStartup threw: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
