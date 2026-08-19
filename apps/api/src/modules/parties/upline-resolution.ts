import type { Prisma } from "@prisma/client";

const RANK_ORDER: Record<string, number> = {
  new_agent: 1,
  pre_leader: 2,
  leader: 3,
};

// Staff users have agentLevel = null — they are the natural ceiling above
// every agent rank. POSITIVE_INFINITY makes them satisfy `rank >= target`
// for any finite target, so findValidUpline terminates at the first staff
// ancestor without a special branch.
//
// Unknown level strings return 0 — defensive for legacy/imported data.
export function rankOf(level: string | null): number {
  if (level === null) return Number.POSITIVE_INFINITY;
  return RANK_ORDER[level] ?? 0;
}

/**
 * Walk the upline chain starting at `startUplineId` and return the id of
 * the first ancestor whose `rank >= targetRank` AND `status === "active"`.
 * Returns `null` if no eligible ancestor exists.
 *
 * Walks past blacklisted/inactive uplines silently — they never become a
 * new upline. Cycle defense via the `visited` set: returns `null` if a
 * cycle is encountered.
 */
export async function findValidUpline(
  tx: Prisma.TransactionClient,
  orgId: string,
  startUplineId: string | null,
  targetRank: number,
): Promise<string | null> {
  let cursor: string | null = startUplineId;
  const visited = new Set<string>();
  while (cursor && !visited.has(cursor)) {
    visited.add(cursor);
    const node = await tx.party.findFirst({
      where: { id: cursor, organizationId: orgId },
      select: { id: true, uplineId: true, agentLevel: true, status: true },
    });
    if (!node) return null;
    const isActive = node.status === "active";
    if (isActive && rankOf(node.agentLevel) >= targetRank) return node.id;
    cursor = node.uplineId;
  }
  return null;
}
