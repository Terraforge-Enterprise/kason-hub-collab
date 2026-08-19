import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { requireBucket } from "../../lib/storage";

/**
 * Recursive lister for every object in the configured Supabase Storage bucket.
 *
 * `apps/api/src/lib/storage.ts` keeps its Supabase client private (no export),
 * so we build an equivalent service-role client here the same way that file
 * does. This module only LISTS objects — it never uploads, downloads, or
 * deletes anything.
 */

export interface BucketObject {
  key: string;
  size: number;
}

const PAGE_LIMIT = 1000;

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

/**
 * Supabase Storage `list()` returns one prefix ("folder") at a time. Real
 * objects carry an `id` + `metadata`; sub-folders come back with a null `id`
 * and null `metadata` and must be recursed into. Pagination is by `offset`
 * until a page returns fewer than `limit` entries.
 */
async function listPrefix(
  client: SupabaseClient,
  bucket: string,
  prefix: string,
  out: BucketObject[],
): Promise<void> {
  let offset = 0;
  for (;;) {
    const { data, error } = await client.storage
      .from(bucket)
      .list(prefix, { limit: PAGE_LIMIT, offset });
    if (error) {
      throw new Error(
        `Failed to list "${prefix || "/"}" in bucket ${bucket}: ${error.message}`,
      );
    }
    const entries = data ?? [];
    for (const entry of entries) {
      const fullPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      // A null id (and null metadata) marks a sub-"folder" — recurse.
      if (entry.id === null) {
        await listPrefix(client, bucket, fullPath, out);
      } else {
        const size =
          (entry.metadata && typeof entry.metadata.size === "number"
            ? entry.metadata.size
            : 0) ?? 0;
        out.push({ key: fullPath, size });
      }
    }
    if (entries.length < PAGE_LIMIT) break;
    offset += PAGE_LIMIT;
  }
}

export async function listAllObjects(): Promise<BucketObject[]> {
  const bucket = requireBucket();
  const client = getClient();
  const out: BucketObject[] = [];
  await listPrefix(client, bucket, "", out);
  return out;
}
