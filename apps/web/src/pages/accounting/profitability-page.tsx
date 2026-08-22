import { Fragment, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import ExcelJS from "exceljs";
import { ChevronDown, ChevronRight, Download, TrendingUp, AlertTriangle } from "lucide-react";
import { getProfitability, type ProfitRow } from "@/api/profitability";
import { PageHeader, Surface } from "@/components/ui";
import { Button } from "@/components/ui/button";

const rm = (value: string | number | null) => value == null ? "Pending cost" : `RM ${Number(value).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const currentMonth = new Date().toISOString().slice(0, 7);
const tone = (value: string | number) => Number(value) < 0 ? "text-red-700" : "text-[var(--navy-text)]";

function saveBlob(blob: Blob, name: string) { const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url); }
async function exportExcel(view: string, month: string, rows: ProfitRow[]) {
  const wb = new ExcelJS.Workbook(); wb.creator = "KAEN PROPERTIES MANAGEMENT SDN BHD";
  const summary = wb.addWorksheet("Summary");
  summary.columns = [
    { header: view === "owner" ? "Owner" : "Tenant", key: "name", width: 28 }, { header: "Units / Tenancies", key: "units", width: 42 },
    { header: "Charges Before SST", key: "charges", width: 20 }, { header: "Actual Cost", key: "cost", width: 18 }, { header: "Gross Profit", key: "profit", width: 18 },
    { header: "Collected Profit", key: "collected", width: 20 }, { header: "Outstanding Profit", key: "outstanding", width: 22 }, { header: "Missing Cost", key: "missing", width: 16 },
  ];
  rows.forEach((r) => summary.addRow({ name: r.partyName, units: r.units.join("; "), charges: Number(r.chargesBeforeSst), cost: Number(r.actualCost), profit: Number(r.grossProfit), collected: Number(r.collectedProfit), outstanding: Number(r.outstandingProfit), missing: r.missingCostCount }));
  const detail = wb.addWorksheet("Details");
  detail.columns = [
    { header: view === "owner" ? "Owner" : "Tenant", key: "name", width: 28 }, { header: "Month", key: "month", width: 12 }, { header: "Property", key: "property", width: 28 }, { header: "Unit", key: "unit", width: 16 },
    { header: "Category", key: "category", width: 24 }, { header: "Description", key: "description", width: 42 }, { header: "Charge", key: "charge", width: 22 },
    { header: "Before SST", key: "amount", width: 18 }, { header: "SST", key: "sst", width: 14 }, { header: "Actual Cost", key: "cost", width: 18 }, { header: "Gross Profit", key: "profit", width: 18 },
    { header: "Collected Profit", key: "collected", width: 20 }, { header: "Outstanding Profit", key: "outstanding", width: 22 }, { header: "Status", key: "status", width: 18 },
  ];
  rows.forEach((r) => r.details.forEach((d) => detail.addRow({ name: r.partyName, month: d.month, property: d.property, unit: d.unit, category: d.category, description: d.description, charge: d.chargeNumber, amount: Number(d.chargedBeforeSst), sst: Number(d.sst), cost: d.actualCost == null ? "Missing Cost" : Number(d.actualCost), profit: d.grossProfit == null ? "Pending" : Number(d.grossProfit), collected: d.collectedProfit == null ? "Pending" : Number(d.collectedProfit), outstanding: d.outstandingProfit == null ? "Pending" : Number(d.outstandingProfit), status: d.status })));
  [summary, detail].forEach((sheet) => { sheet.views = [{ state: "frozen", ySplit: 1 }]; sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sheet.columnCount } }; const h = sheet.getRow(1); h.height = 28; h.font = { bold: true, color: { argb: "FFF3D493" } }; h.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF082F55" } }; h.alignment = { vertical: "middle", horizontal: "left" }; });
  [3,4,5,6,7].forEach((c) => summary.getColumn(c).numFmt = '"RM "#,##0.00;[Red]-"RM "#,##0.00');
  [8,9,10,11,12,13].forEach((c) => detail.getColumn(c).numFmt = '"RM "#,##0.00;[Red]-"RM "#,##0.00');
  saveBlob(new Blob([await wb.xlsx.writeBuffer()], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), `KAEN ${view.toUpperCase()} PROFITABILITY ${month || "LIFETIME"}.xlsx`);
}

export default function ProfitabilityPage() {
  const [view, setView] = useState<"owner" | "tenant">("owner"); const [month, setMonth] = useState(currentMonth); const [q, setQ] = useState(""); const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const query = useQuery({ queryKey: ["profitability", view, month, q], queryFn: () => getProfitability(view, month, q) });
  const rows = query.data?.rows ?? []; const totals = query.data?.totals;
  const summary = useMemo(() => [
    ["Charges before SST", totals?.chargesBeforeSst ?? 0], ["Actual cost", totals?.actualCost ?? 0], ["Gross profit", totals?.grossProfit ?? 0], ["Collected profit", totals?.collectedProfit ?? 0], ["Outstanding profit", totals?.outstandingProfit ?? 0],
  ], [totals]);
  return <div className="space-y-3">
    <PageHeader title="Owner & Tenant Profitability" description="See exactly how much each owner and tenant contributes to KAEN, based on real charges, collections and actual costs." icon={TrendingUp} actions={<Button variant="outline" disabled={!rows.length} onClick={() => void exportExcel(view, month, rows)}><Download className="mr-2 h-4 w-4" />Export Excel</Button>} />
    <Surface className="p-3"><div className="flex flex-wrap items-end gap-3">
      <div><div className="mb-1 text-xs font-bold uppercase text-muted-foreground">View</div><div className="flex gap-1">{(["owner", "tenant"] as const).map((v) => <Button key={v} variant={view === v ? "default" : "outline"} onClick={() => { setView(v); setExpanded(new Set()); }} className="capitalize">{v}s</Button>)}</div></div>
      <label className="text-sm font-semibold">Period<input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="ml-2 h-10 rounded-lg border border-[var(--input-border)] bg-white px-3" /></label>
      <Button variant="outline" onClick={() => setMonth("")}>Lifetime</Button>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${view} name`} className="h-10 min-w-64 rounded-lg border border-[var(--input-border)] bg-white px-3" />
    </div></Surface>
    <div className="grid grid-cols-2 gap-2 md:grid-cols-5">{summary.map(([label, value], i) => <Surface key={String(label)} className={`p-3 ${i === 2 ? "border-[var(--gold)] bg-[var(--gold-soft)]" : ""}`}><div className="text-xs font-semibold text-muted-foreground">{label}</div><div className={`mt-1 text-xl font-extrabold ${tone(value)}`}>{rm(value)}</div></Surface>)}</div>
    {!!totals?.missingCostCount && <div className="flex items-center gap-2 rounded-lg border border-orange-400 bg-orange-50 px-4 py-2 font-semibold text-orange-900"><AlertTriangle className="h-5 w-5" />{totals.missingCostCount} item(s) need actual cost. They are excluded from profit until cost is completed.</div>}
    <Surface className="overflow-hidden p-0"><div className="overflow-x-auto"><table className="w-full table-fixed border-collapse text-[15px] text-[var(--navy-text)]">
      <colgroup><col className="w-[24%]"/><col className="w-[10%]"/><col className="w-[13%]"/><col className="w-[12%]"/><col className="w-[13%]"/><col className="w-[14%]"/><col className="w-[14%]"/></colgroup>
      <thead className="bg-[var(--table-header)]"><tr>{[view === "owner" ? "Owner" : "Tenant", "Items", "Charges Before SST", "Actual Cost", "Gross Profit", "Collected Profit", "Outstanding Profit"].map((h) => <th key={h} className="h-14 border border-[var(--border)] px-3 text-left text-[16px] font-extrabold">{h}</th>)}</tr></thead>
      <tbody>{rows.map((row) => { const open = expanded.has(row.partyId); return <Fragment key={row.partyId}><tr className="bg-white hover:bg-[var(--table-header)]/50">
        <td className="border border-[var(--border)] p-3"><button className="flex w-full items-start gap-2 text-left" onClick={() => setExpanded((old) => { const next = new Set(old); if (next.has(row.partyId)) next.delete(row.partyId); else next.add(row.partyId); return next; })}>{open ? <ChevronDown className="mt-1 h-4 w-4 shrink-0"/> : <ChevronRight className="mt-1 h-4 w-4 shrink-0"/>}<span><b className="text-[17px]">{row.partyName}</b><span className="mt-1 block text-sm text-muted-foreground">{row.units.join(" · ") || "No unit"}</span>{row.missingCostCount > 0 && <span className="mt-1 block font-bold text-orange-700">{row.missingCostCount} Missing Cost</span>}</span></button></td>
        <td className="border border-[var(--border)] p-3">{row.itemCount}</td><td className="border border-[var(--border)] p-3 font-bold">{rm(row.chargesBeforeSst)}</td><td className="border border-[var(--border)] p-3 font-bold">{rm(row.actualCost)}</td><td className={`border border-[var(--border)] p-3 font-extrabold ${tone(row.grossProfit)}`}>{rm(row.grossProfit)}</td><td className="border border-[var(--border)] p-3 font-bold">{rm(row.collectedProfit)}</td><td className="border border-[var(--border)] p-3 font-bold">{rm(row.outstandingProfit)}</td>
      </tr>{open && <tr><td colSpan={7} className="border border-[var(--border)] bg-[var(--page-bg)] p-3"><DetailTable row={row}/></td></tr>}</Fragment>; })}</tbody>
      <tfoot><tr className="bg-[var(--navy)] text-[var(--gold-light)]"><td className="p-3 text-lg font-extrabold">TOTAL</td><td className="p-3">{rows.reduce((n,r) => n+r.itemCount,0)}</td>{[totals?.chargesBeforeSst, totals?.actualCost, totals?.grossProfit, totals?.collectedProfit, totals?.outstandingProfit].map((v,i) => <td key={i} className="p-3 font-extrabold">{rm(v ?? 0)}</td>)}</tr></tfoot>
    </table></div>{!query.isLoading && !rows.length && <div className="p-12 text-center text-muted-foreground">No profit-bearing charges found for this period.</div>}</Surface>
  </div>;
}

function DetailTable({ row }: { row: ProfitRow }) { return <div className="overflow-x-auto rounded-lg border border-[var(--border)] bg-white"><table className="w-full border-collapse text-sm"><thead className="bg-[var(--table-header)]"><tr>{["Month","Property / Unit","Category & details","Charge","Before SST","SST","Actual Cost","Gross Profit","Collected","Outstanding","Status"].map((h)=><th key={h} className="border border-[var(--border)] p-2 text-left font-bold">{h}</th>)}</tr></thead><tbody>{row.details.map((d)=><tr key={d.id}><td className="border border-[var(--border)] p-2">{d.month}</td><td className="border border-[var(--border)] p-2"><b>{d.property} {d.unit}</b>{d.tenancyCode && <div className="text-muted-foreground">{d.tenancyCode}</div>}</td><td className="border border-[var(--border)] p-2"><b>{d.category}</b><div>{d.description}</div></td><td className="border border-[var(--border)] p-2">{d.chargeNumber}</td><td className="border border-[var(--border)] p-2">{rm(d.chargedBeforeSst)}</td><td className="border border-[var(--border)] p-2">{rm(d.sst)}</td><td className={`border border-[var(--border)] p-2 font-bold ${d.missingCost ? "bg-orange-100 text-orange-800" : ""}`}>{rm(d.actualCost)}</td><td className={`border border-[var(--border)] p-2 font-bold ${tone(d.grossProfit ?? 0)}`}>{rm(d.grossProfit)}</td><td className="border border-[var(--border)] p-2">{rm(d.collectedProfit)}</td><td className="border border-[var(--border)] p-2">{rm(d.outstandingProfit)}</td><td className="border border-[var(--border)] p-2">{d.status}</td></tr>)}</tbody></table></div>; }
