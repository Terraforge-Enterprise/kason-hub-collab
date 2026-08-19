import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";
import { PageHeader } from "@/components/ui";
import { formatMoney } from "@/components/format";

type AgentPerformance = {
  id: string;
  agentName: string;
  totalEarned: number;
  pendingAmount: number;
  approvedAmount: number;
  paidAmount: number;
  claimCount: number;
  currency: string;
};

export default function CommissionPerformancePage() {
  const performance = useQuery({
    queryKey: ["commissions", "performance"],
    queryFn: () => apiFetch<{ data: AgentPerformance[] }>("/commissions/performance"),
  });

  if (performance.isLoading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-28 rounded-xl bg-[var(--card-bg)] border border-[var(--card-border)]" />
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div
              key={i}
              className="h-48 rounded-xl bg-[var(--card-bg)] border border-[var(--card-border)]"
            />
          ))}
        </div>
      </div>
    );
  }

  if (performance.isError) {
    return (
      <p className="p-6 text-sm text-rose-600">
        Failed to load performance data. Please refresh.
      </p>
    );
  }

  const agents = performance.data!.data;
  const totalPaid = agents.reduce((sum, a) => sum + a.paidAmount, 0);
  const totalPending = agents.reduce((sum, a) => sum + a.pendingAmount, 0);
  const totalApproved = agents.reduce((sum, a) => sum + a.approvedAmount, 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Agent performance"
        description="Commission earnings breakdown per agent across all claim statuses."
        metrics={[
          { label: "Agents", value: String(agents.length), hint: "Active commission earners" },
          { label: "Total Paid", value: formatMoney(totalPaid), hint: "Commission disbursed" },
          { label: "Pending Review", value: formatMoney(totalPending), hint: "Awaiting approval" },
          { label: "Approved", value: formatMoney(totalApproved), hint: "Pending payment" },
        ]}
      />

      {agents.length === 0 ? (
        <div className="rounded-xl border border-[var(--card-border)] bg-[var(--card-bg)] px-6 py-12 text-center">
          <p className="text-sm text-[var(--text-muted)]">No agent performance data available yet.</p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {agents.map((agent) => (
            <div
              key={agent.id}
              className="rounded-xl border border-[var(--card-border)] bg-[var(--card-bg)] shadow-sm"
            >
              {/* Card header */}
              <div className="border-b border-[var(--border)] px-5 py-4">
                <h3 className="text-base font-semibold text-[var(--text-primary)]">{agent.agentName}</h3>
                <p className="mt-0.5 text-xs text-[var(--text-muted)]">
                  {agent.claimCount} claim{agent.claimCount !== 1 ? "s" : ""}
                </p>
              </div>

              {/* Stats grid */}
              <div className="grid grid-cols-2 gap-0 divide-x divide-y divide-[var(--border)]">
                <div className="px-4 py-3">
                  <p className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                    Total Earned
                  </p>
                  <p className="mt-1 text-lg font-bold text-[var(--text-primary)]">
                    {formatMoney(agent.totalEarned, agent.currency)}
                  </p>
                </div>
                <div className="px-4 py-3">
                  <p className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                    Paid
                  </p>
                  <p className="mt-1 text-lg font-bold text-emerald-600 dark:text-emerald-400">
                    {formatMoney(agent.paidAmount, agent.currency)}
                  </p>
                </div>
                <div className="px-4 py-3">
                  <p className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                    Pending
                  </p>
                  <p className="mt-1 text-base font-semibold text-amber-600 dark:text-amber-400">
                    {formatMoney(agent.pendingAmount, agent.currency)}
                  </p>
                </div>
                <div className="px-4 py-3">
                  <p className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                    Approved
                  </p>
                  <p className="mt-1 text-base font-semibold text-sky-600 dark:text-sky-400">
                    {formatMoney(agent.approvedAmount, agent.currency)}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
