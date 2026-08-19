// Workstream E, Part 5 — combined TENANT statement (charges grouped by UNIT
// CONTEXT and de-identified — PDPA fix #5).
//
// A tenant can hold charges tied to MORE than one unit context in a single
// month: their residential rent belongs to the home unit, while a carpark bay
// they rent is its own context. This repo aggregates the tenant's party-scoped
// charges for a month and groups them by unit / carpark, labelling each group by
// the apartment's unit code or "Carpark". It deliberately resolves and returns
// NO owner identity (display name or partyId): a tenant must never be able to
// learn who their owner is. (Owner money-routing happens at charge-creation /
// owner-ledger-sync time, not in this read-only tenant view.)
//
// Reuses the party-scoped filter (partyId + organizationId, no tenancyId) that
// portal.charges.repository.listCharges uses, so the tenant only ever sees
// their own charges.
import { getDb } from "@kason/db";
import { tenantVisibleChargeWhere } from "@kason/shared";
import { adjustmentSumsByChargeId } from "../../billing-documents/adjustment-sums";

function toNumber(value: { toString(): string } | string | number | null | undefined): number {
  if (value == null) return 0;
  if (typeof value === "number") return value;
  return Number(value.toString());
}

type SessionScope = { partyId: string; orgId: string };

export type StatementLine = {
  id: string;
  chargeNumber: string;
  chargeType: string;
  description: string | null;
  status: string;
  dueDate: string;
  amount: number;
  /** amount + active debit notes − active credit notes (punch list B, 2026-08-06).
   * Subtotals/totals accumulate THIS, so the statement agrees with what is payable. */
  adjustedAmount: number;
  outstandingAmount: number;
  currency: string;
};

export type StatementGroup = {
  /**
   * Stable grouping key — the unit (Listing) id, the carpark id, or
   * "__unassigned__". Opaque to the tenant and carries NO owner identity
   * (PDPA #5): the owner's partyId is deliberately NOT exposed here.
   */
  groupKey: string;
  /**
   * Tenant-facing heading: the apartment's unit code, "Carpark", or the
   * unassigned label. Never the owner's name.
   */
  groupLabel: string;
  lines: StatementLine[];
  subtotal: number;
  outstandingSubtotal: number;
};

export type CombinedStatement = {
  /** First-of-month, ISO date (the period the statement covers). */
  month: string;
  /** Human label, e.g. "June 2026". */
  monthLabel: string;
  currency: string;
  groups: StatementGroup[];
  total: number;
  outstandingTotal: number;
};

const UNOWNED_LABEL = "Unassigned owner";

/**
 * Build the tenant's combined statement for `month` (YYYY-MM), grouped by the
 * UNIT CONTEXT each charge belongs to (the home unit, or the rented carpark bay)
 * and labelled by unit code / "Carpark". The owner's identity is never resolved
 * or returned — a tenant must not be able to learn who their owner is (PDPA #5).
 * Charges are selected by dueDate within the month — the same window the
 * owner-ledger rent sync uses — so the tenant view and the owners' ledgers agree
 * on which charges belong to the period.
 */
export async function getCombinedStatement(
  session: SessionScope,
  month: string,
): Promise<CombinedStatement> {
  const db = getDb();
  const [year, mon] = month.split("-").map(Number);
  const monthStart = new Date(Date.UTC(year!, mon! - 1, 1));
  const monthEnd = new Date(Date.UTC(year!, mon!, 0));

  const rows = await db.charge.findMany({
    where: {
      partyId: session.partyId,
      organizationId: session.orgId,
      // Was `{ not: "void" }`, which excluded void but still admitted DRAFT —
      // so a month's statement (and its printed totals) included charges no
      // admin had approved. The shared filter excludes both.
      ...tenantVisibleChargeWhere(),
      dueDate: { gte: monthStart, lte: monthEnd },
    },
    select: {
      id: true,
      chargeNumber: true,
      chargeType: true,
      description: true,
      status: true,
      dueDate: true,
      amount: true,
      outstandingAmount: true,
      currency: true,
      // Resolve only the UNIT CONTEXT this charge belongs to — NEVER the owner.
      // Unit charges (residential/room): label via charge.unit.apartment.unitCode.
      // Carpark charges (unitId=null, carparkId set): labelled "Carpark".
      // No ownerPartyId and no ownerParty.displayName are selected — the tenant
      // statement must not carry the owner's identity (PDPA #5).
      unit: {
        select: {
          id: true,
          apartment: { select: { unitCode: true } },
        },
      },
      carpark: {
        select: { id: true },
      },
    },
    orderBy: { dueDate: "asc" },
  });

  // CN/DN awareness (punch list B): subtotals/totals accumulate the ADJUSTED
  // amount so the statement's arithmetic matches the payable side.
  const adjustmentSums = await adjustmentSumsByChargeId(db, session.orgId, rows.map((r) => r.id));

  // Group by unit context (stable insertion order keyed by unit/carpark id).
  const groups = new Map<string, StatementGroup>();
  let total = 0;
  let outstandingTotal = 0;
  let currency = "MYR";

  for (const r of rows) {
    // Task B2 (#9): a 0.00 utility charge (the owner's subsidy fully covered
    // that room's share) is a confusing render artifact — skip the line
    // entirely. Never touches a non-utility charge (e.g. a legitimately-zero
    // rent adjustment stays visible). 0 was already contributing 0 to every
    // total below, so this is presentation-only.
    if (r.chargeType === "utility" && toNumber(r.amount) === 0) continue;

    // Group + label by UNIT CONTEXT, not by owner (PDPA #5): the residential
    // unit's Listing id / its apartment's unit code, or the carpark bay's id /
    // the plain label "Carpark". No owner identifier is read.
    const groupKey = r.unit?.id ?? r.carpark?.id ?? "__unassigned__";
    const groupLabel = r.unit?.apartment?.unitCode ?? (r.carpark ? "Carpark" : UNOWNED_LABEL);
    const amount = toNumber(r.amount);
    const outstanding = toNumber(r.outstandingAmount);
    currency = r.currency;

    let group = groups.get(groupKey);
    if (!group) {
      group = {
        groupKey,
        groupLabel,
        lines: [],
        subtotal: 0,
        outstandingSubtotal: 0,
      };
      groups.set(groupKey, group);
    }
    const adj = adjustmentSums.get(r.id);
    const adjustedAmount = amount + ((adj?.debitCents ?? 0) - (adj?.creditCents ?? 0)) / 100;

    group.lines.push({
      id: r.id,
      chargeNumber: r.chargeNumber,
      chargeType: r.chargeType,
      description: r.description,
      status: r.status,
      dueDate: r.dueDate.toISOString(),
      amount,
      adjustedAmount,
      outstandingAmount: outstanding,
      currency: r.currency,
    });
    group.subtotal += adjustedAmount;
    group.outstandingSubtotal += outstanding;
    total += adjustedAmount;
    outstandingTotal += outstanding;
  }

  const monthLabel = monthStart.toLocaleDateString("en-MY", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

  // Task B2 (#9): a group can only ever be created by a surviving (non-skipped)
  // line above, so an all-zero-utility unit never gets an entry in `groups` in
  // the first place. This filter is a defensive backstop — drop any group that
  // somehow ends up with zero lines — so no empty group card can ever render.
  const nonEmptyGroups = Array.from(groups.values()).filter((g) => g.lines.length > 0);

  return {
    month: monthStart.toISOString().slice(0, 10),
    monthLabel,
    currency,
    groups: nonEmptyGroups,
    total,
    outstandingTotal,
  };
}
