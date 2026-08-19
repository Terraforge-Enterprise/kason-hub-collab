import { getDb } from "@kason/db";

/** One grid bill (GridAttachment) surfaced to the statement — no ownerPartyId column exists
 *  on GridAttachment, so ownership is enforced via the apartment's Listing below. */
export interface GridBillRow {
  id: string;
  storageKey: string;
  filename: string;
  contentType: string;
  /** From the linked GridExpense's ChargeCategory.ledgerCategory; null = entry-level/unclassified. */
  ledgerCategory: string | null;
}

/**
 * Grid bills for a specific (owner, month, apartment). GridAttachment is org-scoped only and
 * carries NO owner/room column, so this MUST (a) require a non-null apartmentId and (b) confirm
 * the attachments are attributable to `ownerPartyId` before returning anything. A foreign owner
 * / null apartment yields [] (never leak existence).
 *
 * Attribution (billing follows the inventory owner): an attachment is attributed to an owner
 * only through the apartment's Listings. A partitioned apartment MAY hold multiple Listings with
 * DIFFERENT ownerPartyId (schema `@@unique([apartmentId, listingType])`, per-listing owner), and
 * a grid attachment has no per-room link — owner-bearer GridExpenses store `partyId = null` (the
 * owner is resolved only at mint time, collapsing the apartment to a single owner). So the ONLY
 * case in which every grid bill on the apartment is confidently attributable to the querying
 * owner is a SINGLE-owner apartment (all active Listings owned by `ownerPartyId`). On a co-owned
 * apartment nothing can be safely attributed → [] (fail-safe; never leak another owner's bill).
 * Archived listings are excluded from the owner set — mirrors `resolveApartmentOwner` /
 * meter/repository (`listingStatus != "archived"`) — so a stale/ended ownership grants no access.
 */
export async function findGridBillsForOwnerMonth(
  orgId: string,
  ownerPartyId: string,
  apartmentId: string | null,
  statementMonth: Date,
): Promise<GridBillRow[]> {
  if (!apartmentId) return []; // grid bills are always apartment-scoped

  const db = getDb();
  // Ownership + attribution gate: attachments are attributable to `ownerPartyId` ONLY when this
  // apartment has exactly one active (non-archived) owner and it is the querying owner. Otherwise
  // — owner not present (foreign / archived-only listing), or the apartment is co-owned by more
  // than one party — no attachment can be safely attributed → [] (fail-safe).
  const listings = await db.listing.findMany({
    where: {
      organizationId: orgId,
      apartmentId,
      listingStatus: { not: "archived" },
      ownerPartyId: { not: null },
    },
    select: { ownerPartyId: true },
  });
  const distinctOwners = new Set(listings.map((l) => l.ownerPartyId));
  if (distinctOwners.size !== 1 || !distinctOwners.has(ownerPartyId)) return [];

  const rows = await db.gridAttachment.findMany({
    where: {
      organizationId: orgId,
      apartmentId,
      periodMonth: statementMonth,
      // A voided GridExpense is a retracted bill — exclude its attachment. Entry-level rows
      // (expenseId = null) have no expense to void and are kept (they belong to this sole owner).
      OR: [{ expenseId: null }, { expense: { status: { not: "void" } } }],
    },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      storageKey: true,
      filename: true,
      contentType: true,
      expense: { select: { chargeCategory: { select: { ledgerCategory: true } } } },
    },
  });

  return rows.map((r) => ({
    id: r.id,
    storageKey: r.storageKey,
    filename: r.filename,
    contentType: r.contentType,
    ledgerCategory: r.expense?.chargeCategory?.ledgerCategory ?? null,
  }));
}
