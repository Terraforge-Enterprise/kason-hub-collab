import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Receipt,
  TrendingDown,
  TrendingUp,
  FileSpreadsheet,
  CircleDollarSign,
  Banknote,
  Info,
} from "lucide-react";
import ExcelJS from "exceljs";
import { useOwnerLedger, type OwnerLedgerRowDto, type OwnerLedgerSummary } from "@/api/portal-owner-ledger";
import { useOwnerTaxSummary } from "@/api/portal-owner-ledger";
import { portalApiFetch } from "@/lib/portal-api";
import type { PortalOwnerDashboardResponse } from "@kason/shared";
import { formatRM } from "@/components/format";
import { GlowCard } from "@/components/ui/glow-card";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Callout } from "@/components/ui/callout";
import { Button } from "@/components/ui/button";
import { PaidByBadge } from "@/components/paid-by-badge";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function currentYearMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function defaultFromMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-01`;
}

/** Parse a decimal string from the API and coerce to number for formatRM. */
function toNum(s: string | null | undefined): number {
  if (!s) return 0;
  return parseFloat(s) || 0;
}

/**
 * Humanise an enum key:
 *   "rental_expense" → "Rental Expense"
 *   "CAPITAL_ALLOWANCE" → "Capital Allowance"
 */
function humaniseKey(key: string): string {
  return key
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ─── Types ────────────────────────────────────────────────────────────────────

/** Per-category aggregation derived from ledger rows (expense direction only). */
type CategoryGroup = {
  category: string;
  /** Total amount for this category across all rows (decimal string). */
  totalAmount: number;
  /** Tax category enum value from the rows. */
  taxCategory: string;
  /** True when ALL rows in this category are owner-paid. */
  ownerPaid: boolean;
};

// ─── Derived helpers ──────────────────────────────────────────────────────────

/**
 * Group expense rows by category; mark each group owner-paid when ALL
 * contributing rows have paidBy === "owner".
 */
function groupExpensesByCategory(rows: OwnerLedgerRowDto[]): CategoryGroup[] {
  const expenseRows = rows.filter((r) => r.direction === "expense");

  type Acc = Record<
    string,
    { totalAmount: number; taxCategory: string; allOwner: boolean }
  >;

  const acc = expenseRows.reduce<Acc>((map, row) => {
    const cat = row.category;
    if (!map[cat]) {
      map[cat] = {
        totalAmount: 0,
        taxCategory: row.taxCategory,
        allOwner: true,
      };
    }
    map[cat].totalAmount += parseFloat(row.amount) || 0;
    if (row.paidBy.toLowerCase() !== "owner") {
      map[cat].allOwner = false;
    }
    return map;
  }, {});

  return Object.entries(acc).map(([category, v]) => ({
    category,
    totalAmount: v.totalAmount,
    taxCategory: v.taxCategory,
    ownerPaid: v.allOwner,
  }));
}

// ─── Excel export ─────────────────────────────────────────────────────────────

async function exportExcel(
  rows: OwnerLedgerRowDto[],
  summary: OwnerLedgerSummary,
  categoryGroups: CategoryGroup[],
  disclaimer: string,
  fromMonth: string,
  toMonth: string,
) {
  const wb = new ExcelJS.Workbook();

  // Sheet 1: Income & Expenses by Category
  const wsMain = wb.addWorksheet("Income & Expenses");
  wsMain.columns = [
    { header: "Category", key: "category", width: 28 },
    { header: "Tax Category", key: "taxCategory", width: 26 },
    { header: "Paid By", key: "paidBy", width: 14 },
    { header: "Amount (RM)", key: "amount", width: 16 },
  ];
  const mainHeader = wsMain.getRow(1);
  mainHeader.font = { bold: true };
  mainHeader.commit();

  // Gross Rental row
  wsMain.addRow({
    category: "Gross Rental Income",
    taxCategory: "Income",
    paidBy: "–",
    amount: parseFloat(summary.grossRental) || 0,
  });
  wsMain.addRow({});

  // Expense rows by category
  categoryGroups.forEach((g) => {
    wsMain.addRow({
      category: humaniseKey(g.category),
      taxCategory: humaniseKey(g.taxCategory),
      paidBy: g.ownerPaid ? "Paid by you" : "Paid by KAEN",
      amount: g.totalAmount,
    });
  });

  wsMain.addRow({});
  const netRentalRow = wsMain.addRow({
    category: "Net Rental After Expenses",
    taxCategory: "",
    paidBy: "",
    amount: parseFloat(summary.netRentalAfterExpenses) || 0,
  });
  netRentalRow.font = { bold: true };
  netRentalRow.commit();

  const netPayoutRow = wsMain.addRow({
    category: "Net Payout to Owner",
    taxCategory: "",
    paidBy: "",
    amount: parseFloat(summary.netPayoutToOwner) || 0,
  });
  netPayoutRow.font = { bold: true };
  netPayoutRow.commit();

  // Sheet 2: Full Transaction Log
  const wsLog = wb.addWorksheet("All Transactions");
  wsLog.columns = [
    { header: "Date", key: "transactionDate", width: 14 },
    { header: "Direction", key: "direction", width: 12 },
    { header: "Category", key: "category", width: 22 },
    { header: "Tax Category", key: "taxCategory", width: 22 },
    { header: "Description", key: "description", width: 36 },
    { header: "Amount (RM)", key: "amount", width: 14 },
    { header: "Paid By", key: "paidBy", width: 14 },
    { header: "Payment Status", key: "paymentStatus", width: 18 },
  ];
  const logHeader = wsLog.getRow(1);
  logHeader.font = { bold: true };
  logHeader.commit();

  rows.forEach((r) => {
    wsLog.addRow({
      transactionDate: r.transactionDate,
      direction: r.direction,
      category: humaniseKey(r.category),
      taxCategory: humaniseKey(r.taxCategory),
      description: r.description ?? "",
      amount: parseFloat(r.amount) || 0,
      paidBy: r.paidBy,
      paymentStatus: r.paymentStatus,
    });
  });

  // Sheet 3: Disclaimer
  const wsDisc = wb.addWorksheet("Disclaimer");
  wsDisc.addRow([disclaimer]);

  const out = await wb.xlsx.writeBuffer();
  const blob = new Blob([out], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `income-tax-${fromMonth}_${toMonth}.xlsx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ─── Property filter (hidden when ≤ 1 property in the ledger rows) ────────────

function PropertyFilter({
  rows,
  propertyId,
  onSelect,
  nameMap = {},
}: {
  rows: OwnerLedgerRowDto[];
  propertyId: string | undefined;
  onSelect: (id: string | undefined) => void;
  nameMap?: Record<string, string>;
}) {
  const ids = [...new Set(rows.map((r) => r.propertyId))];
  if (ids.length <= 1) return null;

  return (
    <div className="flex items-center gap-2">
      <label
        htmlFor="it-property-filter"
        className="text-sm text-muted-foreground shrink-0"
      >
        Property:
      </label>
      <select
        id="it-property-filter"
        value={propertyId ?? ""}
        onChange={(e) => onSelect(e.target.value || undefined)}
        className="rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-ring"
      >
        <option value="">All properties</option>
        {ids.map((id) => (
          <option key={id} value={id}>
            {nameMap[id] ?? id}
          </option>
        ))}
      </select>
    </div>
  );
}

// ─── Loading skeleton ─────────────────────────────────────────────────────────

function IncomeTaxSkeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-32 bg-muted rounded-2xl" />
        ))}
      </div>
      <div className="h-20 bg-muted rounded-xl" />
      <div className="h-64 bg-muted rounded-xl" />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="h-32 bg-muted rounded-2xl" />
        <div className="h-32 bg-muted rounded-2xl" />
      </div>
    </div>
  );
}

// ─── Expenses-by-category table ───────────────────────────────────────────────

function ExpensesByCategoryTable({ groups }: { groups: CategoryGroup[] }) {
  if (groups.length === 0) return null;

  return (
    <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
      <CardHeader className="pb-3">
        <CardTitle className="text-xl font-bold flex items-center gap-2">
          <TrendingDown className="h-5 w-5 text-primary" />
          Expenses by Category
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="rounded-lg border border-border overflow-x-auto">
          <table
            className="w-full text-sm"
            aria-label="Expenses by category"
          >
            <thead className="bg-muted/30 border-b border-border/50">
              <tr>
                <th className="px-4 py-3 text-left text-[10px] uppercase tracking-widest text-muted-foreground font-medium">
                  Category
                </th>
                <th className="px-4 py-3 text-left text-[10px] uppercase tracking-widest text-muted-foreground font-medium">
                  Tax Class
                </th>
                <th className="px-4 py-3 text-left text-[10px] uppercase tracking-widest text-muted-foreground font-medium">
                  Paid By
                </th>
                <th className="px-4 py-3 text-right text-[10px] uppercase tracking-widest text-muted-foreground font-medium">
                  Amount
                </th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <tr
                  key={g.category}
                  className="border-t border-border/50 transition hover:bg-muted/30"
                >
                  <td className="px-4 py-3.5 text-foreground font-medium">
                    {humaniseKey(g.category)}
                  </td>
                  <td className="px-4 py-3.5">
                    <Badge variant="secondary" className="text-xs whitespace-nowrap">
                      {humaniseKey(g.taxCategory)}
                    </Badge>
                  </td>
                  <td className="px-4 py-3.5">
                    {g.ownerPaid && <PaidByBadge paidBy="owner" />}
                  </td>
                  <td className="px-4 py-3.5 text-right font-semibold text-foreground">
                    {formatRM(g.totalAmount)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Net figures side-by-side ─────────────────────────────────────────────────

function NetFiguresRow({ summary }: { summary: OwnerLedgerSummary }) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Net Rental After Expenses */}
        <GlowCard
          glowColor="green"
          className="p-6 bg-background/40 backdrop-blur-xl border border-border/50"
        >
          <div className="flex items-start justify-between">
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">
                Net Rental After Expenses
              </p>
              <p className="text-3xl font-bold text-emerald-500">
                {formatRM(toNum(summary.netRentalAfterExpenses))}
              </p>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <Receipt className="h-3 w-3" />
                <span>For your tax agent</span>
              </div>
            </div>
            <div className="p-3 rounded-xl bg-green-500/10">
              <Receipt className="h-6 w-6 text-green-600" />
            </div>
          </div>
        </GlowCard>

        {/* Net Payout to Owner */}
        <GlowCard
          glowColor="gold"
          className="p-6 bg-background/40 backdrop-blur-xl border border-border/50"
        >
          <div className="flex items-start justify-between">
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">
                Net Payout to Owner
              </p>
              <p className="text-3xl font-bold text-amber-500">
                {formatRM(toNum(summary.netPayoutToOwner))}
              </p>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <Banknote className="h-3 w-3" />
                <span>What KAEN transfers to you</span>
              </div>
            </div>
            <div className="p-3 rounded-xl bg-amber-500/10">
              <Banknote className="h-6 w-6 text-amber-600" />
            </div>
          </div>
        </GlowCard>
      </div>

      {/* Explanation note */}
      <Callout variant="info" icon={Info}>
        These two figures differ because owner-paid expenses (flagged "Paid by you" above)
        are included in the tax record but not deducted from your KAEN payout.
      </Callout>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function PortalOwnerTaxSummaryPage() {
  const [fromMonth, setFromMonth] = useState(defaultFromMonth);
  const [toMonth, setToMonth] = useState(currentYearMonth);
  const [propertyId, setPropertyId] = useState<string | undefined>(undefined);

  // Dashboard data — used only to build the property id→name map for the filter.
  // Shares the same cache entry as owner-dashboard.tsx.
  const dashboardQuery = useQuery({
    queryKey: ["portal-owner-dashboard"],
    queryFn: () => portalApiFetch<{ data: PortalOwnerDashboardResponse }>("/dashboard"),
  });
  const propertyNameMap = Object.fromEntries(
    (dashboardQuery.data?.data?.properties ?? []).map((p) => [p.id, p.name]),
  );

  const ledgerQuery = useOwnerLedger(fromMonth, toMonth, propertyId);
  const taxQuery = useOwnerTaxSummary(fromMonth, toMonth, propertyId);

  const ledger = ledgerQuery.data?.data;
  const tax = taxQuery.data?.data;

  const isLoading = ledgerQuery.isLoading || taxQuery.isLoading;

  // Derive expense groups from ledger rows.
  const expenseGroups = ledger ? groupExpensesByCategory(ledger.rows) : [];

  // All rows for property-filter detection and export.
  const allRows = ledger?.rows ?? [];

  return (
    <div className="space-y-6 animate-fade-in-up">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl md:text-4xl font-bold text-foreground flex items-center gap-3">
            <Receipt className="h-8 w-8 text-primary" />
            Income &amp; Tax
          </h1>
          <p className="text-muted-foreground mt-1">
            Full record of rental income and expenses — everything your tax agent needs
          </p>
        </div>

        {/* Controls: date range + property filter + export */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2">
            <label className="text-xs text-muted-foreground whitespace-nowrap">From</label>
            <input
              type="month"
              value={fromMonth}
              onChange={(e) => setFromMonth(e.target.value)}
              aria-label="From month"
              className="rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-ring"
            />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-muted-foreground whitespace-nowrap">To</label>
            <input
              type="month"
              value={toMonth}
              onChange={(e) => setToMonth(e.target.value)}
              aria-label="To month"
              className="rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-ring"
            />
          </div>

          {allRows.length > 0 && (
            <PropertyFilter
              rows={allRows}
              propertyId={propertyId}
              onSelect={setPropertyId}
              nameMap={propertyNameMap}
            />
          )}

          {ledger && tax && (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                exportExcel(
                  allRows,
                  ledger.summary,
                  expenseGroups,
                  tax.disclaimer,
                  fromMonth,
                  toMonth,
                )
              }
              className="flex items-center gap-1.5"
              aria-label="Export Excel"
            >
              <FileSpreadsheet className="h-3.5 w-3.5" />
              Export Excel
            </Button>
          )}
        </div>
      </div>

      {isLoading && <IncomeTaxSkeleton />}

      {ledger && tax && (
        <>
          {/* ── Row 1: KPI cards ── */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {/* Gross Rental */}
            <GlowCard
              glowColor="green"
              className="p-6 bg-background/40 backdrop-blur-xl border border-border/50"
            >
              <div className="flex items-start justify-between">
                <div className="space-y-2">
                  <p className="text-sm font-medium text-muted-foreground">Gross Rental</p>
                  <p className="text-3xl font-bold text-emerald-500">
                    {formatRM(toNum(ledger.summary.grossRental))}
                  </p>
                  <div className="flex items-center gap-1 text-xs text-green-600">
                    <CircleDollarSign className="h-3 w-3" />
                    <span>Total rent collected</span>
                  </div>
                </div>
                <div className="p-3 rounded-xl bg-green-500/10">
                  <CircleDollarSign className="h-6 w-6 text-green-600" />
                </div>
              </div>
            </GlowCard>

            {/* Total Expenses */}
            <GlowCard
              glowColor="orange"
              className="p-6 bg-background/40 backdrop-blur-xl border border-border/50"
            >
              <div className="flex items-start justify-between">
                <div className="space-y-2">
                  <p className="text-sm font-medium text-muted-foreground">Total Expenses</p>
                  <p className="text-3xl font-bold text-orange-500">
                    {formatRM(toNum(ledger.summary.totalExpenses))}
                  </p>
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <TrendingDown className="h-3 w-3" />
                    <span>All expense categories</span>
                  </div>
                </div>
                <div className="p-3 rounded-xl bg-orange-500/10">
                  <TrendingDown className="h-6 w-6 text-orange-600" />
                </div>
              </div>
            </GlowCard>

            {/* Net Rental (summary) */}
            <GlowCard
              glowColor="purple"
              className="p-6 bg-background/40 backdrop-blur-xl border border-border/50"
            >
              <div className="flex items-start justify-between">
                <div className="space-y-2">
                  <p className="text-sm font-medium text-muted-foreground">Net Rental</p>
                  <p className="text-3xl font-bold text-purple-500">
                    {formatRM(toNum(ledger.summary.netRentalAfterExpenses))}
                  </p>
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <TrendingUp className="h-3 w-3" />
                    <span>After all expenses</span>
                  </div>
                </div>
                <div className="p-3 rounded-xl bg-purple-500/10">
                  <TrendingUp className="h-6 w-6 text-purple-600" />
                </div>
              </div>
            </GlowCard>
          </div>

          {/* ── Tax disclaimer ── */}
          <Callout variant="warning" title="Tax Disclaimer">
            {tax.disclaimer}
          </Callout>

          {/* ── Expenses by category table ── */}
          <ExpensesByCategoryTable groups={expenseGroups} />

          {/* ── Both net figures side-by-side ── */}
          <NetFiguresRow summary={ledger.summary} />
        </>
      )}

      {!isLoading && (!ledger || !tax) && (
        <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
          <CardContent className="py-12 text-center">
            <Receipt className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
            <p className="text-muted-foreground">
              No income or expense data found for this period.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
