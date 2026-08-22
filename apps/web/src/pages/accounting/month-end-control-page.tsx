import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, CalendarCheck2, CheckCircle2, ChevronDown, ChevronUp, Clock3, RefreshCw } from "lucide-react";
import { Link } from "react-router-dom";
import { getActionCentre, type ActionCategory, type ActionCentreItem } from "@/api/action-centre";

type Gate = {
  category: ActionCategory;
  title: string;
  description: string;
  href: string;
  action: string;
};

const gates: Gate[] = [
  { category: "billing", title: "1. Billing complete", description: "Saved charges, rent, deposits and management fees must be billed correctly.", href: "/billing/tenant-owner-billing", action: "Open billing" },
  { category: "collections", title: "2. Collections reviewed", description: "Tenant receipts, partial payments and outstanding balances must be identified.", href: "/billing/tenant-owner-billing", action: "Review collections" },
  { category: "costs", title: "3. Costs completed", description: "Actual costs, claims and supplier payments must be recorded and allocated.", href: "/accounting/employee-expense-claims", action: "Review costs" },
  { category: "bank", title: "4. Bank reconciled", description: "Imported transactions must be matched, classified or deliberately marked for review.", href: "/accounting/bank-reconciliation", action: "Reconcile bank" },
  { category: "payout", title: "5. Owner payouts approved", description: "Every report must pass safety checks, First Check and final Approval.", href: "/billing/tenant-owner-billing", action: "Review payouts" },
];

function monthLabel(month: string | undefined): string {
  if (!month) return "Current month";
  // The dashboard API returns a full ISO timestamp (for example
  // "2026-08-01T00:00:00.000Z"), while older/mock responses may return
  // "YYYY-MM". Normalise both shapes before formatting. Appending another
  // "-01" to an ISO timestamp creates an invalid date and used to crash this
  // entire route inside the chunk error boundary.
  const monthKey = month.slice(0, 7);
  const date = new Date(`${monthKey}-01T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return "Current month";
  return new Intl.DateTimeFormat("en-MY", { month: "long", year: "numeric", timeZone: "UTC" }).format(date);
}

function blockingItems(items: ActionCentreItem[], category: ActionCategory) {
  return items.filter((item) => item.category === category && item.severity !== "review");
}

const moneyFormatter = new Intl.NumberFormat("en-MY", {
  style: "currency",
  currency: "MYR",
  currencyDisplay: "narrowSymbol",
  minimumFractionDigits: 2,
});

function formatAmount(amount: number | null) {
  return amount == null ? "—" : moneyFormatter.format(amount).replace("MYR", "RM");
}

export default function MonthEndControlPage() {
  const [expandedBlocker, setExpandedBlocker] = useState<string | null>(null);
  const query = useQuery({ queryKey: ["action-centre", "month-end"], queryFn: getActionCentre, refetchInterval: 60_000 });
  const items = query.data?.items ?? [];
  const blockers = items.filter((item) => item.severity !== "review");
  const isReady = !query.isLoading && !query.isError && blockers.length === 0;

  const revealCategory = (category: ActionCategory) => {
    const firstItem = blockingItems(items, category)[0];
    if (!firstItem) return;
    setExpandedBlocker(firstItem.id);
    window.requestAnimationFrame(() => {
      document.getElementById(`month-end-blocker-${firstItem.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  };

  return (
    <main className="mx-auto w-full max-w-[1500px] space-y-5 p-4 md:p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="mb-1 flex items-center gap-2 text-[#C9A35C]">
            <CalendarCheck2 className="h-6 w-6" />
            <span className="text-sm font-extrabold uppercase tracking-[0.14em]">Accounting control</span>
          </div>
          <h1 className="text-3xl font-extrabold text-[#082B4F]">Month-End Control</h1>
          <p className="mt-1 text-base text-[#657069]">{monthLabel(query.data?.periodMonth)} · Complete every control before the automatic month-end freeze.</p>
        </div>
        <button type="button" onClick={() => void query.refetch()} className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-[#C9A35C] bg-white px-4 font-bold text-[#082B4F] shadow-sm">
          <RefreshCw className={`h-4 w-4 ${query.isFetching ? "animate-spin" : ""}`} /> Refresh checks
        </button>
      </header>

      {query.isError && (
        <section role="alert" className="rounded-2xl border-2 border-red-500 bg-red-50 p-5 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-8 w-8 shrink-0 text-red-600" />
              <div>
                <h2 className="text-xl font-black text-[#082B4F]">Month-end checks could not be loaded</h2>
                <p className="mt-1 text-base text-[#657069]">
                  No control is being shown as cleared. Retry the checks before approving any owner payout or treating the month as closed.
                </p>
              </div>
            </div>
            <button type="button" onClick={() => void query.refetch()} className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-[#082F55] px-5 font-bold text-white hover:bg-[#061F38]">
              <RefreshCw className={`h-4 w-4 ${query.isFetching ? "animate-spin" : ""}`} /> Retry
            </button>
          </div>
        </section>
      )}

      <section className={`rounded-2xl border-2 p-5 shadow-sm ${isReady ? "border-emerald-500 bg-emerald-50" : "border-red-500 bg-red-50"}`}>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            {isReady ? <CheckCircle2 className="h-10 w-10 text-emerald-600" /> : <AlertTriangle className="h-10 w-10 text-red-600" />}
            <div>
              <h2 className="text-2xl font-black text-[#082B4F]">{isReady ? "Ready for automatic close" : "Month-end is blocked"}</h2>
              <p className="text-base text-[#657069]">
                {query.isLoading ? "Checking all accounting controls…" : query.isError ? "Checks could not be loaded. Treat the month as blocked." : isReady ? "No critical or action-required items remain. Review items may still be monitored." : `${blockers.reduce((sum, item) => sum + item.count, 0)} action(s) must be resolved first.`}
              </p>
            </div>
          </div>
          <div className="rounded-xl bg-white px-5 py-3 text-center shadow-sm">
            <div className="text-xs font-extrabold uppercase tracking-wider text-[#657069]">Open blockers</div>
            <div className="text-3xl font-black text-[#082B4F]">{blockers.reduce((sum, item) => sum + item.count, 0)}</div>
          </div>
        </div>
      </section>

      <section className="grid gap-3 lg:grid-cols-5">
        {gates.map((gate) => {
          const gateItems = blockingItems(items, gate.category);
          const count = gateItems.reduce((sum, item) => sum + item.count, 0);
          const clear = !query.isLoading && !query.isError && count === 0;
          return (
            <article key={gate.category} className={`flex min-h-64 flex-col rounded-xl border p-4 shadow-sm ${clear ? "border-emerald-400 bg-emerald-50" : "border-orange-400 bg-white"}`}>
              <div className="flex items-start justify-between gap-2">
                <h2 className="text-lg font-extrabold leading-tight text-[#082B4F]">{gate.title}</h2>
                {clear ? <CheckCircle2 className="h-6 w-6 shrink-0 text-emerald-600" /> : <Clock3 className="h-6 w-6 shrink-0 text-orange-600" />}
              </div>
              <p className="mt-3 flex-1 text-sm leading-relaxed text-[#657069]">{gate.description}</p>
              <div className={`mb-3 rounded-lg px-3 py-2 text-center font-extrabold ${clear ? "bg-[#00FF00] text-[#082B4F]" : "bg-orange-100 text-orange-900"}`}>
                {query.isLoading ? "Checking…" : query.isError ? "Unavailable" : clear ? "Clear" : `${count} require action`}
              </div>
              {clear ? (
                <Link to={gate.href} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-[#082F55] px-3 font-bold text-white hover:bg-[#061F38]">
                  {gate.action} <ArrowRight className="h-4 w-4" />
                </Link>
              ) : (
                <button type="button" onClick={() => revealCategory(gate.category)} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-[#082F55] px-3 font-bold text-white hover:bg-[#061F38]">
                  View {count} item{count === 1 ? "" : "s"} <ChevronDown className="h-4 w-4" />
                </button>
              )}
            </article>
          );
        })}
      </section>

      {blockers.length > 0 && (
        <section className="overflow-hidden rounded-xl border border-[#9DAFC1] bg-white shadow-sm">
          <div className="bg-[#DFE9F3] px-4 py-3 text-lg font-extrabold text-[#082B4F]">Blocking details</div>
          <div className="divide-y divide-[#9DAFC1]">
            {blockers.map((item) => {
              const isExpanded = expandedBlocker === item.id;
              return (
                <article key={item.id} id={`month-end-blocker-${item.id}`} className="scroll-mt-5">
                  <div className="grid gap-3 px-4 py-3 md:grid-cols-[150px_minmax(0,1fr)_100px_190px] md:items-center">
                    <span className={`w-fit rounded-full px-3 py-1 text-xs font-extrabold uppercase ${item.severity === "critical" ? "bg-red-100 text-red-800" : "bg-orange-100 text-orange-900"}`}>{item.category}</span>
                    <div>
                      <div className="font-extrabold text-[#082B4F]">{item.title}</div>
                      <div className="text-sm text-[#657069]">{item.description}</div>
                    </div>
                    <div className="text-center text-xl font-black text-[#082B4F]">{item.count}</div>
                    <button
                      type="button"
                      onClick={() => setExpandedBlocker(isExpanded ? null : item.id)}
                      className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-[#C9A35C] bg-white px-3 font-bold text-[#082B4F] hover:bg-[#FFF8E8]"
                    >
                      {isExpanded ? "Hide exact items" : `View exact item${item.count === 1 ? "" : "s"}`}
                      {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                    </button>
                  </div>

                  {isExpanded && (
                    <div className="border-t border-[#9DAFC1] bg-[#F3F6F9] p-4">
                      {item.breakdown.length > 0 ? (
                        <div className="overflow-hidden rounded-xl border border-[#9DAFC1] bg-white">
                          <div className="grid grid-cols-[minmax(0,1fr)_140px] bg-[#DFE9F3] px-4 py-2 text-sm font-extrabold uppercase tracking-wide text-[#082B4F]">
                            <span>Exact unit / tenant / transaction</span>
                            <span className="text-right">Amount</span>
                          </div>
                          <div className="divide-y divide-[#C8D4DF]">
                            {item.breakdown.map((record) => (
                              <div key={record.id} className="grid grid-cols-[minmax(0,1fr)_140px] gap-4 px-4 py-3">
                                <div className="min-w-0">
                                  <div className="font-extrabold text-[#082B4F]">{record.label}</div>
                                  {record.detail && <div className="mt-0.5 break-words text-sm text-[#657069]">{record.detail}</div>}
                                </div>
                                <div className="self-center text-right text-base font-black text-[#082B4F]">{formatAmount(record.amount)}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : (
                        <div className="rounded-xl border border-orange-300 bg-orange-50 px-4 py-3 font-semibold text-orange-900">
                          This check currently has no record-level breakdown. Open the source page to review the affected records.
                        </div>
                      )}
                      <div className="mt-3 flex justify-end">
                        <Link to={item.href} className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-[#082F55] px-5 font-bold text-white hover:bg-[#061F38]">
                          {item.cta} <ArrowRight className="h-4 w-4" />
                        </Link>
                      </div>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      )}
    </main>
  );
}
