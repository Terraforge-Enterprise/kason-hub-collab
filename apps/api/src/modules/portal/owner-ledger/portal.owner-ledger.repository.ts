/**
 * Portal owner-ledger repository — OWN-DATA-ONLY.
 *
 * Every query is scoped to `session.partyId` + `session.orgId`. An owner can
 * NEVER see another owner's rows. The caller always provides the session
 * partyId; ownerPartyId from query params is deliberately ignored and
 * overwritten with the session value.
 */
import { getDb } from "@kason/db";
import type { Prisma } from "@kason/db";
import type { OwnerLedgerLine } from "@kason/shared";
import { rowToLedgerLine } from "../../owner-ledger/owner-ledger.types";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function firstOfMonth(ym: string): Date {
  const [year, month] = ym.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, 1));
}

function lastOfMonth(ym: string): Date {
  const [year, month] = ym.split("-").map(Number);
  return new Date(Date.UTC(year!, month!, 0));
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type OwnerLedgerRowDto = {
  id: string;
  statementMonth: string;
  transactionDate: string;
  direction: string;
  category: string;
  description: string | null;
  remarks: string | null;
  amount: string;
  sstAmount: string | null;
  paidBy: string;
  paymentStatus: string;
  includeInPayout: boolean;
  taxCategory: string;
  attachmentKeys: string[];
  /** Task 6a: null = owner-level (not attributable to one property) — a Phase-2
   *  remittance payout spanning multiple properties or a combined-scope
   *  pre-statement payout. */
  propertyId: string | null;
  apartmentId: string | null;
  unitCode: string | null;
  listingId: string | null;
};

function rowToDto(
  row: {
    id: string;
    statementMonth: Date;
    transactionDate: Date;
    direction: string;
    category: string;
    description: string | null;
    remarks: string | null;
    amount: { toString(): string };
    sstAmount: { toString(): string } | null;
    paidBy: string;
    paymentStatus: string;
    includeInPayout: boolean;
    taxCategory: string;
    attachmentKeys: string[];
    propertyId: string | null;
    apartmentId: string | null;
    listingId: string | null;
  },
  unitCode: string | null = null,
): OwnerLedgerRowDto {
  // statementMonth is stored as @db.Date first-of-month; format as YYYY-MM.
  const sm = row.statementMonth;
  const statementMonth = `${sm.getUTCFullYear()}-${String(sm.getUTCMonth() + 1).padStart(2, "0")}`;
  // transactionDate is stored as @db.Date; format as YYYY-MM-DD.
  const td = row.transactionDate;
  const transactionDate = `${td.getUTCFullYear()}-${String(td.getUTCMonth() + 1).padStart(2, "0")}-${String(td.getUTCDate()).padStart(2, "0")}`;

  return {
    id: row.id,
    statementMonth,
    transactionDate,
    direction: row.direction,
    category: row.category,
    description: row.description,
    remarks: row.remarks,
    amount: row.amount.toString(),
    sstAmount: row.sstAmount != null ? row.sstAmount.toString() : null,
    paidBy: row.paidBy,
    paymentStatus: row.paymentStatus,
    includeInPayout: row.includeInPayout,
    taxCategory: row.taxCategory,
    attachmentKeys: row.attachmentKeys,
    propertyId: row.propertyId,
    apartmentId: row.apartmentId,
    unitCode,
    listingId: row.listingId,
  };
}

// ─── Ledger rows ──────────────────────────────────────────────────────────────

/**
 * Fetch active OwnerLedgerEntry rows for the owner in [fromMonth..toMonth].
 * ownerPartyId is ALWAYS session.partyId — the caller MUST pass the session
 * value, never a value from query params.
 */
export async function getOwnerLedgerRows(
  orgId: string,
  ownerPartyId: string,
  fromMonth: string,
  toMonth: string,
  propertyId?: string,
): Promise<{ rows: OwnerLedgerRowDto[]; lines: OwnerLedgerLine[] }> {
  const db = getDb();

  const where: Prisma.OwnerLedgerEntryWhereInput = {
    organizationId: orgId,
    ownerPartyId,
    status: "active",
    statementMonth: {
      gte: firstOfMonth(fromMonth),
      lte: lastOfMonth(toMonth),
    },
    ...(propertyId ? { propertyId } : {}),
  };

  const rawRows = await db.ownerLedgerEntry.findMany({
    where,
    orderBy: [{ statementMonth: "asc" }, { transactionDate: "asc" }],
  });

  // Bulk-resolve unitCode for rows that have an apartmentId.
  // OwnerLedgerEntry.apartmentId has no FK relation in Prisma — separate lookup required.
  const apartmentIds = [...new Set(rawRows.map((r) => r.apartmentId).filter(Boolean))] as string[];
  let unitCodeMap = new Map<string, string>();
  if (apartmentIds.length > 0) {
    const apts = await db.apartment.findMany({
      where: { id: { in: apartmentIds } },
      select: { id: true, unitCode: true },
    });
    unitCodeMap = new Map(apts.map((a) => [a.id, a.unitCode]));
  }

  return {
    rows: rawRows.map((r) =>
      rowToDto(r, r.apartmentId ? (unitCodeMap.get(r.apartmentId) ?? null) : null),
    ),
    lines: rawRows.map(rowToLedgerLine),
  };
}

// ─── Property view (§3) ───────────────────────────────────────────────────────

/**
 * Returns the property view for a property the owner owns. Ownership and the
 * units shown are BOTH resolved per-unit via Listing.ownerPartyId — owner money
 * (and now the property view) is attributed per-unit, NOT per-property via
 * LandlordTenancy. In a multi-owner building each owner sees ONLY their own
 * non-archived listings; other owners' units in the same property are excluded.
 * Returns null if the owner owns no non-archived listing in this property
 * (→ 404 in route).
 *
 * Fields returned: Property (name, address), units (unitCode, occupancyStatus),
 * current Tenancy (tenant displayName, start/end, monthlyRentAmount), Deposit
 * rows by type, ManagementFeeConfig (fee rate), Property.managerId (PIC).
 *
 * Omitted §3 fields (no column in schema): full combined address string (no single
 * "fullAddress" column — address is split across addressLine1/2/city/state/postal/
 * country, all individual fields are returned), dedicated "owner name" on property
 * (resolved via PartyId in the portal session, not a property column).
 */
export async function getOwnerPropertyView(
  orgId: string,
  ownerPartyId: string,
  propertyId: string,
) {
  const db = getDb();

  // Ownership check: owner must own ≥1 non-archived listing in this property
  // (per-unit via Listing.ownerPartyId — replaces the old property-level
  // LandlordTenancy gate, which leaked co-owners' units in shared buildings).
  const owns = await db.listing.findFirst({
    where: {
      ownerPartyId,
      organizationId: orgId,
      listingStatus: { not: "archived" },
      apartment: { propertyId, underManagement: true },
    },
    select: { id: true },
  });

  if (!owns) return null;

  // Property details with units, active tenancies, deposits, and fee config.
  const property = await db.property.findFirst({
    where: { id: propertyId, organizationId: orgId },
    select: {
      id: true,
      name: true,
      addressLine1: true,
      addressLine2: true,
      city: true,
      state: true,
      postalCode: true,
      country: true,
      managerId: true,
      apartments: {
        where: { underManagement: true },
        select: {
          id: true,
          unitCode: true,
          listings: {
            // Per-unit scope: only THIS owner's non-archived listings. Other
            // owners' units in the same property are excluded (the leak fix).
            where: { listingStatus: { not: "archived" }, ownerPartyId },
            select: {
              id: true,
              occupancyStatus: true,
              tenancies: {
                where: { status: "active" },
                select: {
                  id: true,
                  tenantPartyId: true,
                  tenantParty: { select: { displayName: true } },
                  startDate: true,
                  endDate: true,
                  monthlyRentAmount: true,
                },
                take: 1,
              },
              deposits: {
                where: { status: "released_to_owner" },
                select: {
                  id: true,
                  type: true,
                  amount: true,
                  status: true,
                },
              },
            },
          },
        },
        orderBy: { unitCode: "asc" },
      },
    },
  });

  if (!property) return null;

  // Management fee config for this owner (property-specific or all-properties).
  const feeConfig = await db.managementFeeConfig.findFirst({
    where: {
      organizationId: orgId,
      ownerPartyId,
      isActive: true,
      OR: [{ propertyId }, { propertyId: null }],
    },
    orderBy: [
      // Property-specific config takes priority over all-properties config.
      { propertyId: "desc" },
      { updatedAt: "desc" },
    ],
    select: {
      feeType: true,
      feeValue: true,
      sstPercent: true,
      capAmount: true,
    },
  });

  const units = property.apartments.flatMap((apt) =>
    apt.listings.map((listing) => {
      const activeTenancy = listing.tenancies[0] ?? null;
      return {
        listingId: listing.id,
        unitCode: apt.unitCode,
        occupancyStatus: listing.occupancyStatus,
        currentTenancy: activeTenancy
          ? {
              id: activeTenancy.id,
              tenantDisplayName: activeTenancy.tenantParty.displayName,
              startDate: activeTenancy.startDate.toISOString().slice(0, 10),
              endDate: activeTenancy.endDate ? activeTenancy.endDate.toISOString().slice(0, 10) : null,
              monthlyRentAmount: activeTenancy.monthlyRentAmount.toString(),
            }
          : null,
        deposits: listing.deposits.map((d) => ({
          id: d.id,
          type: d.type,
          amount: d.amount.toString(),
          status: d.status,
        })),
      };
    }),
  );

  return {
    id: property.id,
    name: property.name,
    address: {
      addressLine1: property.addressLine1,
      addressLine2: property.addressLine2,
      city: property.city,
      state: property.state,
      postalCode: property.postalCode,
      country: property.country,
    },
    managerId: property.managerId,
    units,
    managementFeeConfig: feeConfig
      ? {
          feeType: feeConfig.feeType,
          feeValue: feeConfig.feeValue.toString(),
          sstPercent: feeConfig.sstPercent.toString(),
          capAmount: feeConfig.capAmount ? feeConfig.capAmount.toString() : null,
        }
      : null,
  };
}
