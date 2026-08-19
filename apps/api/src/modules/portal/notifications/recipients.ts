import type { Prisma } from "@prisma/client";

export type Recipient = {
  id: string;
  whatsappPhone: string;
  displayName: string;
};

type Tx = Prisma.TransactionClient;

/**
 * Walks Party.uplineId up from the filer until null, skipping cycles.
 * Returns ancestor ids in order (immediate upline first).
 */
export async function walkUplineChain(filerPartyId: string, tx: Tx): Promise<string[]> {
  const visited = new Set<string>([filerPartyId]);
  const chain: string[] = [];
  let cursor = await tx.party.findUnique({
    where: { id: filerPartyId },
    select: { uplineId: true },
  });
  while (cursor?.uplineId && !visited.has(cursor.uplineId)) {
    visited.add(cursor.uplineId);
    chain.push(cursor.uplineId);
    cursor = await tx.party.findUnique({
      where: { id: cursor.uplineId },
      select: { uplineId: true },
    });
  }
  return chain;
}

/**
 * Resolves the list of WhatsApp recipients for a claim:
 *   1. Walk filer's upline chain (every ancestor)
 *   2. Collect every Party that is linked to a User with role IN ('admin','manager')
 *   3. Union, dedupe by partyId, exclude the filer themselves
 *   4. Filter to recipients with a WhatsApp phone, opted-in, and active status
 */
export async function resolveRecipients(
  filerPartyId: string,
  organizationId: string,
  tx: Tx,
): Promise<Recipient[]> {
  const uplineIds = await walkUplineChain(filerPartyId, tx);

  const adminUsers = await tx.user.findMany({
    where: {
      organizationId,
      role: { in: ["admin", "manager"] },
      partyId: { not: null },
    },
    select: { partyId: true },
  });
  const adminPartyIds = adminUsers.map((u) => u.partyId).filter((id): id is string => !!id);

  const candidateIds = Array.from(new Set([...uplineIds, ...adminPartyIds]))
    .filter((id) => id !== filerPartyId);

  if (candidateIds.length === 0) return [];

  const parties = await tx.party.findMany({
    where: { id: { in: candidateIds } },
    select: {
      id: true,
      whatsappPhone: true,
      notifyOnNewClaim: true,
      status: true,
      displayName: true,
    },
  });

  return parties
    .filter((p) => p.whatsappPhone && p.notifyOnNewClaim && p.status === "active")
    .map((p) => ({
      id: p.id,
      whatsappPhone: p.whatsappPhone!,
      displayName: p.displayName,
    }));
}
