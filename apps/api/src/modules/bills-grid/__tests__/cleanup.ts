import type { PrismaClient } from "@prisma/client";

/**
 * Shared teardown for every bills-grid integration suite (Tasks 4, 5, 8).
 *
 * Teardown ORDER, innermost first:
 *   1. GridMeterReading / GridExpense / GridAttachment  (children; also Cascade from the entry)
 *   2. UnitBillsGridEntry                               (its .apartment FK is onDelete: Restrict)
 *   3. UnitBillsBearerConfig                            (period-independent, also FKs Apartment)
 *   4. …only THEN may a caller run apartment.deleteMany()
 *
 * UnitBillsGridEntry.apartment is `onDelete: Restrict` (schema.prisma:2868, matching
 * the UnitUtilityBill.apartment precedent) — a money row must never be silently
 * cascade-deleted when its Apartment is removed. So deleting the entry BEFORE the
 * apartment is mandatory; reversing 2 and 4 raises a Postgres foreign-key violation,
 * not a cascade. The three children cascade from the entry, but we delete them
 * explicitly so a partial failure leaves nothing behind.
 *
 * Wire this as `afterAll` (NOT `afterEach`) — bills-grid suites chain state across
 * `it`s on purpose. Any suite that creates its OWN apartments must call this BEFORE
 * its `apartment.deleteMany()`.
 *
 * ── SCOPE, AND WHY IT IS NOT OPTIONAL FOR EVERY CALLER ──────────────────────────
 * Org-wide teardown is only safe for a suite that OWNS its org. Several suites instead
 * adopt whatever `organization.findFirstOrThrow()` returns — in a dev database that is a
 * REAL org — and org-wide deletes then reach rows the suite never created.
 *
 * That is not hypothetical. On 2026-07-28 a single `RUN_INTEGRATION=1` run over
 * bills-grid destroyed a real unit's saved grid entry, its 4 expenses and its bearer
 * config, and (via sibling suites) the org's 37 ChargeCategories and 12 DocumentSeries.
 * The tell was a stray `ELECTRICITY RM590` charge — forbidden-writes.integration.test.ts
 * saves exactly `tnbTotal: "590.00"` against a real apartment.
 *
 * So: pass `apartmentIds` whenever the org was not created by the suite. The deletes are
 * then confined to apartments the suite controls, and an adopted org keeps every row the
 * suite did not touch. Suites that build their own org may omit it.
 */
export async function cleanupGridFixtures(
  db: PrismaClient,
  orgId: string,
  opts: { apartmentIds?: readonly string[] } = {},
): Promise<void> {
  // `undefined` (own-org callers) leaves the filter off entirely — org-wide, as before.
  // An EMPTY array is honoured literally: scope to nothing, delete nothing. That is the
  // safe reading for "I own no apartments here", never "fall back to org-wide".
  const scope = opts.apartmentIds === undefined ? {} : { apartmentId: { in: [...opts.apartmentIds] } };
  const where = { organizationId: orgId, ...scope };
  await db.gridMeterReading.deleteMany({ where });
  await db.gridExpense.deleteMany({ where });
  await db.gridAttachment.deleteMany({ where });
  await db.unitBillsGridEntry.deleteMany({ where });
  await db.unitBillsBearerConfig.deleteMany({ where });
}
