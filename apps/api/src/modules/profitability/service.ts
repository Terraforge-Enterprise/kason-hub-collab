import { getDb } from "@kason/db";

type View = "owner" | "tenant";

const money = (value: number) => value.toFixed(2);
const excludedStatuses = ["void", "credited", "cancelled", "draft"];

export type ProfitabilityFilters = { view: View; month?: string; q?: string };

export async function getProfitability(orgId: string, filters: ProfitabilityFilters) {
  const db = getDb();
  const start = filters.month ? new Date(`${filters.month}-01T00:00:00.000Z`) : undefined;
  const end = start ? new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1)) : undefined;
  const charges = await db.charge.findMany({
    where: {
      organizationId: orgId,
      revenueRecognition: "manager_revenue",
      nonBillable: false,
      status: { notIn: excludedStatuses },
      ...(start && end ? { billingMonth: { gte: start, lt: end } } : {}),
      party: {
        roles: { some: { roleType: filters.view, status: "active" } },
        ...(filters.q?.trim() ? { displayName: { contains: filters.q.trim(), mode: "insensitive" } } : {}),
      },
    },
    orderBy: [{ billingMonth: "desc" }, { createdAt: "desc" }],
    include: {
      party: { select: { id: true, displayName: true } },
      category: { select: { name: true, code: true, defaultSstRate: true } },
      unit: { select: { apartment: { select: { unitCode: true, property: { select: { name: true } } } } } },
      tenancy: { select: { tenancyCode: true } },
      sourceGridExpense: { select: { id: true, actualCost: true, costPaymentStatus: true, costVendor: true } },
      allocations: { include: { payment: { select: { status: true } } } },
    },
  });

  const allocationIds = charges.flatMap((charge) => charge.allocations.map((item) => item.id));
  const reversals = allocationIds.length ? await db.paymentAllocationReversal.findMany({
    where: { organizationId: orgId, originalAllocationId: { in: allocationIds } },
    select: { originalAllocationId: true, amount: true },
  }) : [];
  const reversed = new Map<string, number>();
  for (const item of reversals) reversed.set(item.originalAllocationId, (reversed.get(item.originalAllocationId) ?? 0) + Number(item.amount));

  const details = charges.map((charge) => {
    const charged = Number(charge.amount);
    const gridCost = charge.sourceGridExpense?.actualCost;
    const missingCost = !!charge.sourceGridExpenseId && gridCost == null && charge.actualCost == null;
    const actualCost = missingCost ? null : Number(charge.actualCost ?? gridCost ?? 0);
    const grossProfit = actualCost == null ? null : charged - actualCost;
    const collected = charge.allocations.reduce((sum, allocation) => {
      if (allocation.payment.status !== "posted") return sum;
      return sum + Math.max(0, Number(allocation.allocatedAmount) - (reversed.get(allocation.id) ?? 0));
    }, 0);
    const collectionRatio = charged > 0 ? Math.min(1, collected / charged) : 0;
    const collectedProfit = grossProfit == null ? null : grossProfit * collectionRatio;
    const sstRate = Number(charge.sstRate ?? charge.taxRate ?? charge.category?.defaultSstRate ?? 0);
    return {
      id: charge.id,
      partyId: charge.party.id,
      partyName: charge.party.displayName,
      date: (charge.postedAt ?? charge.createdAt).toISOString(),
      month: (charge.billingMonth ?? charge.createdAt).toISOString().slice(0, 7),
      chargeNumber: charge.chargeNumber,
      category: charge.category?.name ?? charge.chargeType,
      description: charge.description ?? charge.category?.name ?? charge.chargeType,
      property: charge.unit?.apartment.property.name ?? "—",
      unit: charge.unit?.apartment.unitCode ?? "—",
      tenancyCode: charge.tenancy?.tenancyCode ?? null,
      chargedBeforeSst: money(charged),
      sst: money(charged * sstRate / 100),
      actualCost: actualCost == null ? null : money(actualCost),
      grossProfit: grossProfit == null ? null : money(grossProfit),
      collectedProfit: collectedProfit == null ? null : money(collectedProfit),
      outstandingProfit: grossProfit == null || collectedProfit == null ? null : money(grossProfit - collectedProfit),
      missingCost,
      costPaymentStatus: charge.sourceGridExpense?.costPaymentStatus ?? (actualCost === 0 ? "not_applicable" : "unknown"),
      status: Number(charge.outstandingAmount) <= 0 ? "Paid" : collected > 0 ? "Partially Paid" : "Outstanding",
    };
  });

  const grouped = new Map<string, { partyId: string; partyName: string; units: Set<string>; charges: number; actualCost: number; grossProfit: number; collectedProfit: number; missingCostCount: number; itemCount: number }>();
  for (const item of details) {
    const row = grouped.get(item.partyId) ?? { partyId: item.partyId, partyName: item.partyName, units: new Set<string>(), charges: 0, actualCost: 0, grossProfit: 0, collectedProfit: 0, missingCostCount: 0, itemCount: 0 };
    if (item.property !== "—" || item.unit !== "—") row.units.add(`${item.property} ${item.unit}`.trim());
    row.charges += Number(item.chargedBeforeSst);
    if (item.actualCost != null) row.actualCost += Number(item.actualCost);
    if (item.grossProfit != null) row.grossProfit += Number(item.grossProfit);
    if (item.collectedProfit != null) row.collectedProfit += Number(item.collectedProfit);
    if (item.missingCost) row.missingCostCount += 1;
    row.itemCount += 1;
    grouped.set(item.partyId, row);
  }
  const rows = [...grouped.values()].map((row) => ({
    partyId: row.partyId, partyName: row.partyName, units: [...row.units], itemCount: row.itemCount,
    chargesBeforeSst: money(row.charges), actualCost: money(row.actualCost), grossProfit: money(row.grossProfit),
    collectedProfit: money(row.collectedProfit), outstandingProfit: money(row.grossProfit - row.collectedProfit), missingCostCount: row.missingCostCount,
    details: details.filter((item) => item.partyId === row.partyId),
  })).sort((a, b) => Number(b.grossProfit) - Number(a.grossProfit));
  const totals = rows.reduce((sum, row) => ({
    chargesBeforeSst: sum.chargesBeforeSst + Number(row.chargesBeforeSst), actualCost: sum.actualCost + Number(row.actualCost), grossProfit: sum.grossProfit + Number(row.grossProfit), collectedProfit: sum.collectedProfit + Number(row.collectedProfit), outstandingProfit: sum.outstandingProfit + Number(row.outstandingProfit), missingCostCount: sum.missingCostCount + row.missingCostCount,
  }), { chargesBeforeSst: 0, actualCost: 0, grossProfit: 0, collectedProfit: 0, outstandingProfit: 0, missingCostCount: 0 });
  return { view: filters.view, month: filters.month ?? null, rows, totals: { ...Object.fromEntries(Object.entries(totals).filter(([key]) => key !== "missingCostCount").map(([key, value]) => [key, money(value)])), missingCostCount: totals.missingCostCount } };
}
