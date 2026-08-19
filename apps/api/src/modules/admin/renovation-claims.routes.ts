import { Hono } from "hono";
import { getDb } from "@kason/db";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { deleteObject, requireBucket } from "../../lib/storage";
import {
  runRenovationClaimsSweeper,
  RENOVATION_TMP_PATH_PREFIX,
  RENOVATION_TMP_PATH_MARKER,
  type StorageEntry,
} from "../renovation-claims/sweeper";
import type { SessionPayload } from "../../lib/auth";

type AdminEnv = { Variables: { session: SessionPayload } };

const adminRenovationClaimsRoutes = new Hono<AdminEnv>();

let _storageClient: SupabaseClient | null = null;
function getStorageClient(): SupabaseClient {
  if (_storageClient) return _storageClient;
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  }
  _storageClient = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _storageClient;
}

const MAX_DEPTH = 6;

async function walkPrefix(
  bucket: string,
  prefix: string,
  out: StorageEntry[],
  depth: number,
): Promise<void> {
  if (depth > MAX_DEPTH) return;
  const { data, error } = await getStorageClient().storage.from(bucket).list(prefix, {
    limit: 1000,
  });
  if (error) throw new Error(`list(${prefix}): ${error.message}`);
  if (!data) return;
  for (const entry of data) {
    const childPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.id === null) {
      await walkPrefix(bucket, childPath, out, depth + 1);
    } else {
      out.push({
        storageKey: childPath,
        createdAt: entry.created_at ? new Date(entry.created_at) : new Date(0),
      });
    }
  }
}

async function listOrphanRenovationClaimUploads(): Promise<StorageEntry[]> {
  const bucket = requireBucket();
  const prisma = getDb() as any;
  const orgs: Array<{ id: string }> = await prisma.organization.findMany({
    select: { id: true },
  });
  const out: StorageEntry[] = [];
  for (const org of orgs) {
    const tmpPrefix = `${RENOVATION_TMP_PATH_PREFIX}${org.id}${RENOVATION_TMP_PATH_MARKER.slice(0, -1)}`;
    try {
      await walkPrefix(bucket, tmpPrefix, out, 0);
    } catch {
      // Tenant has no tmp/ folder yet — skip silently. Errors on a single
      // org should not stop the sweep for the rest.
    }
  }
  return out;
}

adminRenovationClaimsRoutes.post("/jobs/renovation-claims-sweeper/run", async (c) => {
  const session = c.get("session");
  if (session.role !== "admin") return c.json({ error: "Forbidden" }, 403);
  const prisma = getDb() as any;
  const result = await runRenovationClaimsSweeper({
    prisma,
    listTmpObjects: listOrphanRenovationClaimUploads,
    deleteObject,
  });
  return c.json(result);
});

export { adminRenovationClaimsRoutes };
