/**
 * Pure set-difference classifier for storage reconciliation.
 *
 * Given the set of object keys that physically exist in the bucket and the set
 * of keys that the database references, classify the discrepancies:
 *
 *  - orphans      = keys in the bucket but NOT referenced anywhere in the DB
 *                   (storage we could reclaim).
 *  - danglingRefs = keys referenced by the DB but NOT present in the bucket
 *                   (rows pointing at missing objects).
 *
 * Pure: no I/O, no mutation of inputs. Accepts arrays or Sets. Results are
 * deduped and returned in first-seen order of the source collection.
 */
export interface OrphanClassification {
  orphans: string[];
  danglingRefs: string[];
}

function toSet(input: Iterable<string>): Set<string> {
  return input instanceof Set ? input : new Set(input);
}

/** Keys in `from` (deduped, first-seen order) that are absent from `exclude`. */
function difference(from: Iterable<string>, exclude: Set<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const key of from) {
    if (exclude.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

export function classifyOrphans(
  bucketKeys: Iterable<string>,
  referencedKeys: Iterable<string>,
): OrphanClassification {
  const referencedSet = toSet(referencedKeys);
  const bucketSet = toSet(bucketKeys);
  return {
    orphans: difference(bucketKeys, referencedSet),
    danglingRefs: difference(referencedKeys, bucketSet),
  };
}
