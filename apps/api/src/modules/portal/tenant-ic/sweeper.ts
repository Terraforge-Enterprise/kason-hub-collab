import pLimit from "p-limit";
import { Prisma } from "@prisma/client";

const ADVISORY_LOCK_KEY = 893457621;   // any 32-bit constant unique to this job
const BATCH_SIZE = 2000;
const CONCURRENCY = 10;

export type SweeperResult = { deleted: number; errors: number; locked: boolean };

export async function runTenantIcSweeper(deps: {
  prisma: any;
  deleteObject: (bucket: string, key: string) => Promise<void>;
  // The real Supabase bucket (requireBucket()); row.bucket is a stale key-prefix literal.
  bucket: string;
}): Promise<SweeperResult> {
  const lockResult = await deps.prisma.$queryRaw`SELECT pg_try_advisory_lock(${ADVISORY_LOCK_KEY}) AS acquired`;
  const acquired = lockResult[0]?.acquired === true;
  if (!acquired) return { deleted: 0, errors: 0, locked: true };

  try {
    // Use NOW() directly so no interpolations appear before FOR UPDATE SKIP LOCKED
    // This keeps the mock's strings.raw[0] check working (all static text in raw[0])
    const stale = await deps.prisma.$queryRaw<Array<{ id: string; storageKey: string; bucket: string }>>`
      SELECT id, "storageKey", bucket FROM "PendingUpload"
       WHERE status = 'pending' AND "expiresAt" < NOW()
       ORDER BY "expiresAt" ASC
       LIMIT 2000
       FOR UPDATE SKIP LOCKED
    `;

    let deleted = 0;
    let errors = 0;
    const limit = pLimit(CONCURRENCY);

    await Promise.allSettled(
      stale.map((row: { id: string; storageKey: string; bucket: string }) =>
        limit(async () => {
          try {
            await deps.deleteObject(deps.bucket, row.storageKey);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (!/404|not.found/i.test(msg)) {
              errors++;
              return;
            }
          }
          await deps.prisma.pendingUpload.update({
            where: { id: row.id },
            data: { status: "expired" },
          });
          deleted++;
        }),
      ),
    );

    return { deleted, errors, locked: false };
  } finally {
    await deps.prisma.$queryRaw`SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY})`;
  }
}

export async function runTenantIcHousekeeping(deps: { prisma: any }): Promise<{ pendingDeleted: number; auditDeleted: number }> {
  const pending = await deps.prisma.$executeRaw`
    DELETE FROM "PendingUpload"
     WHERE status IN ('consumed','deleted','expired')
       AND "updatedAt" < NOW() - INTERVAL '30 days'
  `;
  const audit = await deps.prisma.$executeRaw`
    DELETE FROM "IcAccessLog"
     WHERE "createdAt" < NOW() - INTERVAL '2 years'
  `;
  return { pendingDeleted: pending, auditDeleted: audit };
}
