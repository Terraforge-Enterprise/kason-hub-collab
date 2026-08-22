import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { AlertTriangle, ArrowRight, CheckCircle2, ChevronDown, ChevronUp, Clock3, ListTodo, RefreshCw } from "lucide-react";
import { getActionCentre, type ActionCategory, type ActionSeverity } from "@/api/action-centre";

const categoryLabel: Record<ActionCategory, string> = { billing: "Billing", collections: "Collections", costs: "Costs", bank: "Bank", payout: "Owner payout" };
const severityStyle: Record<ActionSeverity, string> = {
  critical: "border-red-300 bg-red-50 text-red-900",
  warning: "border-orange-300 bg-orange-50 text-orange-900",
  review: "border-amber-300 bg-amber-50 text-amber-900",
};
const money = new Intl.NumberFormat("en-MY", { style: "currency", currency: "MYR", currencyDisplay: "narrowSymbol" });

export default function ActionCentrePage() {
  const [filter, setFilter] = useState<"all" | ActionCategory>("all");
  const [expanded, setExpanded] = useState<string | null>(null);
  const query = useQuery({ queryKey: ["action-centre"], queryFn: getActionCentre, refetchInterval: 60_000 });
  const items = useMemo(() => (query.data?.items ?? []).filter((item) => filter === "all" || item.category === filter), [query.data, filter]);

  return (
    <div className="mx-auto w-full max-w-[1500px] space-y-5 p-4 md:p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="mb-1 flex items-center gap-2 text-[#C9A35C]"><ListTodo className="h-6 w-6" /><span className="text-sm font-bold uppercase tracking-[0.14em]">Daily control</span></div>
          <h1 className="text-3xl font-extrabold text-[#082B4F]">Action Centre</h1>
          <p className="mt-1 text-base text-[#657069]">Live system issues that still require action. Resolve the source issue and the reminder clears automatically.</p>
        </div>
        <button onClick={() => query.refetch()} className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-[#C9A35C] bg-white px-4 font-semibold text-[#082B4F] shadow-sm hover:bg-[#F3F6F9]">
          <RefreshCw className={`h-4 w-4 ${query.isFetching ? "animate-spin" : ""}`} /> Refresh
        </button>
      </header>

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric label="Total actions" value={query.data?.summary.total ?? 0} icon={<ListTodo />} tone="navy" />
        <Metric label="Critical" value={query.data?.summary.critical ?? 0} icon={<AlertTriangle />} tone="red" />
        <Metric label="Needs action" value={query.data?.summary.warning ?? 0} icon={<Clock3 />} tone="orange" />
        <Metric label="Review" value={query.data?.summary.review ?? 0} icon={<CheckCircle2 />} tone="gold" />
      </section>

      <nav className="flex gap-2 overflow-x-auto rounded-xl border border-[#9DAFC1] bg-white p-2 shadow-sm">
        {(["all", "billing", "collections", "costs", "bank", "payout"] as const).map((key) => (
          <button key={key} onClick={() => setFilter(key)} className={`whitespace-nowrap rounded-lg px-4 py-2 text-sm font-bold ${filter === key ? "bg-[#082F55] text-[#F3D493]" : "text-[#082B4F] hover:bg-[#DFE9F3]"}`}>
            {key === "all" ? "All" : categoryLabel[key]}
          </button>
        ))}
      </nav>

      {query.isLoading ? <div className="rounded-xl border bg-white p-10 text-center text-[#657069]">Loading live actions…</div> : query.isError ? (
        <div className="rounded-xl border border-red-300 bg-red-50 p-6 text-red-800">Action Centre could not load. Please refresh and try again.</div>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-emerald-300 bg-emerald-50 p-10 text-center"><CheckCircle2 className="mx-auto mb-3 h-10 w-10 text-emerald-600" /><div className="text-xl font-bold text-[#082B4F]">No outstanding actions</div><p className="text-[#657069]">Everything in this section is currently clear.</p></div>
      ) : (
        <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {items.map((item) => (
            <article key={item.id} className={`flex min-h-52 flex-col rounded-xl border border-[#9DAFC1] bg-white p-5 shadow-sm ${expanded === item.id ? "md:col-span-2 xl:col-span-3" : ""}`}>
              <div className="flex items-start justify-between gap-3">
                <div><span className="text-xs font-extrabold uppercase tracking-wider text-[#657069]">{categoryLabel[item.category]}</span><h2 className="mt-1 text-xl font-extrabold leading-tight text-[#082B4F]">{item.title}</h2></div>
                <span className={`rounded-full border px-3 py-1 text-sm font-extrabold ${severityStyle[item.severity]}`}>{item.count}</span>
              </div>
              <p className="mt-3 flex-1 text-base leading-relaxed text-[#657069]">{item.description}</p>
              {item.amount !== null && <div className="mb-3 text-2xl font-black text-[#082B4F]">{money.format(item.amount).replace("MYR", "RM")}</div>}
              {item.breakdown.length > 0 && (
                <button
                  type="button"
                  onClick={() => setExpanded(expanded === item.id ? null : item.id)}
                  className="mb-2 inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-[#C9A35C] bg-white px-4 font-bold text-[#082B4F] hover:bg-[#F3F6F9]"
                >
                  {expanded === item.id ? "Hide breakdown" : `View ${item.breakdown.length} item breakdown`}
                  {expanded === item.id ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                </button>
              )}
              {expanded === item.id && item.breakdown.length > 0 && (
                <div className="mb-3 max-h-[420px] overflow-y-auto rounded-lg border border-[#9DAFC1]">
                  <div className="sticky top-0 grid grid-cols-[minmax(0,1fr)_auto] gap-3 bg-[#DFE9F3] px-4 py-3 text-sm font-extrabold uppercase text-[#082B4F]">
                    <span>Unit / item</span><span>Amount</span>
                  </div>
                  {item.breakdown.map((row) => (
                    <div key={row.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-t border-[#9DAFC1] px-4 py-3">
                      <div className="min-w-0">
                        <div className="break-words text-base font-extrabold text-[#082B4F]">{row.label}</div>
                        <div className="break-words text-sm text-[#657069]">{row.detail}</div>
                      </div>
                      <div className="whitespace-nowrap text-base font-extrabold tabular-nums text-[#082B4F]">
                        {row.amount === null ? "—" : money.format(row.amount).replace("MYR", "RM")}
                      </div>
                    </div>
                  ))}
                  {item.amount !== null && (
                    <div className="sticky bottom-0 grid grid-cols-[minmax(0,1fr)_auto] gap-3 border-t-2 border-[#C9A35C] bg-[#082F55] px-4 py-3 font-extrabold text-[#F3D493]">
                      <span>Total</span><span className="whitespace-nowrap tabular-nums">{money.format(item.amount).replace("MYR", "RM")}</span>
                    </div>
                  )}
                </div>
              )}
              <Link to={item.href} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-[#082F55] px-4 font-bold text-white hover:bg-[#061F38]">{item.cta}<ArrowRight className="h-4 w-4" /></Link>
            </article>
          ))}
        </section>
      )}
    </div>
  );
}

function Metric({ label, value, icon, tone }: { label: string; value: number; icon: React.ReactNode; tone: "navy" | "red" | "orange" | "gold" }) {
  const colors = { navy: "bg-[#082F55] text-white", red: "bg-red-600 text-white", orange: "bg-orange-500 text-white", gold: "bg-[#C9A35C] text-[#061F38]" };
  return <div className={`rounded-xl p-4 shadow-sm ${colors[tone]}`}><div className="flex items-center justify-between"><span className="text-sm font-bold opacity-90">{label}</span><span className="[&>svg]:h-5 [&>svg]:w-5">{icon}</span></div><div className="mt-2 text-3xl font-black">{value}</div></div>;
}
