import { getDb } from "@kason/db";
import { tenantVisibleChargeWhere, tenantVisibleDocumentWhere } from "@kason/shared";
import { remainingCreditByNote } from "../../billing-documents/credit-apply.service";
import { adjustmentSumsByChargeId } from "../../billing-documents/adjustment-sums";

// Empty-guard sentinel for unit-id `in` filters. MUST be a valid UUID: `unitId`
// is a @db.Uuid column, so a non-UUID string ("__none__") throws Prisma P2007
// ("invalid input syntax for type uuid") when the owner has zero managed units.
// The nil UUID is valid and matches no real `Listing.id` → the query returns empty
// instead of 500-ing the owner dashboard. Verified against the real local DB.
const NO_UNIT_SENTINEL = "00000000-0000-0000-0000-000000000000";

// Rows per attention KIND on Home. These lists are exceptions, not a ledger, but
// "exception" is not a bound: `rejected` payments are never cleaned up and
// deliberately never block a retry (see the guard in
// portal.payments.repository.ts), so a tenant who re-submits a bad slip five
// times accumulates five refusals forever. An unbounded findMany feeding an
// unbounded render is how the feed this replaced went wrong in the first place.
//
// Fetching CAP + 1 is what makes the truncation HONEST: the extra row is never
// displayed, it only proves more exist, so the UI can say so instead of silently
// dropping them. Exact totals would cost another round trip for a number the
// tenant does not need — the Billing → Payments tab has the full list.
const ATTENTION_ROW_CAP = 3;

function toNumber(value: { toString(): string } | string | number | null | undefined): number {
  if (value == null) return 0;
  if (typeof value === "number") return value;
  return Number(value.toString());
}

type SessionScope = { partyId: string; orgId: string };

export async function getDashboardData(session: SessionScope) {
  const db = getDb();
  const now = new Date();

  const [tenant, tenancy, charges, payments, announcements] = await Promise.all([
    db.party.findFirst({
      where: { id: session.partyId, organizationId: session.orgId },
      select: { displayName: true, partyType: true },
    }),

    db.tenancy.findFirst({
      where: {
        tenantPartyId: session.partyId,
        organizationId: session.orgId,
        status: "active",
      },
      select: {
        tenancyCode: true,
        startDate: true,
        endDate: true,
        monthlyRentAmount: true,
        status: true,
        unit: { select: { apartment: { select: { unitCode: true } } } },
        property: { select: { name: true } },
      },
      orderBy: { startDate: "desc" },
    }),

    // Soonest-first unpaid charges. Previously filtered on
    // `{ in: ["posted", "partial"] }` — "partial" is NOT a live charge status
    // (the API writes "partially_paid"), so every part-settled charge silently
    // vanished from both this list and the "Next Due" card. Now driven by the
    // shared tenant-visibility deny-list, which excludes draft/void and keeps
    // partially_paid. `outstandingAmount > 0` is what makes these UNPAID rows
    // specifically — paid/credited charges are tenant-visible (see the map) but
    // are not "upcoming".
    //
    // `take: 5` is safe ONLY because every consumer now reads index 0 (the
    // "Next Due" card on Home and on the Billing header). It is NOT a list to
    // render: Home used to merge this with `recentPayments` into a feed, and
    // the two caps silently dropped rows — 6 charges + 1 payment rendered as 6
    // of 7 with no indication anything was missing. Counts and totals come from
    // the un-capped aggregates below; the full lists live on the Billing tab.
    db.charge.findMany({
      where: {
        partyId: session.partyId,
        organizationId: session.orgId,
        ...tenantVisibleChargeWhere(),
        outstandingAmount: { gt: 0 },
      },
      select: {
        id: true,
        chargeNumber: true,
        chargeType: true,
        amount: true,
        outstandingAmount: true,
        dueDate: true,
        status: true,
      },
      orderBy: { dueDate: "asc" },
      take: 5,
    }),

    // Recent payments of ANY status. Kept on the response for API compatibility,
    // but no longer rendered as a feed: Home hardcoded an emerald "Paid" badge
    // on every row here, so a `pending_approval` slip and a `rejected` one both
    // read as money received. Payment state now reaches the tenant through
    // `attention` below (unresolved only) and the Billing → Payments tab (all,
    // with real per-row status). Any new consumer of this array MUST read
    // `status` — it is not a list of settled money.
    db.payment.findMany({
      where: {
        partyId: session.partyId,
        organizationId: session.orgId,
      },
      select: {
        id: true,
        paymentNumber: true,
        amount: true,
        status: true,
        receivedAt: true,
      },
      orderBy: { receivedAt: "desc" },
      take: 5,
    }),

    // NOTE: `take: 5` and Home renders every row it receives, so a 6th active
    // announcement is silently invisible — the same shape as the charge/payment
    // feed bug fixed here, minus the money. Left as-is (out of scope): if this
    // ever matters, the fix is a count alongside the rows and a "showing N of M"
    // footer, NOT a bigger cap.
    db.announcement.findMany({
      where: {
        organizationId: session.orgId,
        active: true,
        startDate: { lte: now },
        OR: [{ endDate: null }, { endDate: { gte: now } }],
      },
      select: {
        id: true,
        title: true,
        message: true,
        type: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
      take: 5,
    }),
  ]);

  // ── Balance ────────────────────────────────────────────────────────────────
  // This block had two defects that compounded into a wrong, leaky headline
  // figure on the tenant's Home screen:
  //
  //  1. The charge aggregate carried NO status filter at all, so it summed
  //     draft AND void charges. A draft rent charge is money no admin has
  //     approved yet (see @kason/shared tenant-visibility) — billing the tenant
  //     for it, and exposing the pre-approval amount, is the bug being fixed.
  //  2. netBalance was Σamount − Σpayments, where the payment leg counted every
  //     non-void payment INCLUDING self-submitted `pending_approval` ones. A
  //     tenant could knock down their own displayed balance just by filing an
  //     unverified payment claim.
  //
  // Both die by sourcing the balance from `outstandingAmount` over
  // tenant-visible charges. Outstanding is the authoritative unpaid figure:
  // payments.repository.ts decrements it only when a payment actually settles
  // (and restores it on reversal), and Charge.status is DERIVED from it by
  // chargeStatusForOutstanding — so the two can never disagree.
  const [
    chargeAgg,
    unpaidCount,
    overdueAgg,
    pendingVerificationPayments,
    rejectedPayments,
    paymentAgg,
    openCreditNotes,
    upcomingAdjustments,
  ] = await Promise.all([
    db.charge.aggregate({
      where: {
        partyId: session.partyId,
        organizationId: session.orgId,
        ...tenantVisibleChargeWhere(),
      },
      _sum: { amount: true, outstandingAmount: true },
    }),
    // The REAL unpaid count. The UI used to derive this from `upcomingCharges`,
    // which is `take: 5` — so a tenant with 9 unpaid items was told "5".
    db.charge.count({
      where: {
        partyId: session.partyId,
        organizationId: session.orgId,
        ...tenantVisibleChargeWhere(),
        outstandingAmount: { gt: 0 },
      },
    }),
    // OVERDUE — the same un-capped treatment as `unpaidCount`, for the same
    // reason. The Billing page derived its Overdue card in the browser by
    // filtering `/charges?page=1&limit=20`, so a tenant with more than 20
    // charges was shown a total short by everything on page 2+. Home and
    // Billing now read this one figure. `dueDate < now` + outstanding > 0 is
    // the whole rule; charge STATUS is deliberately not consulted, because
    // `partially_paid` rows are still overdue for their remainder (the old
    // client-side predicate required status === "posted" and silently dropped
    // them).
    db.charge.aggregate({
      where: {
        partyId: session.partyId,
        organizationId: session.orgId,
        ...tenantVisibleChargeWhere(),
        outstandingAmount: { gt: 0 },
        dueDate: { lt: now },
      },
      _sum: { outstandingAmount: true },
      _count: true,
    }),
    // Slips the tenant has submitted and the office has not ruled on. These are
    // the tenant's OWN claims, not money we have received — see the payment
    // aggregate below, which counts only "posted".
    db.payment.findMany({
      where: {
        partyId: session.partyId,
        organizationId: session.orgId,
        status: "pending_approval",
      },
      select: { id: true, paymentNumber: true, amount: true, receivedAt: true },
      orderBy: { receivedAt: "desc" },
      take: ATTENTION_ROW_CAP + 1,
    }),
    // Refused slips. The reason travels with them: "rejected" with no cause
    // leaves the tenant unable to fix the thing we are asking them to fix.
    db.payment.findMany({
      where: {
        partyId: session.partyId,
        organizationId: session.orgId,
        status: "rejected",
      },
      select: { id: true, paymentNumber: true, amount: true, receivedAt: true, rejectionReason: true },
      orderBy: { receivedAt: "desc" },
      take: ATTENTION_ROW_CAP + 1,
    }),
    // SETTLED money only. "posted" is what the settle path writes
    // (payments.repository.ts); `{ not: "void" }` would also count
    // pending_approval / expired attempts as if the tenant had already paid.
    //
    // Split by method: applying a credit note mints a real posted Payment
    // (paymentMethod "credit_note"), so a single sum would report credit the
    // tenant never handed over as cash they "paid". Grouping keeps the breakdown
    // honest — and it still foots, because both legs settle the same charges:
    //   totalCharges − totalCredits − totalPayments = netBalance
    db.payment.groupBy({
      by: ["paymentMethod"],
      where: { partyId: session.partyId, organizationId: session.orgId, status: "posted" },
      _sum: { amount: true },
    }),
    // The tenant's UNSPENT credit — money they hold, not money that has settled
    // anything yet. Deliberately NOT part of the breakdown above: it reduces
    // future bills, not this one, so folding it into netBalance would understate
    // what is currently due.
    db.billingDocument.findMany({
      where: {
        organizationId: session.orgId,
        partyId: session.partyId,
        counterpartyType: "tenant",
        docType: "credit_note",
        creditAmount: { gt: 0 },
        ...tenantVisibleDocumentWhere(),
      },
      select: { id: true, creditAmount: true },
    }),
    // CN/DN awareness for the 5 preview rows, same helper as the charges
    // list/detail (punch list B). netBalance above is Σ outstandingAmount —
    // already adjustment-aware — so a feed row showing raw `amount` disagrees
    // with the headline it sits under the moment a note lands on the charge.
    adjustmentSumsByChargeId(db, session.orgId, charges.map((c) => c.id)),
  ]);

  const totalCharges = toNumber(chargeAgg._sum.amount);
  const creditPaid = paymentAgg
    .filter((p) => p.paymentMethod === "credit_note")
    .reduce((s, p) => s + toNumber(p._sum.amount), 0);
  const totalPayments = paymentAgg
    .filter((p) => p.paymentMethod !== "credit_note")
    .reduce((s, p) => s + toNumber(p._sum.amount), 0);
  const netBalance = toNumber(chargeAgg._sum.outstandingAmount);
  const overdueAmount = toNumber(overdueAgg._sum.outstandingAmount);
  const overdueCount = overdueAgg._count;
  const creditAvailable = [
    ...(await remainingCreditByNote(
      db,
      session.orgId,
      openCreditNotes.map((c) => ({ id: c.id, creditAmount: toNumber(c.creditAmount) })),
    )).values(),
  ].reduce((s, v) => s + v, 0);

  return {
    tenant: tenant ?? { displayName: "Unknown", partyType: "individual" },
    lease: tenancy
      ? {
          tenancyCode: tenancy.tenancyCode,
          unitCode: tenancy.unit.apartment.unitCode,
          propertyName: tenancy.property.name,
          startDate: tenancy.startDate.toISOString(),
          endDate: tenancy.endDate?.toISOString() ?? null,
          monthlyRentAmount: toNumber(tenancy.monthlyRentAmount),
          status: tenancy.status,
        }
      : null,
    upcomingCharges: charges.map((c) => {
      const adj = upcomingAdjustments.get(c.id);
      const amount = toNumber(c.amount);
      const debitNoteTotal = (adj?.debitCents ?? 0) / 100;
      const creditNoteTotal = (adj?.creditCents ?? 0) / 100;
      return {
        id: c.id,
        chargeNumber: c.chargeNumber,
        chargeType: c.chargeType,
        amount,
        debitNoteTotal,
        creditNoteTotal,
        adjustedAmount: amount + debitNoteTotal - creditNoteTotal,
        outstandingAmount: toNumber(c.outstandingAmount),
        dueDate: c.dueDate.toISOString(),
        status: c.status,
      };
    }),
    recentPayments: payments.map((p) => ({
      id: p.id,
      paymentNumber: p.paymentNumber,
      amount: toNumber(p.amount),
      status: p.status,
      receivedAt: p.receivedAt.toISOString(),
    })),
    announcements: announcements.map((a) => ({
      id: a.id,
      title: a.title,
      message: a.message,
      type: a.type,
      createdAt: a.createdAt.toISOString(),
    })),
    attention: {
      // slice(0, CAP) — the CAP+1'th row was fetched only to detect overflow.
      pendingVerificationPayments: pendingVerificationPayments.slice(0, ATTENTION_ROW_CAP).map((p) => ({
        id: p.id,
        paymentNumber: p.paymentNumber,
        amount: toNumber(p.amount),
        submittedAt: p.receivedAt.toISOString(),
      })),
      rejectedPayments: rejectedPayments.slice(0, ATTENTION_ROW_CAP).map((p) => ({
        id: p.id,
        paymentNumber: p.paymentNumber,
        amount: toNumber(p.amount),
        rejectionReason: p.rejectionReason,
        submittedAt: p.receivedAt.toISOString(),
      })),
      // The whole point of the cap: say that rows were withheld rather than
      // drop them silently, which is the bug this section replaced.
      hasMoreUnresolvedPayments:
        pendingVerificationPayments.length > ATTENTION_ROW_CAP ||
        rejectedPayments.length > ATTENTION_ROW_CAP,
    },
    balance: {
      totalCharges,
      totalPayments,
      // Credit that has been APPLIED (settled charges). Was hardcoded 0, which
      // rendered a permanently blank "Credits / adjustments" row.
      totalCredits: creditPaid,
      netBalance,
      unpaidCount,
      overdueAmount,
      overdueCount,
      // Credit still UNSPENT — the voucher balance. Separate from the three
      // figures above by design; see the query comment.
      creditAvailable,
      currency: "MYR",
    },
  };
}

export async function getOwnerDashboardData(session: SessionScope) {
  const db = getDb();
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);

  // Owner → units resolved per-unit via Listing.ownerPartyId (owner money is
  // attributed per-unit, NOT per-property via LandlordTenancy). Group the flat
  // owned-listing rows back into per-property occupancy rollups in JS.
  const ownedListings = await db.listing.findMany({
    where: {
      ownerPartyId: session.partyId,
      organizationId: session.orgId,
      listingStatus: { not: "archived" },
      apartment: { underManagement: true },
    },
    select: {
      id: true,
      occupancyStatus: true,
      apartment: {
        select: { propertyId: true, property: { select: { name: true } } },
      },
    },
  });

  type PropertyWithUnits = {
    id: string;
    name: string;
    units: { id: string; occupancyStatus: string }[];
  };
  const propertyMap = new Map<string, PropertyWithUnits>();
  for (const l of ownedListings) {
    const propertyId = l.apartment.propertyId;
    let prop = propertyMap.get(propertyId);
    if (!prop) {
      prop = { id: propertyId, name: l.apartment.property.name, units: [] };
      propertyMap.set(propertyId, prop);
    }
    prop.units.push({ id: l.id, occupancyStatus: l.occupancyStatus });
  }
  const propertiesWithUnits: PropertyWithUnits[] = [...propertyMap.values()];

  const unitIds = propertiesWithUnits.flatMap((p) => p.units.map((u) => u.id));

  const properties = propertiesWithUnits.map((p) => ({
    id: p.id,
    name: p.name,
    unitCount: p.units.length,
    occupiedCount: p.units.filter((u) => u.occupancyStatus === "occupied").length,
  }));

  const totalUnits = properties.reduce((sum, p) => sum + p.unitCount, 0);
  const occupiedUnits = properties.reduce((sum, p) => sum + p.occupiedCount, 0);

  const [rentAgg, maintenanceAgg, recentPayments] = await Promise.all([
    db.charge.aggregate({
      where: {
        organizationId: session.orgId,
        unitId: { in: unitIds.length > 0 ? unitIds : [NO_UNIT_SENTINEL] },
        chargeType: "rent",
        dueDate: { gte: monthStart, lte: monthEnd },
        status: { not: "void" },
      },
      _sum: { amount: true },
    }),
    db.charge.aggregate({
      where: {
        organizationId: session.orgId,
        unitId: { in: unitIds.length > 0 ? unitIds : [NO_UNIT_SENTINEL] },
        chargeType: "maintenance",
        dueDate: { gte: monthStart, lte: monthEnd },
        status: { not: "void" },
      },
      _sum: { amount: true },
    }),
    db.payment.findMany({
      where: {
        organizationId: session.orgId,
        party: {
          tenancies: {
            some: {
              unitId: { in: unitIds.length > 0 ? unitIds : [NO_UNIT_SENTINEL] },
              status: "active",
            },
          },
        },
      },
      select: {
        id: true,
        amount: true,
        receivedAt: true,
        party: { select: { displayName: true } },
      },
      orderBy: { receivedAt: "desc" },
      take: 5,
    }),
  ]);

  return {
    propertyCount: properties.length,
    totalRentalIncome: toNumber(rentAgg._sum.amount),
    totalMaintenanceSpend: toNumber(maintenanceAgg._sum.amount),
    occupancy: {
      occupied: occupiedUnits,
      total: totalUnits,
      rate: totalUnits > 0 ? occupiedUnits / totalUnits : 0,
    },
    recentTransactions: recentPayments.map((p) => ({
      id: p.id,
      tenantName: p.party.displayName,
      amount: toNumber(p.amount),
      receivedAt: p.receivedAt.toISOString(),
    })),
    properties,
  };
}
