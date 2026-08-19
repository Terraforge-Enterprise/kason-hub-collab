import type { PrismaClient } from "@prisma/client";
import { classifyOrphans } from "./classify";
import { scanReferencedKeys, type ScanManifestEntry } from "./scan-references";
import { listAllObjects, type BucketObject } from "./list-bucket";

/**
 * Read-only reconciliation report for Supabase Storage. Lists the bucket,
 * scans every storage-key column in the DB, and classifies the difference into
 * orphans (bucket objects nothing references) and dangling refs (DB keys whose
 * object is missing). DELETES NOTHING.
 */
export interface StorageReconReport {
  totalBucketObjects: number;
  totalReferencedKeys: number;
  orphanCount: number;
  orphanBytes: number;
  danglingCount: number;
  manifest: ScanManifestEntry[];
  orphans: string[];
  danglingRefs: string[];
}

export async function buildStorageReconReport(
  prisma: PrismaClient,
): Promise<StorageReconReport> {
  const bucketObjects: BucketObject[] = await listAllObjects();
  const { keys: referencedKeys, manifest } = await scanReferencedKeys(prisma);

  const bucketKeys = bucketObjects.map((o) => o.key);
  const { orphans, danglingRefs } = classifyOrphans(bucketKeys, referencedKeys);

  // Sum bytes of the orphaned objects (the storage we could reclaim).
  const sizeByKey = new Map<string, number>();
  for (const obj of bucketObjects) sizeByKey.set(obj.key, obj.size);
  const orphanBytes = orphans.reduce((sum, key) => sum + (sizeByKey.get(key) ?? 0), 0);

  return {
    totalBucketObjects: bucketObjects.length,
    totalReferencedKeys: referencedKeys.size,
    orphanCount: orphans.length,
    orphanBytes,
    danglingCount: danglingRefs.length,
    manifest,
    orphans,
    danglingRefs,
  };
}
