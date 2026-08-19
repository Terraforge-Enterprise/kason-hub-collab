/**
 * "How much of this charge has the OWNER already settled?" — the read side of the
 * non-cash owner rail, owned by the module that owns both its tables.
 *
 * ⚠️ MONEY. An owner's IVOWN receivable settles WITHOUT any `Payment` or
 * `PaymentAllocation` ever existing: `recordOffsetService` writes an `OwnerLedgerEntry`
 * (settlementKind `OWNER_RECEIVABLE_OFFSET`) plus one `OwnerReceivableOffsetAllocation`
 * per charge, and decrements the charge through `applyAllocationToChargeTx`, which only
 * touches `Charge.outstandingAmount`. `autoOffsetOwnerReceivablesForPaidRent` fires that
 * same rail the moment a tenant's rent is fully collected.
 *
 * Any consumer asking "is this settled?" off `PaymentAllocation` alone is therefore
 * structurally blind to owner money. That blindness let a bills-grid re-Bill void a
 * fully-settled IVOWN and re-mint it (UAT IVOWN-0008 → IVOWN-0009, 2026-08-18): the
 * owner's payable had already absorbed RM 1.29 and they were billed for it again.
 *
 * ── WHY THIS LIVES HERE, NOT IN THE CALLER ──────────────────────────────────────
 * bills-grid may not touch the `ownerLedgerEntry` delegate AT ALL — read or write —
 * under HARD CONSTRAINT 2, enforced statically by
 * `bills-grid/__tests__/forbidden-writes.integration.test.ts`. That guard is correct and
 * must not be widened for this, so the owner-ledger read sits on the owner-remittance
 * side of the seam and the grid consumes a plain `Map`. Pure read: writes nothing.
 */
import type { Prisma } from "@kason/db";

/** One `OwnerReceivableOffsetAllocation` row, narrowed to what netting needs. */
export type OffsetAllocationFact = {
  chargeId: string;
  /** Integer CENTS — the column's own unit (`allocatedAmountC`, schema.prisma:3039). */
  allocatedAmountC: number;
  offsetEntryId: string;
};

/**
 * PURE — no I/O. Net owner-offset settlement per charge, in RINGGIT.
 *
 * An allocation counts only when BOTH hold:
 *
 *   • its offset entry is itself `status: "active"`, and
 *   • no ACTIVE reversal entry points at it.
 *
 * The second test is not redundant. `reverseOffsetService` (owner-remittance.service.ts)
 * does NOT void the original entry — it APPENDS a new one carrying `reversalOfEntryId`
 * and restores the charge via `restoreChargeTx`. The original stays `active` forever, so
 * entry status alone would keep reading a reversed offset as settled money and would
 * freeze a charge that is genuinely owed again. Mirrors what
 * `sumReversalsForAllocations` does on the cash rail.
 *
 * Exported for its own unit test — the netting rules decide whether money is treated as
 * received, so they are pinned without a database.
 */
export function netOwnerOffsetByChargeId(input: {
  allocations: readonly OffsetAllocationFact[];
  /** Ids of offset entries whose own `status` is "active". */
  activeOffsetEntryIds: ReadonlySet<string>;
  /** Ids of offset entries that an ACTIVE reversal entry points at. */
  reversedOffsetEntryIds: ReadonlySet<string>;
}): Map<string, number> {
  const { allocations, activeOffsetEntryIds, reversedOffsetEntryIds } = input;
  const centsByCharge = new Map<string, number>();
  for (const a of allocations) {
    if (!activeOffsetEntryIds.has(a.offsetEntryId)) continue;
    if (reversedOffsetEntryIds.has(a.offsetEntryId)) continue;
    if (a.allocatedAmountC <= 0) continue;
    centsByCharge.set(a.chargeId, (centsByCharge.get(a.chargeId) ?? 0) + a.allocatedAmountC);
  }
  // Cents → ringgit LAST, once per charge: summing in cents keeps the arithmetic exact,
  // and a single division cannot accumulate drift across allocations.
  const out = new Map<string, number>();
  for (const [chargeId, cents] of centsByCharge) out.set(chargeId, cents / 100);
  return out;
}

/**
 * Net-of-reversal owner OFFSET settlement per charge id, in RINGGIT.
 *
 * The I/O half of {@link netOwnerOffsetByChargeId} — three narrow reads (allocations by
 * charge, their entries, any active reversals of those entries), all index-backed
 * (`OwnerReceivableOffsetAllocation@@index([organizationId, chargeId])`). Returns an
 * empty map on the first read when the charge set carries no offset at all, which is
 * every tenant-only caller.
 *
 * Runs inside the caller's transaction so the answer is consistent with whatever else
 * that transaction has already read.
 */
export async function activeOwnerOffsetByChargeId(
  tx: Prisma.TransactionClient,
  orgId: string,
  chargeIds: readonly string[],
): Promise<Map<string, number>> {
  if (chargeIds.length === 0) return new Map();
  const allocations = await tx.ownerReceivableOffsetAllocation.findMany({
    where: { organizationId: orgId, chargeId: { in: [...chargeIds] } },
    select: { chargeId: true, allocatedAmountC: true, offsetEntryId: true },
  });
  if (allocations.length === 0) return new Map();

  const offsetEntryIds = [...new Set(allocations.map((a) => a.offsetEntryId))];
  const [entries, reversals] = await Promise.all([
    tx.ownerLedgerEntry.findMany({
      where: { organizationId: orgId, id: { in: offsetEntryIds }, status: "active" },
      select: { id: true },
    }),
    tx.ownerLedgerEntry.findMany({
      where: { organizationId: orgId, reversalOfEntryId: { in: offsetEntryIds }, status: "active" },
      select: { reversalOfEntryId: true },
    }),
  ]);

  return netOwnerOffsetByChargeId({
    allocations,
    activeOffsetEntryIds: new Set(entries.map((e) => e.id)),
    reversedOffsetEntryIds: new Set(
      reversals.map((r) => r.reversalOfEntryId).filter((id): id is string => id !== null),
    ),
  });
}
