import { getDb } from "@kason/db";
import { centsToString, summarizeStatement, toCents } from "@kason/shared";
import type { OwnerStatementLine } from "@kason/shared";

type SessionScope = { partyId: string; orgId: string };

function toNumber(value: { toString(): string } | string | number | null | undefined): number {
  if (value == null) return 0;
  if (typeof value === "number") return value;
  return Number(value.toString());
}

export async function getFinancials(session: SessionScope, month?: string, propertyIdFilter?: string) {
  const db = getDb();
  const now = new Date();
  if (month && !/^\d{4}-\d{2}$/.test(month)) {
    throw new Error("Invalid month format");
  }
  const [year, mon] = month ? month.split("-").map(Number) : [now.getFullYear(), now.getMonth() + 1];
  const monthStart = new Date(year, mon - 1, 1);
  const monthEnd = new Date(year, mon, 0);

  // Owner → units resolved per-unit via Listing.ownerPartyId (owner money is
  // attributed per-unit, NOT per-property via LandlordTenancy). The optional
  // propertyId filter narrows to one of the owner's properties via the listing's
  // apartment → property. Group the flat rows back into property rollups in JS.
  const ownedListings = await db.listing.findMany({
    where: {
      ownerPartyId: session.partyId,
      organizationId: session.orgId,
      listingStatus: { not: "archived" },
      apartment: { underManagement: true, ...(propertyIdFilter ? { propertyId: propertyIdFilter } : {}) },
    },
    select: {
      id: true,
      occupancyStatus: true,
      apartment: {
        select: {
          unitCode: true,
          propertyId: true,
          property: { select: { name: true } },
        },
      },
      tenancies: {
        where: { status: "active" },
        select: {
          tenantPartyId: true,
          tenantParty: { select: { displayName: true } },
          monthlyRentAmount: true,
        },
        take: 1,
      },
    },
    orderBy: { apartment: { unitCode: "asc" } },
  });

  type UnitForFinancials = {
    id: string;
    unitCode: string;
    occupancyStatus: string;
    tenancies: {
      tenantPartyId: string;
      tenantParty: { displayName: string };
      monthlyRentAmount: { toString(): string };
    }[];
  };
  type PropertyWithUnits = {
    id: string;
    name: string;
    units: UnitForFinancials[];
  };

  // Group owned listings into per-property rollups (preserves the prior shape:
  // one entry per property, each carrying its units). Insertion order follows the
  // unitCode-ordered listing scan.
  const propertyMap = new Map<string, PropertyWithUnits>();
  for (const l of ownedListings) {
    const propertyId = l.apartment.propertyId;
    let prop = propertyMap.get(propertyId);
    if (!prop) {
      prop = { id: propertyId, name: l.apartment.property.name, units: [] };
      propertyMap.set(propertyId, prop);
    }
    prop.units.push({
      id: l.id,
      unitCode: l.apartment.unitCode,
      occupancyStatus: l.occupancyStatus,
      tenancies: l.tenancies,
    });
  }
  const propertiesWithUnits: PropertyWithUnits[] = [...propertyMap.values()];

  // Collect all unit IDs with active tenancies for batched charge query
  const allUnitIds: string[] = [];
  for (const property of propertiesWithUnits) {
    for (const unit of property.units) {
      if (unit.tenancies.length > 0) {
        allUnitIds.push(unit.id);
      }
    }
  }

  // Single batched query for all charges instead of N+1 per-unit queries
  const allCharges = allUnitIds.length > 0
    ? await db.charge.findMany({
        where: {
          organizationId: session.orgId,
          unitId: { in: allUnitIds },
          chargeType: "rent",
          dueDate: { gte: monthStart, lte: monthEnd },
          status: { not: "void" },
        },
        select: { unitId: true, amount: true, outstandingAmount: true, status: true },
      })
    : [];

  // Group charges by unitId using a Map for O(1) lookup
  const chargesByUnit = new Map<string, typeof allCharges>();
  for (const charge of allCharges) {
    if (!charge.unitId) continue;
    const existing = chargesByUnit.get(charge.unitId);
    if (existing) {
      existing.push(charge);
    } else {
      chargesByUnit.set(charge.unitId, [charge]);
    }
  }

  let totalExpected = 0;
  let totalCollected = 0;

  const properties = propertiesWithUnits.map((property) => {
    const units = property.units.map((unit) => {
      const activeTenancy = unit.tenancies[0];
      if (!activeTenancy) {
        return { unitCode: unit.unitCode, tenantName: null, expectedRent: 0, paidAmount: 0, status: "vacant" as const };
      }

      const expectedRent = toNumber(activeTenancy.monthlyRentAmount);
      const charges = chargesByUnit.get(unit.id) ?? [];

      const paidAmount = charges.reduce((sum, c) => sum + toNumber(c.amount) - toNumber(c.outstandingAmount), 0);
      const hasOverdue = charges.some((c) => c.status === "overdue" || (c.status === "posted" && toNumber(c.outstandingAmount) > 0));

      totalExpected += expectedRent;
      totalCollected += paidAmount;

      return {
        unitCode: unit.unitCode,
        tenantName: activeTenancy.tenantParty.displayName,
        expectedRent,
        paidAmount,
        status: (paidAmount >= expectedRent ? "paid" : hasOverdue ? "overdue" : "partial") as "paid" | "overdue" | "partial",
      };
    });

    return {
      id: property.id,
      name: property.name,
      totalUnits: property.units.length,
      occupiedUnits: property.units.filter((u) => u.occupancyStatus === "occupied").length,
      expectedRent: units.reduce((sum, u) => sum + u.expectedRent, 0),
      collectedRent: units.reduce((sum, u) => sum + u.paidAmount, 0),
      units,
    };
  });

  return {
    month: `${year}-${String(mon).padStart(2, "0")}`,
    properties,
    totals: {
      expectedRent: totalExpected,
      collectedRent: totalCollected,
      collectionRate: totalExpected > 0 ? totalCollected / totalExpected : 0,
    },
  };
}

/**
 * Collected rent for one owner in one billing month — the SAME resolution the
 * owner-portal financials surface uses (`getFinancials().totals.collectedRent`),
 * extracted so the owner-statement PDF and the portal can never diverge.
 *
 * Collected rent = Σ over the owner's units of (rent Charge.amount −
 * outstandingAmount) for `chargeType:"rent"` charges due that month, status not
 * "void". Org-scoped via the LandlordTenancy {landlordId, organizationId,
 * status:"active"} chain (a cross-org owner resolves to an empty set → "0.00").
 *
 * `month` is "YYYY-MM". Returns a 2dp money string (RM) built from integer cents
 * so it feeds straight into `summarizeStatement` without float drift.
 */
export async function getCollectedRentForOwnerMonth(
  orgId: string,
  ownerPartyId: string,
  month: string,
): Promise<string> {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("Invalid month format");
  const db = getDb();
  const [year, mon] = month.split("-").map(Number);
  const monthStart = new Date(year!, mon! - 1, 1);
  const monthEnd = new Date(year!, mon!, 0);

  // Owner → non-archived listings keyed by the per-unit Listing.ownerPartyId —
  // the SAME owner→units resolution getFinancials walks to collect unit ids.
  const ownedListings = await db.listing.findMany({
    where: { ownerPartyId, organizationId: orgId, listingStatus: { not: "archived" }, apartment: { underManagement: true } },
    select: {
      id: true,
      tenancies: { where: { status: "active" }, select: { id: true }, take: 1 },
    },
  });

  // Only units with an active tenancy carry rent charges (mirrors getFinancials,
  // which only queries charges for units whose tenancies.length > 0).
  const unitIds: string[] = [];
  for (const listing of ownedListings) {
    if (listing.tenancies.length > 0) unitIds.push(listing.id);
  }
  if (unitIds.length === 0) return "0.00";

  const charges = await db.charge.findMany({
    where: {
      organizationId: orgId,
      unitId: { in: unitIds },
      chargeType: "rent",
      dueDate: { gte: monthStart, lte: monthEnd },
      status: { not: "void" },
    },
    select: { amount: true, outstandingAmount: true },
  });

  // Integer-cent summation — paid = amount − outstanding per charge.
  let collectedCents = 0;
  for (const c of charges) {
    const amountCents = Math.round(toNumber(c.amount) * 100);
    const outstandingCents = Math.round(toNumber(c.outstandingAmount) * 100);
    collectedCents += amountCents - outstandingCents;
  }
  return (collectedCents / 100).toFixed(2);
}

// ─── Phase-2 owner-billing extension (Task E1) ──────────────────────────────
//
// ADDITIVE breakdown layered onto the EXISTING getFinancials response ONLY when
// ENABLE_PHASE2_OWNER_BILLING is on (the route gates the call). The base shape is
// produced verbatim by getFinancials — this function NEVER rewrites it, it only
// attaches extra fields:
//   • totals.mgmtFeeDeducted — Σ management-fee charge BASES on the owner's
//     owner_statement Invoice for the month (pre-SST; the SST lives on the fee).
//   • totals.expenses        — Σ every other deduction line (cleaning + the
//     pass-throughs tnb/water/wifi/maintenance/insurance/…), excluding the
//     management-fee base (that is reported separately above).
//   • totals.netRemittance   — collectedRent − Σ all deductions (incl. SST), via
//     summarizeStatement (the SAME net-remittance helper the statement PDF uses,
//     so the portal and the PDF can never diverge).
//   • feeBreakdown           — { percentLabel, base, sst, total } describing the
//     management-fee line, or null when the statement carries no fee line.
//
// Owner scope: the statement is fetched by the canonical owner+org idempotency
// key ("owner:<partyId>:<month>"), so an owner can only ever resolve THEIR OWN
// statement. Collected rent reuses getCollectedRentForOwnerMonth (D1) — no third
// collected-rent query. When the owner has no statement for the month, the
// breakdown is all-zero and feeBreakdown is null (net remittance == collected
// rent, nothing deducted).

/** The additive owner-billing breakdown attached to the financials totals. */
export type OwnerFeeBreakdown = {
  /** Human label for the fee line, e.g. "10%" (percent) or "Fixed" / "Capped". */
  percentLabel: string;
  /** Fee base (pre-SST), 2dp string. */
  base: string;
  /** SST charged on the fee, 2dp string. */
  sst: string;
  /** base + sst, 2dp string. */
  total: string;
};

export type FinancialsExtended = Awaited<ReturnType<typeof getFinancials>> & {
  totals: Awaited<ReturnType<typeof getFinancials>>["totals"] & {
    /** Σ management-fee BASES on the owner's statement this month, 2dp string. */
    mgmtFeeDeducted: string;
    /** Σ non-fee deduction lines (cleaning + pass-throughs), 2dp string. */
    expenses: string;
    /** collectedRent − total deductions (incl. SST), 2dp string (may be negative). */
    netRemittance: string;
  };
  /** Management-fee breakdown for the month, or null when no fee line exists. */
  feeBreakdown: OwnerFeeBreakdown | null;
};

/**
 * Build a human label for the management-fee line from the active fee config.
 * Percent → "<value>%"; fixed → "Fixed"; cap → "Capped". Falls back to "Fee"
 * when no config resolves (defensive — a fee line implies a config existed).
 */
function feePercentLabel(
  feeType: string | null | undefined,
  feeValue: string | null | undefined,
): string {
  if (feeType === "percent" && feeValue != null) {
    // Trim a trailing ".00"/".0" so "10.00" renders as "10%".
    const trimmed = feeValue.replace(/\.0+$/, "");
    return `${trimmed}%`;
  }
  if (feeType === "fixed") return "Fixed";
  if (feeType === "cap") return "Capped";
  return "Fee";
}

/**
 * EXTENDED financials: the existing getFinancials response PLUS the owner's
 * management-fee / expenses / net-remittance breakdown for the month. Called by
 * the route ONLY when the Phase-2 flag is on; flag-off callers get the base
 * getFinancials response unchanged.
 */
export async function getFinancialsExtended(
  session: SessionScope,
  month?: string,
  propertyIdFilter?: string,
): Promise<FinancialsExtended> {
  // 1) Base response — produced verbatim by the existing function, untouched.
  const base = await getFinancials(session, month, propertyIdFilter);

  const db = getDb();
  // The statement is keyed on the resolved month (base.month is always "YYYY-MM",
  // even when the caller omitted `month`), so we read the SAME period the base
  // response reports. Owner+org idempotency key → an owner can only see THEIR
  // statement (cross-owner key never matches).
  const idempotencyKey = `owner:${session.partyId}:${base.month}`;
  const statement = await db.invoice.findFirst({
    where: {
      organizationId: session.orgId,
      ownerPartyId: session.partyId,
      invoiceType: "owner_statement",
      idempotencyKey,
    },
    select: {
      sstAmount: true,
      charges: {
        where: { status: { not: "void" } },
        select: { chargeType: true, amount: true, unitId: true },
      },
    },
  });

  // Collected rent — REUSE the D1 helper (no third collected-rent query). This is
  // the exact figure the statement PDF and base.totals.collectedRent agree on.
  const collectedRent = await getCollectedRentForOwnerMonth(session.orgId, session.partyId, base.month);

  // No statement for the month → nothing deducted; net remittance == collected.
  if (!statement) {
    return {
      ...base,
      totals: {
        ...base.totals,
        mgmtFeeDeducted: "0.00",
        expenses: "0.00",
        netRemittance: centsToString(toCents(collectedRent, "financialsExtended")),
      },
      feeBreakdown: null,
    };
  }

  const lines = statement.charges;

  // mgmtFeeDeducted — Σ management-fee BASES (pre-SST). The SST is reported on the
  // fee line itself (statement.sstAmount) and folded into netRemittance below.
  let mgmtFeeCents = 0;
  // expenses — every NON-fee deduction line (cleaning + pass-throughs).
  let expensesCents = 0;
  for (const line of lines) {
    const cents = toCents(line.amount.toString(), "financialsExtended");
    if (line.chargeType === "management_fee") mgmtFeeCents += cents;
    else expensesCents += cents;
  }

  // netRemittance — collectedRent − Σ(all deduction lines + their SST), via the
  // canonical summarizeStatement helper. The whole Invoice.sstAmount is the
  // statement's aggregate fee SST (the upstream generate path folds every fee
  // line's SST into this one column), so we attach it to EXACTLY ONE fee line for
  // the summary — never per-line, or a multi-fee-line statement would double-count
  // it. summarizeStatement sums each line's own sstAmount; non-fee lines carry 0.
  const sstTotal = statement.sstAmount === null ? "0.00" : statement.sstAmount.toString();
  const hasFeeLine = lines.some((l) => l.chargeType === "management_fee");
  let sstAttached = false;
  const summaryLines: OwnerStatementLine[] = lines.map((line) => {
    const isFee = line.chargeType === "management_fee";
    const carriesSst = isFee && !sstAttached;
    if (carriesSst) sstAttached = true;
    return {
      chargeType: line.chargeType,
      amount: line.amount.toString(),
      sstAmount: carriesSst ? sstTotal : "0.00",
    };
  });
  // Guard: if there is SST but no fee line to carry it (should not happen — SST
  // only exists because a fee line was billed), append a synthetic zero-base fee
  // line so the SST is still deducted from net remittance.
  if (!hasFeeLine && toCents(sstTotal, "financialsExtended") !== 0) {
    summaryLines.push({ chargeType: "management_fee", amount: "0.00", sstAmount: sstTotal });
  }
  const summary = summarizeStatement({ collectedRent, lines: summaryLines });

  // feeBreakdown — present only when a management-fee line exists. Resolve the
  // owner's active fee config for the label (percent value etc.). The base is the
  // summed mgmt-fee charge bases; sst is the statement SST; total = base + sst.
  let feeBreakdown: OwnerFeeBreakdown | null = null;
  if (hasFeeLine) {
    const feeConfig = await db.managementFeeConfig.findFirst({
      where: { organizationId: session.orgId, ownerPartyId: session.partyId, isActive: true },
      orderBy: { updatedAt: "desc" },
      select: { feeType: true, feeValue: true },
    });
    const base2 = centsToString(mgmtFeeCents);
    const sst = centsToString(toCents(sstTotal, "financialsExtended"));
    feeBreakdown = {
      percentLabel: feePercentLabel(feeConfig?.feeType ?? null, feeConfig?.feeValue?.toString() ?? null),
      base: base2,
      sst,
      total: centsToString(mgmtFeeCents + toCents(sstTotal, "financialsExtended")),
    };
  }

  return {
    ...base,
    totals: {
      ...base.totals,
      mgmtFeeDeducted: centsToString(mgmtFeeCents),
      expenses: centsToString(expensesCents),
      netRemittance: summary.netRemittance,
    },
    feeBreakdown,
  };
}
