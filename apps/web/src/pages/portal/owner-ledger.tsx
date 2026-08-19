import { useState, Fragment } from "react";
import { ArrowLeftRight, TrendingUp, TrendingDown, Wallet, ArrowDownCircle, Download, FileSpreadsheet, Paperclip } from "lucide-react";
import ExcelJS from "exceljs";
import { isInformationalLedgerRow } from "@kason/shared";
import { useOwnerLedger, type OwnerLedgerRowDto } from "@/api/portal-owner-ledger";
import { formatRM, formatDate } from "@/components/format";
import { GlowCard } from "@/components/ui/glow-card";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Callout } from "@/components/ui/callout";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { toCsv, downloadCsv } from "@/lib/csv-export";
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

/** Map a payment-status string to a Badge variant (slate → secondary fallback). */
function statusBadgeVariant(
  status: string,
): "emerald" | "amber" | "rose" | "sky" | "secondary" {
  const v = status.toLowerCase();
  if (["paid", "active", "success"].includes(v)) return "emerald";
  if (["pending", "partial", "draft", "processing"].includes(v)) return "amber";
  if (["void", "voided", "failed", "rejected"].includes(v)) return "rose";
  if (["approved", "open"].includes(v)) return "sky";
  return "secondary";
}

// ─── Per-unit grouping ────────────────────────────────────────────────────────

/** Internal key used for null-unitCode rows so they sort last consistently. */
const PROPERTY_LEVEL_KEY = "__property_level__";

type UnitGroup = {
  /** null → property-level (management fees, owner-paid items, etc.) */
  unitCode: string | null;
  rows: OwnerLedgerRowDto[];
  incomeTotal: number;
  expenseTotal: number;
};

/**
 * Groups ledger rows by `unitCode`, preserving the API order within each group.
 * Named units are sorted alphabetically; the null catch-all always comes last.
 *
 * Returns a FLAT array when all rows share the same key (single-unit owner
 * experience is preserved — caller skips group headers in this case).
 */
function groupRowsByUnit(rows: OwnerLedgerRowDto[]): UnitGroup[] {
  const map = new Map<string, UnitGroup>();

  for (const row of rows) {
    const key = row.unitCode ?? PROPERTY_LEVEL_KEY;
    if (!map.has(key)) {
      map.set(key, { unitCode: row.unitCode ?? null, rows: [], incomeTotal: 0, expenseTotal: 0 });
    }
    const group = map.get(key)!;
    group.rows.push(row);
    if (row.direction === "income") {
      group.incomeTotal += parseFloat(row.amount) || 0;
    } else if (row.direction === "expense") {
      group.expenseTotal += parseFloat(row.amount) || 0;
    }
  }

  // Sort: named units first (alphabetical), property-level last.
  return [...map.values()].sort((a, b) => {
    if (a.unitCode === null && b.unitCode !== null) return 1;
    if (a.unitCode !== null && b.unitCode === null) return -1;
    if (a.unitCode === null && b.unitCode === null) return 0;
    return a.unitCode!.localeCompare(b.unitCode!);
  });
}

// ─── CSV + Excel export ────────────────────────────────────────────────────────

const CSV_COLUMNS = [
  { key: "transactionDate" as keyof OwnerLedgerRowDto, label: "Date" },
  { key: "description" as keyof OwnerLedgerRowDto, label: "Description" },
  { key: "category" as keyof OwnerLedgerRowDto, label: "Category" },
  { key: "direction" as keyof OwnerLedgerRowDto, label: "Direction" },
  { key: "amount" as keyof OwnerLedgerRowDto, label: "Amount (RM)" },
  { key: "paidBy" as keyof OwnerLedgerRowDto, label: "Paid By" },
  { key: "paymentStatus" as keyof OwnerLedgerRowDto, label: "Payment Status" },
  { key: "remarks" as keyof OwnerLedgerRowDto, label: "Remarks" },
];

function exportCsv(rows: OwnerLedgerRowDto[], from: string, to: string) {
  const enriched = rows.map((r) => ({
    ...r,
    description: r.description ?? "",
    remarks: r.remarks ?? "",
  }));
  const csv = toCsv(enriched, CSV_COLUMNS);
  downloadCsv(`owner-ledger-${from}_${to}.csv`, csv);
}

async function exportExcel(rows: OwnerLedgerRowDto[], from: string, to: string) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Owner Ledger");

  ws.columns = [
    { header: "Date", key: "transactionDate", width: 14 },
    { header: "Description", key: "description", width: 36 },
    { header: "Category", key: "category", width: 20 },
    { header: "Direction", key: "direction", width: 12 },
    { header: "Income (RM)", key: "income", width: 14 },
    { header: "Expense (RM)", key: "expense", width: 14 },
    { header: "Paid By", key: "paidBy", width: 16 },
    { header: "Payment Status", key: "paymentStatus", width: 18 },
    { header: "Remarks", key: "remarks", width: 30 },
    { header: "Attachments", key: "attachments", width: 12 },
  ];

  // Bold header row
  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true };
  headerRow.commit();

  rows.forEach((r) => {
    ws.addRow({
      transactionDate: formatDate(r.transactionDate),
      description: r.description ?? "",
      category: r.category,
      direction: r.direction,
      income: r.direction === "income" ? parseFloat(r.amount) : null,
      expense: r.direction === "expense" ? parseFloat(r.amount) : null,
      paidBy: r.paidBy,
      paymentStatus: r.paymentStatus,
      remarks: r.remarks ?? "",
      attachments: r.attachmentKeys.length > 0 ? r.attachmentKeys.length : "",
    });
  });

  const out = await wb.xlsx.writeBuffer();
  const blob = new Blob([out], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `owner-ledger-${from}_${to}.xlsx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function PortalOwnerLedgerPage() {
  const [fromMonth, setFromMonth] = useState(defaultFromMonth);
  const [toMonth, setToMonth] = useState(currentYearMonth);

  const { data, isLoading } = useOwnerLedger(fromMonth, toMonth);

  const rows = data?.data?.rows ?? [];
  const summary = data?.data?.summary;

  return (
    <div className="space-y-6 animate-fade-in-up">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl md:text-4xl font-bold text-foreground flex items-center gap-3">
            <ArrowLeftRight className="h-8 w-8 text-primary" />
            Transactions
          </h1>
          <p className="text-muted-foreground mt-1">Full transaction record — income, expenses, and payout summary</p>
        </div>
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
        </div>
      </div>

      {isLoading && <LedgerSkeleton />}

      {summary && (
        <>
          {/* Summary GlowCards */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <GlowCard glowColor="green" className="p-6 bg-background/40 backdrop-blur-xl border border-border/50">
              <div className="flex items-start justify-between">
                <div className="space-y-2">
                  <p className="text-sm font-medium text-muted-foreground">Gross Rental</p>
                  <p className="text-3xl font-bold text-emerald-500">{formatRM(toNum(summary.grossRental))}</p>
                  <div className="flex items-center gap-1 text-xs text-green-600">
                    <TrendingUp className="h-3 w-3" />
                    <span>Total rent collected</span>
                  </div>
                </div>
                <div className="p-3 rounded-xl bg-green-500/10">
                  <TrendingUp className="h-6 w-6 text-green-600" />
                </div>
              </div>
            </GlowCard>

            <GlowCard glowColor="orange" className="p-6 bg-background/40 backdrop-blur-xl border border-border/50">
              <div className="flex items-start justify-between">
                <div className="space-y-2">
                  <p className="text-sm font-medium text-muted-foreground">Total Expenses</p>
                  <p className="text-3xl font-bold text-orange-500">{formatRM(toNum(summary.totalExpenses))}</p>
                  <div className="flex items-center gap-1 text-xs text-orange-600">
                    <TrendingDown className="h-3 w-3" />
                    <span>Fees + deductions</span>
                  </div>
                </div>
                <div className="p-3 rounded-xl bg-orange-500/10">
                  <TrendingDown className="h-6 w-6 text-orange-600" />
                </div>
              </div>
            </GlowCard>

            <GlowCard glowColor="blue" className="p-6 bg-background/40 backdrop-blur-xl border border-border/50">
              <div className="flex items-start justify-between">
                <div className="space-y-2">
                  <p className="text-sm font-medium text-muted-foreground">Net Rental After Expenses</p>
                  <p className="text-3xl font-bold text-foreground">{formatRM(toNum(summary.netRentalAfterExpenses))}</p>
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Wallet className="h-3 w-3" />
                    <span>Gross minus all expenses</span>
                  </div>
                </div>
                <div className="p-3 rounded-xl bg-blue-500/10">
                  <Wallet className="h-6 w-6 text-blue-600" />
                </div>
              </div>
            </GlowCard>

            <GlowCard glowColor="gold" className="p-6 bg-background/40 backdrop-blur-xl border border-border/50">
              <div className="flex items-start justify-between">
                <div className="space-y-2">
                  <p className="text-sm font-medium text-muted-foreground">Net Payout to Owner</p>
                  <p className="text-3xl font-bold text-amber-500">{formatRM(toNum(summary.netPayoutToOwner))}</p>
                  <div className="flex items-center gap-1 text-xs text-amber-600">
                    <ArrowDownCircle className="h-3 w-3" />
                    <span>Remitted to you</span>
                  </div>
                </div>
                <div className="p-3 rounded-xl bg-amber-500/10">
                  <ArrowDownCircle className="h-6 w-6 text-amber-600" />
                </div>
              </div>
            </GlowCard>
          </div>

          {/* Explanation callout */}
          <Callout variant="info" title="About these totals">
            <strong>Net Rental After Expenses</strong> deducts all expenses (incl. owner-paid items) from gross rental.
            <strong> Net Payout to Owner</strong> may differ — it excludes expenses you paid directly and reflects the actual remittance from KAEN.
          </Callout>

          {/* By-category breakdown (if present) */}
          {summary.byCategory && Object.keys(summary.byCategory).length > 0 && (
            <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
              <CardHeader className="pb-3">
                <CardTitle className="text-base font-semibold">Expense Breakdown by Category</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                  {Object.entries(summary.byCategory).map(([cat, amt]) => (
                    <div key={cat} className="rounded-lg border border-border/50 bg-background/40 px-3 py-2">
                      <p className="text-xs text-muted-foreground capitalize">{cat.replace(/_/g, " ")}</p>
                      <p className="text-sm font-semibold text-foreground">{formatRM(toNum(amt))}</p>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}

      {/* Statement transaction table */}
      <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
        <CardHeader className="pb-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="text-xl font-bold flex items-center gap-2">
              <ArrowLeftRight className="h-5 w-5 text-primary" />
              Transactions
              {rows.length > 0 && (
                <Badge variant="secondary" className="ml-2 text-xs">
                  {rows.length} rows
                </Badge>
              )}
            </CardTitle>
            {rows.length > 0 && (
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => exportCsv(rows, fromMonth, toMonth)}
                  className="flex items-center gap-1.5"
                  aria-label="Export CSV"
                >
                  <Download className="h-3.5 w-3.5" />
                  Export CSV
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => exportExcel(rows, fromMonth, toMonth)}
                  className="flex items-center gap-1.5"
                  aria-label="Export Excel"
                >
                  <FileSpreadsheet className="h-3.5 w-3.5" />
                  Export Excel
                </Button>
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? null : rows.length === 0 ? (
            <EmptyState
              icon={ArrowLeftRight}
              title="No transactions in this period"
              description="Adjust the date range to see your financial activity."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-muted-foreground border-b border-border/50">
                    <th className="py-2 pr-3 text-left font-medium whitespace-nowrap">Date</th>
                    <th className="py-2 pr-3 text-left font-medium">Description</th>
                    <th className="py-2 pr-3 text-left font-medium">Category</th>
                    <th className="py-2 pr-3 text-left font-medium whitespace-nowrap">Unit</th>
                    <th className="py-2 pr-3 text-right font-medium whitespace-nowrap">Income</th>
                    <th className="py-2 pr-3 text-right font-medium whitespace-nowrap">Expense</th>
                    <th className="py-2 pr-3 text-left font-medium whitespace-nowrap">Paid By</th>
                    <th className="py-2 pr-3 text-left font-medium whitespace-nowrap">Status</th>
                    <th className="py-2 pr-3 text-left font-medium">Remarks</th>
                    <th className="py-2 text-center font-medium w-8" aria-label="Attachments"></th>
                  </tr>
                </thead>
                <tbody>
                  <LedgerTableBody rows={rows} />
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Ledger table body: flat or per-unit grouped ──────────────────────────────

/**
 * Renders ledger rows as a flat list when all rows share the same unitCode
 * (single-unit owner experience is unchanged), or as per-unit sections with
 * a labelled group header and an income/expense subtotal row when multiple
 * distinct unitCodes are present.
 */
function LedgerTableBody({ rows }: { rows: OwnerLedgerRowDto[] }) {
  const groups = groupRowsByUnit(rows);
  const isGrouped = groups.length > 1;

  if (!isGrouped) {
    // Flat rendering — same as before grouping was introduced.
    return <>{groups.flatMap((g) => g.rows).map((row) => <LedgerRow key={row.id} row={row} />)}</>;
  }

  return (
    <>
      {groups.map((group) => {
        const key = group.unitCode ?? PROPERTY_LEVEL_KEY;
        const label = group.unitCode ?? "Property-level";
        return (
          <Fragment key={key}>
            {/* ── Group section header ── */}
            <tr className="bg-muted/20">
              <td
                colSpan={10}
                className="pt-4 pb-1.5 pr-3"
              >
                <div className="flex items-center gap-2">
                  <span
                    data-testid="unit-group-header"
                    className="text-xs font-bold uppercase tracking-widest text-foreground"
                  >
                    {label}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {group.rows.length} row{group.rows.length !== 1 ? "s" : ""}
                  </span>
                </div>
              </td>
            </tr>

            {/* ── Data rows ── */}
            {group.rows.map((row) => <LedgerRow key={row.id} row={row} />)}

            {/* ── Subtotal row ── */}
            <tr className="border-t border-border/50 bg-muted/10">
              <td colSpan={4} className="py-1.5 pr-3 text-xs text-muted-foreground italic">
                Subtotal — {label}
              </td>
              <td className="py-1.5 pr-3 text-right text-xs font-semibold text-emerald-600 tabular-nums">
                {group.incomeTotal > 0 ? formatRM(group.incomeTotal) : "—"}
              </td>
              <td className="py-1.5 pr-3 text-right text-xs font-semibold text-rose-600 tabular-nums">
                {group.expenseTotal > 0 ? formatRM(group.expenseTotal) : "—"}
              </td>
              <td colSpan={4} />
            </tr>
          </Fragment>
        );
      })}
    </>
  );
}

/** Single ledger data row — extracted to keep LedgerTableBody readable. */
function LedgerRow({ row }: { row: OwnerLedgerRowDto }) {
  return (
    <tr className="border-t border-border/50 hover:bg-muted/30 transition-colors">
      <td className="py-2.5 pr-3 text-foreground whitespace-nowrap">{formatDate(row.transactionDate)}</td>
      <td className="py-2.5 pr-3 text-foreground max-w-[200px]">
        {/* Informational rows are neither income nor expense, so BOTH money columns
            stay "—" and the figure rides here with its explanation. Rendering it under
            the Income header would imply the owner received it — they did not. */}
        <span
          className="block truncate"
          title={
            isInformationalLedgerRow(row)
              ? `${formatRM(toNum(row.amount))} — ${row.description ?? ""}`
              : (row.description ?? undefined)
          }
        >
          {isInformationalLedgerRow(row) ? (
            <>
              <span className="tabular-nums text-muted-foreground">{formatRM(toNum(row.amount))}</span>
              {row.description ? <span className="text-muted-foreground"> — {row.description}</span> : null}
            </>
          ) : (
            (row.description ?? "—")
          )}
        </span>
      </td>
      <td className="py-2.5 pr-3">
        <span className="text-muted-foreground capitalize">
          {row.category.replace(/_/g, " ")}
        </span>
      </td>
      <td className="py-2.5 pr-3 whitespace-nowrap">
        {row.unitCode ? (
          <Badge variant="secondary" className="text-xs">{row.unitCode}</Badge>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className="py-2.5 pr-3 text-right font-medium text-emerald-600">
        {row.direction === "income" ? formatRM(toNum(row.amount)) : "—"}
      </td>
      <td className="py-2.5 pr-3 text-right font-medium text-rose-600">
        {row.direction === "expense" ? formatRM(toNum(row.amount)) : "—"}
      </td>
      <td className="py-2.5 pr-3 whitespace-nowrap">
        <PaidByBadge paidBy={row.paidBy} />
      </td>
      <td className="py-2.5 pr-3">
        <Badge variant={statusBadgeVariant(row.paymentStatus)}>{row.paymentStatus}</Badge>
      </td>
      <td className="py-2.5 pr-3 text-muted-foreground max-w-[180px]">
        <span className="block truncate" title={row.remarks ?? undefined}>
          {row.remarks ?? "—"}
        </span>
      </td>
      <td className="py-2.5 text-center">
        {row.attachmentKeys.length > 0 && (
          <span
            title={`${row.attachmentKeys.length} attachment${row.attachmentKeys.length === 1 ? "" : "s"}`}
            aria-label={`${row.attachmentKeys.length} attachment${row.attachmentKeys.length === 1 ? "" : "s"}`}
          >
            <Paperclip className="h-3.5 w-3.5 text-muted-foreground inline" />
          </span>
        )}
      </td>
    </tr>
  );
}

function LedgerSkeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-32 bg-muted rounded-2xl" />
        ))}
      </div>
      <div className="h-64 bg-muted rounded-xl" />
    </div>
  );
}
