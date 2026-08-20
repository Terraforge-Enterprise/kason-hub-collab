import { getDb } from "@kason/db";
import { computeOwnerRunningBalance, summarizeOwnerPeriod } from "@kason/shared";

export interface BillingFundsSummary {
  tenantDue: string;
  tenantOutstanding: string;
  tenantCollected: string;
  depositsHeld: string;
  ownerExpenses: string;
  managementFee: string;
  managementFeeNonSst: string;
  managementFeeSst: string;
  companyFees: string;
  tenantExpenseCharges: string;
  tenantExpenseDirectCosts: string;
  tenantExpenseGrossMargin: string;
  tenantExpenseCostPendingCount: number;
  tenantExpenseActionRequiredCount: number;
  tenantExpenseActionItems: Array<{
    expenseId: string; apartmentId: string; propertyName: string; unitCode: string;
    description: string; chargeAmount: string; actualCost: string | null;
    costPaymentStatus: string; withSST: boolean;
  }>;
  passThrough: string;
  rental: { due: string; collected: string; outstanding: string };
  deposit: { due: string; collected: string; outstanding: string };
  tenantBreakdown: Array<{ key: string; label: string; due: string; collected: string; outstanding: string }>;
  ownerPayout: string;
  ownerPaid: string;
  status: "safe" | "attention" | "shortfall";
}

export async function getBillingFundsSummary(orgId: string, month: Date): Promise<BillingFundsSummary> {
  const db = getDb();
  const [tenantCharges, allocations, currentLedger, priorLedger, tenantExpenses] = await Promise.all([
    db.charge.findMany({
      where: { organizationId: orgId, billingMonth: month, tenancyId: { not: null }, status: { notIn: ["void", "credited"] } },
      select: { id: true, amount: true, outstandingAmount: true, chargeType: true, description: true, revenueRecognition: true, category: { select: { code: true, name: true } } },
    }),
    db.paymentAllocation.findMany({
      where: { organizationId: orgId, payment: { status: "posted" }, charge: { billingMonth: month, tenancyId: { not: null }, status: { notIn: ["void", "credited"] } } },
      select: { id: true, allocatedAmount: true, charge: { select: { chargeType: true, revenueRecognition: true } } },
    }),
    db.ownerLedgerEntry.findMany({
      where: { organizationId: orgId, statementMonth: month, status: "active" },
      select: { direction: true, category: true, amount: true, sstAmount: true, includeInPayout: true, taxCategory: true, reversalOfEntryId: true },
    }),
    db.ownerLedgerEntry.findMany({
      where: { organizationId: orgId, statementMonth: { lt: month }, status: "active" },
      select: { direction: true, category: true, amount: true, sstAmount: true, includeInPayout: true, taxCategory: true, reversalOfEntryId: true },
    }),
    db.gridExpense.findMany({
      where: { organizationId: orgId, periodMonth: month, bearer: "tenant", status: "active" },
      select: {
        id: true, apartmentId: true, description: true, amount: true, actualCost: true,
        costPaymentStatus: true, withSST: true,
        entry: { select: { apartment: { select: { unitCode: true, property: { select: { name: true } } } } } },
      },
    }),
  ]);
  const reversals = allocations.length ? await db.paymentAllocationReversal.findMany({
    where: { organizationId: orgId, originalAllocationId: { in: allocations.map((a) => a.id) } },
    select: { originalAllocationId: true, amount: true },
  }) : [];
  const reversed = new Map<string, number>();
  for (const row of reversals) reversed.set(row.originalAllocationId, (reversed.get(row.originalAllocationId) ?? 0) + Number(row.amount));

  const tenantDueC = tenantCharges.reduce((sum, row) => sum + Math.round(Number(row.amount) * 100), 0);
  const tenantOutstandingC = tenantCharges.reduce((sum, row) => sum + Math.max(0, Math.round(Number(row.outstandingAmount) * 100)), 0);
  const chargeTotals = (predicate: (row: (typeof tenantCharges)[number]) => boolean) => {
    let due = 0, outstanding = 0;
    for (const row of tenantCharges.filter(predicate)) {
      due += Math.round(Number(row.amount) * 100);
      outstanding += Math.max(0, Math.round(Number(row.outstandingAmount) * 100));
    }
    return { due, collected: Math.max(0, due - outstanding), outstanding };
  };
  const rentalTotals = chargeTotals((row) => row.chargeType === "rent");
  const depositTypes = new Set(["security_deposit", "utility_deposit"]);
  const depositTotals = chargeTotals((row) => depositTypes.has(row.chargeType));
  const breakdown = new Map<string, { label: string; due: number; outstanding: number }>();
  for (const row of tenantCharges) {
    const key = row.category?.code ?? row.chargeType;
    const label = row.category?.name ?? row.description ?? row.chargeType.replaceAll("_", " ");
    const current = breakdown.get(key) ?? { label, due: 0, outstanding: 0 };
    current.due += Math.round(Number(row.amount) * 100);
    current.outstanding += Math.max(0, Math.round(Number(row.outstandingAmount) * 100));
    breakdown.set(key, current);
  }
  // Legacy/UAT charges may pre-date economic-treatment metadata. Category-code fallback
  // applies the business rules confirmed for this screen instead of silently showing RM0.
  const companyFeeCategoryCodes = new Set([
    "cleaning_tenant", "cleaning_owner",
    "recurring_other_tenant", "recurring_other_owner",
    "other_expense_tenant", "other_expense_owner",
  ]);
  const isCompanyFee = (row: (typeof tenantCharges)[number]) =>
    row.revenueRecognition === "manager_revenue" || companyFeeCategoryCodes.has(row.category?.code ?? "");
  const tenantCompanyFeesC = tenantCharges
    .filter(isCompanyFee)
    .reduce((sum, row) => sum + Math.round(Number(row.amount) * 100), 0);
  const tenantPassThroughC = tenantCharges
    .filter((row) => !isCompanyFee(row) && !["security_deposit", "utility_deposit"].includes(row.chargeType))
    .reduce((sum, row) => sum + Math.round(Number(row.amount) * 100), 0);
  let tenantCollectedC = 0, depositsHeldC = 0;
  for (const row of allocations) {
    const netC = Math.max(0, Math.round((Number(row.allocatedAmount) - (reversed.get(row.id) ?? 0)) * 100));
    tenantCollectedC += netC;
    if (["security_deposit", "utility_deposit"].includes(row.charge.chargeType)) depositsHeldC += netC;
  }
  const toLines = (rows: typeof currentLedger) => rows.map((row) => ({ ...row, direction: row.direction as "income" | "expense" | "payout", amount: row.amount.toFixed(2), sstAmount: row.sstAmount?.toFixed(2) ?? null }));
  const period = summarizeOwnerPeriod(toLines(currentLedger));
  const openingC = Math.round(Number(computeOwnerRunningBalance(toLines(priorLedger))) * 100);
  const ownerPayableC = openingC + Math.round(Number(period.netPayoutToOwner) * 100);
  const ownerPaidC = Math.round(Number(period.payoutsTotal) * 100);
  const ownerPayoutC = ownerPayableC - ownerPaidC;
  const ledgerValueC = (row: (typeof currentLedger)[number]) => Math.round((Number(row.amount) + Number(row.sstAmount ?? 0)) * 100);
  const managementFeeC = currentLedger
    .filter((row) => row.direction === "expense" && row.category === "management_fee")
    .reduce((sum, row) => sum + ledgerValueC(row), 0);
  const managementFeeNonSstC = currentLedger
    .filter((row) => row.direction === "expense" && row.category === "management_fee")
    .reduce((sum, row) => sum + Math.round(Number(row.amount) * 100), 0);
  const managementFeeSstC = currentLedger
    .filter((row) => row.direction === "expense" && row.category === "management_fee")
    .reduce((sum, row) => sum + Math.round(Number(row.sstAmount ?? 0) * 100), 0);
  const ownerExpensesC = currentLedger
    .filter((row) => row.direction === "expense" && row.includeInPayout && row.category !== "management_fee")
    .reduce((sum, row) => sum + ledgerValueC(row), 0);
  const tenantExpenseChargesC = tenantExpenses.reduce((sum, row) => sum + Math.round(Number(row.amount) * 100), 0);
  const tenantExpenseDirectCostsC = tenantExpenses.reduce((sum, row) => sum + (row.actualCost == null ? 0 : Math.round(Number(row.actualCost) * 100)), 0);
  const tenantExpenseCostedChargesC = tenantExpenses.reduce((sum, row) => sum + (row.actualCost == null ? 0 : Math.round(Number(row.amount) * 100)), 0);
  const tenantExpenseCostPendingCount = tenantExpenses.filter((row) => row.actualCost == null).length;
  const tenantExpenseActionRequiredCount = tenantExpenses.filter((row) => row.actualCost == null || row.costPaymentStatus !== "paid").length;
  const tenantExpenseActionItems = tenantExpenses
    .filter((row) => row.actualCost == null || row.costPaymentStatus !== "paid")
    .map((row) => ({
      expenseId: row.id,
      apartmentId: row.apartmentId,
      propertyName: row.entry.apartment.property.name,
      unitCode: row.entry.apartment.unitCode,
      description: row.description,
      chargeAmount: row.amount.toFixed(2),
      actualCost: row.actualCost?.toFixed(2) ?? null,
      costPaymentStatus: row.costPaymentStatus,
      withSST: row.withSST,
    }));
  const status = ownerPayoutC < 0 ? "shortfall" : ownerPayableC > 0 && ownerPayoutC < Math.max(10000, Math.round(ownerPayableC * 0.1)) ? "attention" : "safe";
  const money = (cents: number) => (cents / 100).toFixed(2);
  return {
    tenantDue: money(tenantDueC), tenantOutstanding: money(tenantOutstandingC),
    tenantCollected: money(tenantCollectedC), depositsHeld: money(depositsHeldC),
    ownerExpenses: money(ownerExpensesC), managementFee: money(managementFeeC),
    managementFeeNonSst: money(managementFeeNonSstC), managementFeeSst: money(managementFeeSstC),
    companyFees: money(tenantCompanyFeesC + managementFeeNonSstC),
    tenantExpenseCharges: money(tenantExpenseChargesC),
    tenantExpenseDirectCosts: money(tenantExpenseDirectCostsC),
    tenantExpenseGrossMargin: money(tenantExpenseCostedChargesC - tenantExpenseDirectCostsC),
    tenantExpenseCostPendingCount,
    tenantExpenseActionRequiredCount,
    tenantExpenseActionItems,
    passThrough: money(tenantPassThroughC),
    rental: { due: money(rentalTotals.due), collected: money(rentalTotals.collected), outstanding: money(rentalTotals.outstanding) },
    deposit: { due: money(depositTotals.due), collected: money(depositTotals.collected), outstanding: money(depositTotals.outstanding) },
    tenantBreakdown: [...breakdown.entries()].map(([key, value]) => ({
      key, label: value.label, due: money(value.due),
      collected: money(Math.max(0, value.due - value.outstanding)), outstanding: money(value.outstanding),
    })).sort((a, b) => {
      const rank = (key: string) => {
        if (key === "rental") return 10;
        if (["security_deposit", "tenancy_rental_deposit"].includes(key)) return 20;
        if (["utility_deposit", "tenancy_utility_deposit", "carpark_deposit", "access_card_deposit"].includes(key)) return 21;
        if (["electricity_tenant", "water_tenant", "wifi_tenant", "sewerage_tenant", "utility_tnb", "utility_water", "utility_wifi", "utility_indah_water"].includes(key)) return 30;
        if (key.includes("cleaning")) return 40;
        if (key.includes("recurring")) return 50;
        return 60;
      };
      return rank(a.key) - rank(b.key) || a.label.localeCompare(b.label);
    }),
    ownerPayout: money(ownerPayoutC), ownerPaid: money(ownerPaidC), status,
  };
}
