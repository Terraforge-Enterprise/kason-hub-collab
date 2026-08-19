import pLimit from "p-limit";
import { requireBucket } from "../../lib/storage";

/**
 * Renovation-claim document sweeper.
 *
 * Cleans orphan storage objects under `renovation-claims/<orgId>/tmp/...`
 * older than 24 hours. Storage uploads happen BEFORE the
 * RenovationClaimDocument row exists (the agent uploads, then the form is
 * submitted with `claimId=tmp` until the claim is created). If the form is
 * abandoned, the orphan stays in Supabase Storage until this sweeper reaps
 * it.
 *
 * Mirrors the tenant-IC sweeper's advisory-lock + p-limit pattern.
 */

const ADVISORY_LOCK_KEY = 893457622; // bumped one above tenant-ic's
const CONCURRENCY = 10;
const TMP_AGE_HOURS = 24;
const TMP_PATH_PREFIX = "renovation-claims/";
const TMP_PATH_MARKER = "/tmp/";

export type SweeperResult = { deleted: number; errors: number; locked: boolean };

/**
 * Storage entry shape needed by the sweeper. Supabase's `list()` returns
 * richer objects; this is the minimum we depend on.
 */
export interface StorageEntry {
  /** Full storage object key. MUST include the BUCKET path. */
  storageKey: string;
  /** Object's createdAt (server-side). Used to compute age. */
  createdAt: Date;
}

/**
 * Sweeper deps are dependency-injected so unit tests can supply fakes.
 *
 * - listTmpObjects: enumerate all keys under renovation-claims/<orgId>/tmp/.
 *   In production, wrap Supabase's list() with a recursive walker. The
 *   sweeper does NOT enforce a particular bucket implementation; the
 *   caller decides where to point it.
 * - `deleteObject`: same signature as `lib/storage.ts::deleteObject`.
 *
 * The advisory-lock prevents concurrent runs from double-deleting. We use
 * a Postgres advisory lock via the injected `prisma`. Rejecting the
 * concurrent-run path is the entire reason this sweeper takes prisma at
 * all — it has no actual DB writes.
 */
export async function runRenovationClaimsSweeper(deps: {
  prisma: any;
  listTmpObjects: () => Promise<StorageEntry[]>;
  deleteObject: (bucket: string, key: string) => Promise<void>;
  now?: () => Date;
  /** Optional override; defaults to `requireBucket()` from `lib/storage`. */
  bucket?: string;
}): Promise<SweeperResult> {
  const lockResult = await deps.prisma.$queryRaw`SELECT pg_try_advisory_lock(${ADVISORY_LOCK_KEY}) AS acquired`;
  const acquired = lockResult[0]?.acquired === true;
  if (!acquired) return { deleted: 0, errors: 0, locked: true };

  try {
    const now = (deps.now ?? (() => new Date()))();
    const cutoff = new Date(now.getTime() - TMP_AGE_HOURS * 60 * 60 * 1000);
    const bucket = deps.bucket ?? requireBucket();

    const all = await deps.listTmpObjects();
    const stale = all.filter(
      (entry) =>
        entry.storageKey.startsWith(TMP_PATH_PREFIX) &&
        entry.storageKey.includes(TMP_PATH_MARKER) &&
        entry.createdAt < cutoff,
    );

    let deleted = 0;
    let errors = 0;
    const limit = pLimit(CONCURRENCY);

    await Promise.allSettled(
      stale.map((entry) =>
        limit(async () => {
          try {
            await deps.deleteObject(bucket, entry.storageKey);
            deleted++;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (/404|not.found/i.test(msg)) {
              // Treat 404 as success — already gone.
              deleted++;
              return;
            }
            errors++;
          }
        }),
      ),
    );

    return { deleted, errors, locked: false };
  } finally {
    await deps.prisma.$queryRaw`SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY})`;
  }
}

export const RENOVATION_TMP_AGE_HOURS = TMP_AGE_HOURS;
export const RENOVATION_TMP_PATH_PREFIX = TMP_PATH_PREFIX;
export const RENOVATION_TMP_PATH_MARKER = TMP_PATH_MARKER;
