/**
 * Deciding WHICH SST siblings fold, for any paginated portal charge list.
 *
 * The pure merge lives in `foldPayableTaxSiblings` (@kason/shared) — read its header
 * for what an SST sibling is and why it must keep existing as its own Charge. This
 * module owns the database-shaped half: which of a party's charges are tax siblings,
 * and which of those have a base to fold into.
 *
 * It exists so the two portal charge endpoints — `listPayableCharges` (pay screen)
 * and `listCharges` (Charges page + Billing → Invoices tab) — cannot drift. They had
 * begun to: the pay screen folded and the other two did not, so the same expense read
 * RM 0.54 on one screen and RM 0.50 + RM 0.04 on the next.
 *
 * ─── Why the decision must precede pagination ────────────────────────────────
 *
 * Fold per-page and a pair straddling a page boundary shows the base on page 1 and a
 * bare "— SST 8%" alone on page 2. So the caller resolves the foldable set across the
 * WHOLE visible set first, excludes it from the paginated query (`total` then counts
 * DISPLAY rows, which is what a pager means), and pulls each page's own siblings back
 * in to be folded. {@link pageSiblingWhere} builds that pull-in.
 */
import type { getDb, Prisma } from "@kason/db";

/** The id-only shape the decision reads. */
export type ChargeLineage = { id: string; parentChargeId: string | null };

/**
 * Which of `chargeIds` carry an `isTax` document line.
 *
 * ⚠️ MONEY. This, not `parentChargeId`, is what identifies a tax sibling.
 * `parentChargeId` is a GENERIC lineage link that non-tax charges also use —
 * `correction-replace.service.ts` points an `RPL-…` replacement charge at the charge
 * it supersedes — so folding on the link alone would merge a replacement into the
 * charge it replaced. Same two-signal rule `findTaxSibling` uses in
 * charge-adjustment.service.ts.
 *
 * TWO queries rather than a nested filter: BillingDocumentLine.chargeId is a PLAIN
 * column with no Prisma relation to Charge (schema.prisma:2387), so `charge: {…}` is
 * not expressible in its `where`.
 */
export async function findTaxChargeIds(
  db: ReturnType<typeof getDb>,
  chargeIds: string[],
): Promise<Set<string>> {
  if (chargeIds.length === 0) return new Set();
  const lines = await db.billingDocumentLine.findMany({
    where: { chargeId: { in: chargeIds }, isTax: true },
    select: { chargeId: true },
  });
  const out = new Set<string>();
  for (const l of lines) if (l.chargeId) out.add(l.chargeId);
  return out;
}

/**
 * The tax siblings that will fold away: those whose base is ALSO in this visible set
 * and is not itself a tax charge.
 *
 * SAFETY — money never disappears from view. Anything else stays a display row of its
 * own: an orphan whose base is already settled, one whose parent link was never
 * written, one parented to another tax charge. A charge the tenant cannot see is one
 * they never pay, so an unexplained row always beats a missing one.
 */
export function pickFoldableTaxSiblingIds(
  rows: readonly ChargeLineage[],
  taxIds: ReadonlySet<string>,
): string[] {
  const visibleIds = new Set(rows.map((r) => r.id));
  return rows
    .filter(
      (r) =>
        taxIds.has(r.id) &&
        r.parentChargeId !== null &&
        visibleIds.has(r.parentChargeId) &&
        !taxIds.has(r.parentChargeId),
    )
    .map((r) => r.id);
}

/**
 * Resolve the fold decision for a party's whole visible charge set. `where` must be
 * the SAME filter the caller paginates with, or the two disagree about what is
 * visible and a sibling can be excluded from the page without being folded into it.
 *
 * One id-only fetch, deliberately unpaginated — tens of rows for a tenant, and it
 * cannot be paged for the reason in this module's header.
 */
export async function resolveTaxSiblingFold(
  db: ReturnType<typeof getDb>,
  where: Prisma.ChargeWhereInput,
): Promise<{ taxIds: Set<string>; foldableTaxIds: string[] }> {
  const rows = await db.charge.findMany({ where, select: { id: true, parentChargeId: true } });
  const taxIds = await findTaxChargeIds(db, rows.map((r) => r.id));
  return { taxIds, foldableTaxIds: pickFoldableTaxSiblingIds(rows, taxIds) };
}

/**
 * The paginated query's filter with the foldable siblings removed, so `total` counts
 * display rows. Returns `where` untouched when there is nothing to exclude — Prisma
 * renders `notIn: []` as a contradiction on some connectors, and this keeps the
 * no-SST path byte-identical to what it was before folding existed.
 */
export function displayWhere(
  where: Prisma.ChargeWhereInput,
  foldableTaxIds: readonly string[],
): Prisma.ChargeWhereInput {
  return foldableTaxIds.length ? { ...where, id: { notIn: [...foldableTaxIds] } } : where;
}

/**
 * The filter for pulling in THIS page's siblings. Scoped by `parentChargeId in
 * pageIds` so each sibling is fetched exactly once, onto the page carrying its base:
 * never dropped, never shown twice. Returns null when there is nothing to pull.
 */
export function pageSiblingWhere(
  where: Prisma.ChargeWhereInput,
  foldableTaxIds: readonly string[],
  pageIds: readonly string[],
): Prisma.ChargeWhereInput | null {
  if (foldableTaxIds.length === 0 || pageIds.length === 0) return null;
  return { ...where, id: { in: [...foldableTaxIds] }, parentChargeId: { in: [...pageIds] } };
}
